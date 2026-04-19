import { callOpenRouterChat } from
  '@/background/openrouter/openrouter-client';
import { parseLlmPromoResponse } from
  '@/background/openrouter/parse-llm-promo-response';
import { PROMO_DETECTION_SYSTEM_PROMPT } from
  '@/background/openrouter/promo-detection-system-prompt';
import { OpenRouterStorage } from
  '@/background/storage/openrouter-storage';
import {
  PROVIDER_AVAILABILITY,
  PROVIDER_ID,
  type AnalyzeTranscriptParams,
  type AnalyzeTranscriptResult,
  type LlmProviderAdapter,
  type ProviderAvailability,
} from '@/background/providers/llm-provider-adapter';

/**
 * Wraps the existing OpenRouter call path behind the provider adapter
 * interface. No behavioral change — delegates to `callOpenRouterChat`
 * and `parseLlmPromoResponse`.
 */
export class OpenRouterAdapter implements LlmProviderAdapter {
  readonly id = PROVIDER_ID.OpenRouter;

  readonly displayName = 'OpenRouter';

  /**
   * Returns `'available'` when a non-empty API key and model are
   * configured in `OpenRouterStorage`, `'unavailable'` otherwise.
   *
   * @returns Current provider availability.
   */
  async availability(): Promise<ProviderAvailability> {
    const config = await OpenRouterStorage.load();
    if (config.apiKey.length > 0 && config.model.length > 0) {
      return PROVIDER_AVAILABILITY.Available;
    }
    return PROVIDER_AVAILABILITY.Unavailable;
  }

  /**
   * Sends the transcript to OpenRouter and parses the promo-detection
   * response.
   *
   * @param params - Transcript and context.
   * @returns Detection result or error.
   */
  async analyzeTranscript(
    params: AnalyzeTranscriptParams,
  ): Promise<AnalyzeTranscriptResult> {
    const config = await OpenRouterStorage.load();
    if (config.apiKey.length === 0 || config.model.length === 0) {
      return { ok: false, error: 'OpenRouter is not configured' };
    }

    const llm = await callOpenRouterChat({
      apiKey: config.apiKey,
      model: config.model,
      signal: params.signal,
      messages: [
        { role: 'system', content: PROMO_DETECTION_SYSTEM_PROMPT },
        { role: 'user', content: params.transcript },
      ],
    });

    if (!llm.ok) {
      return { ok: false, error: llm.error };
    }

    const parsed = parseLlmPromoResponse(llm.rawContent, params.durationSec);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }

    const meta = { id: this.id, model: config.model };

    if (!parsed.hasPromo) {
      return { ok: true, hasPromo: false, providerMeta: meta };
    }

    return {
      ok: true,
      hasPromo: true,
      blocks: parsed.blocks,
      providerMeta: meta,
    };
  }
}
