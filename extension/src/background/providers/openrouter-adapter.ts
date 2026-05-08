import { callOpenRouterChat } from '@/background/openrouter/openrouter-client';
import { parseLlmPromoResponse } from '@/background/openrouter/parse-llm-promo-response';
import { PROMO_DETECTION_SYSTEM_PROMPT } from '@/background/openrouter/promo-detection-system-prompt';
import { OpenRouterStorage } from '@/background/storage/openrouter-storage';
import {
    LLM_ROLE,
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
    /**
     * Provider id literal for prefs and messaging.
     */
    readonly id = PROVIDER_ID.OpenRouter;

    /**
     * Human label for the options provider list.
     */
    readonly displayName = 'OpenRouter';

    /**
     * OpenRouter remote models use large contexts; treat as unbounded for
     * chunk planning.
     *
     * @returns Effectively no per-call char cap.
     */
    maxTranscriptChars(): Promise<number> {
        return Promise.resolve(Number.MAX_SAFE_INTEGER);
    }

    /**
     * Returns `'available'` when a non-empty API key and model are
     * configured in `OpenRouterStorage`, `'unavailable'` otherwise.
     *
     * @returns Current provider availability.
     */
    async availability(): Promise<ProviderAvailability> {
        const config = await OpenRouterStorage.load();
        if (config.apiKey.length > 0 && config.model.length > 0) {
            return PROVIDER_AVAILABILITY.AVAILABLE;
        }
        return PROVIDER_AVAILABILITY.UNAVAILABLE;
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
                {
                    role: LLM_ROLE.System,
                    content: PROMO_DETECTION_SYSTEM_PROMPT,
                },
                { role: LLM_ROLE.User, content: params.transcript },
            ],
        });

        if (!llm.ok) {
            const tooLarge =
                /HTTP 400/i.test(llm.error) &&
                /context|length|token|maximum|too large/i.test(llm.error);
            if (tooLarge) {
                return { ok: false, error: llm.error, tooLarge: true };
            }
            return { ok: false, error: llm.error };
        }

        const parsed = parseLlmPromoResponse(
            llm.rawContent,
            params.durationSec,
        );
        if (!parsed.ok) {
            return {
                ok: false,
                error: parsed.error,
                rawAssistant: llm.rawContent,
            };
        }

        const meta = { id: this.id, model: config.model };

        if (!parsed.hasPromo) {
            return {
                ok: true,
                hasPromo: false,
                providerMeta: meta,
                rawAssistant: llm.rawContent,
            };
        }

        return {
            ok: true,
            hasPromo: true,
            blocks: parsed.blocks,
            providerMeta: meta,
            rawAssistant: llm.rawContent,
        };
    }
}
