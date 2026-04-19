import { parseLlmPromoResponse } from
  '@/background/openrouter/parse-llm-promo-response';
import { PROMO_DETECTION_SYSTEM_PROMPT } from
  '@/background/openrouter/promo-detection-system-prompt';
import {
  PROVIDER_AVAILABILITY,
  PROVIDER_ID,
  type AnalyzeTranscriptParams,
  type AnalyzeTranscriptResult,
  type LlmProviderAdapter,
  type ProviderAvailability,
} from '@/background/providers/llm-provider-adapter';

/**
 * JSON Schema matching `llmPromoDetectionSchema` (Valibot) — passed
 * as `responseConstraint` to constrain Gemini Nano's output format.
 */
const PROMO_DETECTION_RESPONSE_SCHEMA: Record<string, unknown> = {
  oneOf: [
    {
      type: 'object',
      required: ['hasPromo', 'promoBlocks'],
      properties: {
        hasPromo: { const: true },
        promoBlocks: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['startSec'],
            properties: {
              startSec: { type: 'number' },
              endSec: { type: 'number' },
              confidence: { enum: ['low', 'medium', 'high'] },
            },
          },
        },
      },
    },
    {
      type: 'object',
      required: ['hasPromo'],
      properties: {
        hasPromo: { const: false },
        confidence: { enum: ['low', 'medium', 'high'] },
      },
    },
  ],
};

/**
 * Heuristic: 1 token ≈ 4 characters.
 * Used to estimate the transcript's token cost before prompting.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Token budget reserved for the model's JSON response.
 * Prevents the output from crowding out the transcript input.
 */
const RESPONSE_TOKEN_RESERVE = 512;

/**
 * Maximum number of halving iterations when `measureContextUsage` reports
 * the transcript is still too large after the initial character-budget cut.
 * After 8 halvings a 32 000-char transcript shrinks below 130 chars.
 */
const MAX_FIT_ITERATIONS = 8;

/**
 * Wraps Chrome's built-in `LanguageModel` (Gemini Nano) behind the
 * `LlmProviderAdapter` interface. Performs on-device promo detection
 * without network access after the model is downloaded.
 *
 * The adapter reads `LanguageModel` from `globalThis` at call time so
 * it degrades gracefully in environments where the API is absent
 * (non-Chrome, older Chrome, test runners).
 */
export class ChromePromptApiAdapter implements LlmProviderAdapter {
  readonly id = PROVIDER_ID.ChromePromptApi;

  readonly displayName = 'Chrome Built-in';

  /**
   * Maps Chrome's `LanguageModel.availability()` to `ProviderAvailability`.
   * Returns `'unavailable'` when `LanguageModel` is not in global scope so
   * the options UI can gate accordingly.
   *
   * @returns Current availability state.
   */
  async availability(): Promise<ProviderAvailability> {
    const lm: unknown = Reflect.get(globalThis, 'LanguageModel');
    if (!lm || (typeof lm !== 'object' && typeof lm !== 'function')) {
      return PROVIDER_AVAILABILITY.Unavailable;
    }

    const availFn: unknown = Reflect.get(lm, 'availability');
    if (typeof availFn !== 'function') {
      return PROVIDER_AVAILABILITY.Unavailable;
    }

    const chromeSt: unknown = await (availFn as () => Promise<unknown>)
      .call(lm);
    switch (chromeSt) {
      case 'available':
        return PROVIDER_AVAILABILITY.Available;
      case 'downloadable':
        return PROVIDER_AVAILABILITY.Downloadable;
      case 'downloading':
        return PROVIDER_AVAILABILITY.Downloading;
      default:
        return PROVIDER_AVAILABILITY.Unavailable;
    }
  }

