import { parseLlmPromoResponse } from '@/background/openrouter/parse-llm-promo-response';
import { PROMO_DETECTION_SYSTEM_PROMPT } from '@/background/openrouter/promo-detection-system-prompt';
import {
    LLM_ROLE,
    PROVIDER_AVAILABILITY,
    PROVIDER_ID,
    type AnalyzeTranscriptParams,
    type AnalyzeTranscriptResult,
    type LlmProviderAdapter,
    type ProviderAvailability,
} from '@/background/providers/llm-provider-adapter';
import {
    LANGUAGE_MODEL_GLOBAL,
    LANGUAGE_MODEL_METHOD,
} from '@/shared/chrome-prompt-api';

/**
 * Error message returned when Chrome's LanguageModel API is absent or the
 * session factory cannot be resolved from global scope.
 */
const UNAVAILABLE_ERROR = 'Chrome Built-in AI is not available';

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
 * Token budget reserved for the model's JSON response.
 */
const RESPONSE_TOKEN_RESERVE = 512;

/**
 * Probe length for `measureContextUsage` ratio (chars).
 */
const BUDGET_PROBE_CHARS = 500;

/**
 * Fallback chars-per-token when calibration fails (non-Latin scripts).
 */
const CONSERVATIVE_CHARS_PER_TOKEN = 2;

/**
 * Safety factor on calibrated budget.
 */
