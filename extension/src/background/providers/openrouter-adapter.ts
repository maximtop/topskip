import { callOpenRouterChat } from '@/background/openrouter/openrouter-client';
import { parseLlmPromoResponse } from '@/background/openrouter/parse-llm-promo-response';
import { PROMO_DETECTION_SYSTEM_PROMPT } from '@/background/openrouter/promo-detection-system-prompt';
import { OpenRouterStorage } from '@/background/storage/openrouter-storage';
import { ProviderHostAccess } from '@/background/permissions/provider-host-access';
import {
    LLM_ROLE,
    PROVIDER_ANALYSIS_FAILURE_CODE,
    PROVIDER_AVAILABILITY,
    PROVIDER_HOST_ACCESS_REQUIRED_ERROR,
    PROVIDER_ID,
    type AnalyzeTranscriptParams,
    type AnalyzeTranscriptResult,
    type LlmProviderAdapter,
    type ProviderAvailability,
} from '@/background/providers/llm-provider-adapter';

/**
 * Wraps OpenRouter behind extension-owned configuration, permission, and
 * response-parsing boundaries.
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
     * Returns `'available'` only when key, model, and the optional OpenRouter
     * host grant are all present.
     *
     * @returns Current provider availability.
     */
    async availability(): Promise<ProviderAvailability> {
        const config = await OpenRouterStorage.load();
        if (config.apiKey.length === 0 || config.model.length === 0) {
            return PROVIDER_AVAILABILITY.UNAVAILABLE;
        }
        const hasHostAccess = await ProviderHostAccess.isGranted(this.id);
        return hasHostAccess
            ? PROVIDER_AVAILABILITY.AVAILABLE
            : PROVIDER_AVAILABILITY.UNAVAILABLE;
    }

    /**
     * Rechecks the optional grant immediately before sending the transcript,
     * then parses the promo-detection response.
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

        const hasHostAccess = await ProviderHostAccess.isGranted(this.id);
        if (!hasHostAccess) {
            return {
                ok: false,
                failureCode:
                    PROVIDER_ANALYSIS_FAILURE_CODE.HostAccessRequired,
                error: PROVIDER_HOST_ACCESS_REQUIRED_ERROR,
            };
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
                return {
                    ok: false,
                    error: llm.error,
                    tooLarge: true,
                    status: llm.status,
                    kind: llm.kind,
                };
            }
            return {
                ok: false,
                error: llm.error,
                status: llm.status,
                kind: llm.kind,
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
                status: null,
                kind: 'parse',
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