  /**
   * Sends the transcript to Gemini Nano via a one-shot session and
   * parses the structured promo-detection response.
   *
   * Steps:
   * 1. Guard against missing `LanguageModel` global.
   * 2. Create a session with the system prompt in `initialPrompts`.
   * 3. Truncate the transcript: rough char-budget pre-cut, then refine via
   *    `measureContextUsage` iterative halving (keeps tail of transcript).
   * 4. Prompt with `responseConstraint` for structured JSON output.
   * 5. Parse via `parseLlmPromoResponse` and return a typed result.
   * 6. Always destroy the session (in `finally`).
   *
   * @param params - Transcript and context for the analysis.
   * @returns Detection result or error.
   */
  async analyzeTranscript(
    params: AnalyzeTranscriptParams,
  ): Promise<AnalyzeTranscriptResult> {
    const lm: unknown = Reflect.get(globalThis, 'LanguageModel');
    if (!lm || (typeof lm !== 'object' && typeof lm !== 'function')) {
      return {
        ok: false,
        error: 'Chrome Built-in AI is not available',
      };
    }

    const createFn: unknown = Reflect.get(lm, 'create');
    if (typeof createFn !== 'function') {
      return {
        ok: false,
        error: 'Chrome Built-in AI is not available',
      };
    }

    let session: LanguageModel;
    try {
      session = await (createFn as (
        opts: LanguageModelCreateOptions,
      ) => Promise<LanguageModel>).call(lm, {
        signal: params.signal,
        initialPrompts: [
          { role: 'system', content: PROMO_DETECTION_SYSTEM_PROMPT },
        ],
      });
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error
          ? e.message
          : 'Failed to create LanguageModel session',
      };
    }

    try {
      /*
       * `contextUsage` reflects tokens already consumed by `initialPrompts`
       * (the system prompt). Use it to compute the true remaining budget for
       * the transcript. Fall back to 0 if the property is absent (older
       * Chrome versions); the rough char-based pre-cut still provides a
       * reasonable upper bound in that case.
       */
      const sessionContextUsage: number =
        typeof session.contextUsage === 'number' ? session.contextUsage : 0;
      const transcriptBudget =
        session.contextWindow - sessionContextUsage - RESPONSE_TOKEN_RESERVE;

      let transcript = params.transcript;

      /* Phase 1 — rough char-heuristic pre-cut.
       * Keeps the tail (most recent captions) as the promo is more likely
       * to appear late in the video.
       * CHARS_PER_TOKEN is calibrated for Latin text; non-Latin scripts
       * tokenise more densely, so phase 2 refines this estimate. */
      const maxChars = Math.max(0, transcriptBudget * CHARS_PER_TOKEN);
      if (transcript.length > maxChars) {
        transcript = transcript.slice(transcript.length - maxChars);
        console.warn(
          '[TopSkip] ChromePromptApiAdapter: transcript truncated',
          {
            originalChars: params.transcript.length,
            truncatedChars: transcript.length,
          },
        );
      }

      /* Phase 2 — precise fit via measureContextUsage.
       * Required for non-Latin scripts (Cyrillic, CJK, etc.) where 1 char
       * ≈ 1 token rather than 1 char ≈ ¼ token. */
      for (
        let i = 0;
        i < MAX_FIT_ITERATIONS && transcript.length > 0;
        i++
      ) {
        const used = await session.measureContextUsage(transcript);
        if (used <= transcriptBudget) break;
        /* Keep the tail — halve from the start. */
        transcript = transcript.slice(Math.ceil(transcript.length / 2));
      }

      const rawContent = await session.prompt(transcript, {
        responseConstraint: PROMO_DETECTION_RESPONSE_SCHEMA,
        signal: params.signal,
      });

      console.log(
        '[TopSkip] ChromePromptApiAdapter raw response:',
        rawContent,
      );

      const parsed = parseLlmPromoResponse(rawContent, params.durationSec);
      if (!parsed.ok) {
        return { ok: false, error: parsed.error };
      }

      const meta = { id: this.id, model: 'gemini-nano' } as const;
      if (!parsed.hasPromo) {
        return { ok: true, hasPromo: false, providerMeta: meta };
      }
      return {
        ok: true,
        hasPromo: true,
        blocks: parsed.blocks,
        providerMeta: meta,
      };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : 'Prompt failed',
      };
    } finally {
      session.destroy();
    }
  }
}
