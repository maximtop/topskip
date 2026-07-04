import { callOpenAiResponse } from '@/background/openai/openai-client';
import { parseLlmPromoResponse } from '@/background/openrouter/parse-llm-promo-response';
import { PROMO_DETECTION_SYSTEM_PROMPT } from '@/background/openrouter/promo-detection-system-prompt';
import { OpenAiStorage } from '@/background/storage/openai-storage';
import {
    PROVIDER_AVAILABILITY,
    PROVIDER_ID,
    type AnalyzeTranscriptParams,
    type AnalyzeTranscriptResult,
    type LlmProviderAdapter,
    type ProviderAvailability,
} from '@/background/providers/llm-provider-adapter';

/**
 * OpenAI Responses API adapter for model-first cloud detection.
 */
export class OpenAiAdapter implements LlmProviderAdapter {
    /**
     * Provider id literal for prefs and messaging.
     */
    readonly id = PROVIDER_ID.OpenAI;

    /**
     * Human label for model metadata and connection rows.
     */
    readonly displayName = 'OpenAI';

    /**
     * OpenAI cloud models have large enough context for current chunk planner.
     *
     * @returns Effectively no per-call char cap.
     */
    maxTranscriptChars(): Promise<number> {
        return Promise.resolve(Number.MAX_SAFE_INTEGER);
    }

    /**
     * Checks whether OpenAI key and selected model exist in background storage.
     *
     * @returns Current provider availability.
     */
    async availability(): Promise<ProviderAvailability> {
        const config = await OpenAiStorage.load();
        if (config.apiKey.length > 0 && config.model.length > 0) {
            return PROVIDER_AVAILABILITY.AVAILABLE;
        }
        return PROVIDER_AVAILABILITY.UNAVAILABLE;
    }

    /**
     * Sends transcript to OpenAI and parses the standard promo JSON response.
     *
     * @param params - Transcript and context.
     * @returns Detection result or error.
     */
    async analyzeTranscript(
        params: AnalyzeTranscriptParams,
    ): Promise<AnalyzeTranscriptResult> {
        const config = await OpenAiStorage.load();
        if (config.apiKey.length === 0 || config.model.length === 0) {
            return { ok: false, error: 'OpenAI is not configured' };
        }

        const llm = await callOpenAiResponse({
            apiKey: config.apiKey,
            model: config.model,
            instructions: PROMO_DETECTION_SYSTEM_PROMPT,
            input: params.transcript,
            signal: params.signal,
        });
        if (!llm.ok) {
            return {
                ok: false,
                error: llm.error,
                tooLarge: /context|length|token|maximum|too large/i.test(
                    llm.error,
                ),
            };
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