const BUDGET_SAFETY = 0.9;

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
    /**
     * Provider id literal for prefs and messaging.
     */
    readonly id = PROVIDER_ID.ChromePromptApi;

    /**
     * Human label for the options provider list.
     */
    readonly displayName = 'Chrome Built-in';

    /**
     * Maps Chrome's `LanguageModel.availability()` to `ProviderAvailability`.
     * Returns `'unavailable'` when `LanguageModel` is not in global scope so
     * the options UI can gate accordingly.
     *
     * @returns Current availability state.
     */
    async availability(): Promise<ProviderAvailability> {
        const lm: unknown = Reflect.get(globalThis, LANGUAGE_MODEL_GLOBAL);
        if (!lm || (typeof lm !== 'object' && typeof lm !== 'function')) {
            return PROVIDER_AVAILABILITY.UNAVAILABLE;
        }

        const availFn: unknown = Reflect.get(
            lm,
            LANGUAGE_MODEL_METHOD.AVAILABILITY,
        );
        if (typeof availFn !== 'function') {
            return PROVIDER_AVAILABILITY.UNAVAILABLE;
        }

        const chromeSt: unknown = await (
            availFn as () => Promise<unknown>
        ).call(lm);
        switch (chromeSt) {
            case PROVIDER_AVAILABILITY.AVAILABLE:
                return PROVIDER_AVAILABILITY.AVAILABLE;
            case PROVIDER_AVAILABILITY.DOWNLOADABLE:
                return PROVIDER_AVAILABILITY.DOWNLOADABLE;
            case PROVIDER_AVAILABILITY.DOWNLOADING:
                return PROVIDER_AVAILABILITY.DOWNLOADING;
            default:
                return PROVIDER_AVAILABILITY.UNAVAILABLE;
        }
    }

    /**
     * Conservative planning budget for one user transcript (UTF-16 chars).
     * Uses `measureContextUsage` on a probe string — not model inference.
     *
     * @returns Estimated max chars, or 0 if the API is unavailable.
     */
    async maxTranscriptChars(): Promise<number> {
        const session = await this.createLanguageModelSession(undefined);
        if (!session.ok) {
            return 0;
        }
        const { session: s } = session;
        try {
            const sessionContextUsage: number =
                typeof s.contextUsage === 'number' ? s.contextUsage : 0;
            const transcriptBudget =
                s.contextWindow - sessionContextUsage - RESPONSE_TOKEN_RESERVE;
            if (transcriptBudget <= 0) {
                return 0;
            }
            const probe = 'a'.repeat(BUDGET_PROBE_CHARS);
            try {
                const used = await s.measureContextUsage(probe);
                const ratio = probe.length / Math.max(used, 1);
                return Math.floor(
                    Math.max(0, transcriptBudget * ratio * BUDGET_SAFETY),
                );
            } catch {
                return Math.floor(
                    transcriptBudget * CONSERVATIVE_CHARS_PER_TOKEN,
                );
            }
        } finally {
            s.destroy();
        }
    }

    /**
     * Creates a Chrome Built-in AI session with the promo system prompt.
     *
     * @param signal - Optional abort signal
     * @returns Session or error
     */
    private async createLanguageModelSession(
        signal: AbortSignal | undefined,
    ): Promise<
        { ok: true; session: LanguageModel } | { ok: false; error: string }
    > {
        const lm: unknown = Reflect.get(globalThis, LANGUAGE_MODEL_GLOBAL);
        if (!lm || (typeof lm !== 'object' && typeof lm !== 'function')) {
            return { ok: false, error: UNAVAILABLE_ERROR };
        }

        const createFn: unknown = Reflect.get(lm, LANGUAGE_MODEL_METHOD.CREATE);
        if (typeof createFn !== 'function') {
            return { ok: false, error: UNAVAILABLE_ERROR };
        }

        try {
            const session = await (
                createFn as (
                    opts: LanguageModelCreateOptions,
                ) => Promise<LanguageModel>
            ).call(lm, {
                signal,
                initialPrompts: [
                    {
                        role: LLM_ROLE.System,
                        content: PROMO_DETECTION_SYSTEM_PROMPT,
                    },
                ],
            });
            return { ok: true, session };
        } catch (e) {
            return {
                ok: false,
                error:
                    e instanceof Error
                        ? e.message
                        : 'Failed to create LanguageModel session',
            };
        }
    }

    /**
     * Sends the transcript to Gemini Nano via a one-shot session and
     * parses the structured promo-detection response. Does not truncate
     * the transcript; returns `tooLarge` when it does not fit.
     *
     * @param params - Transcript and context for the analysis.
     * @returns Detection result or error.
     */
    async analyzeTranscript(
        params: AnalyzeTranscriptParams,
    ): Promise<AnalyzeTranscriptResult> {
        const created = await this.createLanguageModelSession(params.signal);
        if (!created.ok) {
            return { ok: false, error: created.error };
        }
        const session = created.session;

        try {
            const sessionContextUsage: number =
                typeof session.contextUsage === 'number'
                    ? session.contextUsage
                    : 0;
            const transcriptBudget =
                session.contextWindow -
                sessionContextUsage -
                RESPONSE_TOKEN_RESERVE;

            const transcript = params.transcript;
            if (transcript.length === 0) {
                return {
                    ok: true,
                    hasPromo: false,
                    providerMeta: { id: this.id, model: 'gemini-nano' },
                    rawAssistant: '',
                };
            }

            try {
                const used = await session.measureContextUsage(transcript);
                if (used > transcriptBudget) {
                    return {
                        ok: false,
                        error: 'Transcript exceeds LanguageModel context budget',
                        tooLarge: true,
                    };
                }
            } catch {
                return {
                    ok: false,
                    error: 'measureContextUsage failed for transcript',
                    tooLarge: true,
                };
            }

            let rawContent: string;
            try {
                rawContent = await session.prompt(transcript, {
                    responseConstraint: PROMO_DETECTION_RESPONSE_SCHEMA,
                    signal: params.signal,
                });
            } catch (e) {
                return {
                    ok: false,
                    error: e instanceof Error ? e.message : 'Prompt failed',
                };
            }

            console.log(
                '[TopSkip] ChromePromptApiAdapter raw response:',
                rawContent,
            );

            const parsed = parseLlmPromoResponse(
                rawContent,
                params.durationSec,
            );
            if (!parsed.ok) {
                return {
                    ok: false,
                    error: parsed.error,
                    rawAssistant: rawContent,
                };
            }

            const meta = { id: this.id, model: 'gemini-nano' } as const;
            if (!parsed.hasPromo) {
                return {
                    ok: true,
                    hasPromo: false,
                    providerMeta: meta,
                    rawAssistant: rawContent,
                };
            }
            return {
                ok: true,
                hasPromo: true,
                blocks: parsed.blocks,
                providerMeta: meta,
                rawAssistant: rawContent,
            };
        } finally {
            session.destroy();
        }
    }
}
