import { MIME_APPLICATION_JSON } from '@/shared/constants';

const OPENROUTER_CHAT_COMPLETIONS_URL =
    'https://openrouter.ai/api/v1/chat/completions';

/**
 * Chat message shape accepted by OpenRouter chat completions.
 */
export type OpenRouterChatMessage = {
    role: 'system' | 'user' | 'assistant';
    content: string;
};

/**
 * Token details reported for prompt-side multimodal/cached usage.
 */
export type OpenRouterPromptTokenDetails = {
    cachedTokens?: number;
    cacheWriteTokens?: number;
    audioTokens?: number;
    videoTokens?: number;
};

/**
 * Token details reported for completion-side reasoning or media usage.
 */
export type OpenRouterCompletionTokenDetails = {
    reasoningTokens?: number;
    audioTokens?: number;
    imageTokens?: number;
};

/**
 * Provider cost details returned by OpenRouter for BYOK accounting.
 */
export type OpenRouterCostDetails = {
    upstreamInferenceCost?: number;
    upstreamInferencePromptCost?: number;
    upstreamInferenceCompletionsCost?: number;
};

/**
 * Normalized token and cost usage parsed from OpenRouter responses.
 */
export type OpenRouterUsage = {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    promptTokensDetails?: OpenRouterPromptTokenDetails;
    completionTokensDetails?: OpenRouterCompletionTokenDetails;
    cost?: number;
    isByok?: boolean;
    costDetails?: OpenRouterCostDetails;
};

/**
 * Request values needed to call OpenRouter chat completions.
 */
export type CallOpenRouterChatParams = {
    apiKey: string;
    model: string;
    messages: OpenRouterChatMessage[];
    signal?: AbortSignal;
};

/**
 * Narrows unknown JSON to a non-array object record.
 *
 * @param value - Unknown JSON-like value
 * @returns Whether the value is a plain object
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Reads a finite number field from an untyped JSON object.
 *
 * @param value - Unknown field value
 * @returns Finite number or `undefined`
 */
function getFiniteNumber(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return undefined;
    }
    return value;
}

/**
 * Reads a string field when the runtime type is `string`.
 *
 * @param value - Unknown field value
 * @returns String or `undefined`
 */
function getString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

/**
 * Reads a string field, preserving JSON `null` as distinct from missing.
 *
 * @param value - Unknown field value
 * @returns String, `null`, or `undefined`
 */
function getNullableString(value: unknown): string | null | undefined {
    if (value === null) {
        return null;
    }
    return getString(value);
}

/**
 * Reads a boolean field when the runtime type is `boolean`.
 *
 * @param value - Unknown field value
 * @returns Boolean or `undefined`
 */
function getBoolean(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
}

/**
 * Normalizes OpenRouter `prompt_tokens_details` snake_case into camelCase.
 *
 * @param value - Raw `prompt_tokens_details` object
 * @returns Normalized prompt token details or `undefined`
 */
function parsePromptTokenDetails(
    value: unknown,
): OpenRouterPromptTokenDetails | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const cachedTokens = getFiniteNumber(value.cached_tokens);
    const cacheWriteTokens = getFiniteNumber(value.cache_write_tokens);
    const audioTokens = getFiniteNumber(value.audio_tokens);
    const videoTokens = getFiniteNumber(value.video_tokens);
    if (
        cachedTokens === undefined &&
        cacheWriteTokens === undefined &&
        audioTokens === undefined &&
        videoTokens === undefined
    ) {
        return undefined;
    }
    return {
        cachedTokens,
        cacheWriteTokens,
        audioTokens,
        videoTokens,
    };
}

/**
 * Normalizes OpenRouter `completion_tokens_details` into camelCase fields.
 *
 * @param value - Raw `completion_tokens_details` object
 * @returns Normalized completion token details or `undefined`
 */
function parseCompletionTokenDetails(
    value: unknown,
): OpenRouterCompletionTokenDetails | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const reasoningTokens = getFiniteNumber(value.reasoning_tokens);
    const audioTokens = getFiniteNumber(value.audio_tokens);
    const imageTokens = getFiniteNumber(value.image_tokens);
    if (
        reasoningTokens === undefined &&
        audioTokens === undefined &&
        imageTokens === undefined
    ) {
        return undefined;
    }
    return {
        reasoningTokens,
        audioTokens,
        imageTokens,
    };
}

/**
 * Normalizes OpenRouter `cost_details` upstream cost fields when present.
 *
 * @param value - Raw `cost_details` object
 * @returns Normalized cost detail breakdown or `undefined`
 */
function parseCostDetails(value: unknown): OpenRouterCostDetails | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const upstreamInferenceCost = getFiniteNumber(
        value.upstream_inference_cost,
    );
    const upstreamInferencePromptCost = getFiniteNumber(
        value.upstream_inference_prompt_cost,
    );
    const upstreamInferenceCompletionsCost = getFiniteNumber(
        value.upstream_inference_completions_cost,
    );
    if (
        upstreamInferenceCost === undefined &&
        upstreamInferencePromptCost === undefined &&
        upstreamInferenceCompletionsCost === undefined
    ) {
        return undefined;
    }
    return {
        upstreamInferenceCost,
        upstreamInferencePromptCost,
        upstreamInferenceCompletionsCost,
    };
}

/**
 * Builds a typed usage object from OpenRouter’s `usage` JSON blob.
 *
 * @param value - Raw `usage` object from OpenRouter
 * @returns Normalized usage block or `undefined`
 */
function parseUsage(value: unknown): OpenRouterUsage | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const promptTokens = getFiniteNumber(value.prompt_tokens);
    const completionTokens = getFiniteNumber(value.completion_tokens);
    const totalTokens = getFiniteNumber(value.total_tokens);
    if (
        promptTokens === undefined ||
        completionTokens === undefined ||
        totalTokens === undefined
    ) {
        return undefined;
    }
    const usage: OpenRouterUsage = {
        promptTokens,
        completionTokens,
        totalTokens,
    };
    const promptTokensDetails = parsePromptTokenDetails(
        value.prompt_tokens_details,
    );
    if (promptTokensDetails !== undefined) {
        usage.promptTokensDetails = promptTokensDetails;
    }
    const completionTokensDetails = parseCompletionTokenDetails(
        value.completion_tokens_details,
    );
    if (completionTokensDetails !== undefined) {
        usage.completionTokensDetails = completionTokensDetails;
    }
    const cost = getFiniteNumber(value.cost);
    if (cost !== undefined) {
        usage.cost = cost;
    }
    const isByok = getBoolean(value.is_byok);
    if (isByok !== undefined) {
        usage.isByok = isByok;
    }
    const costDetails = parseCostDetails(value.cost_details);
    if (costDetails !== undefined) {
        usage.costDetails = costDetails;
    }
    return usage;
}

/**
 * Calls OpenRouter chat completions (non-streaming). Does not log the API key.
 *
 * @param params - Model, key, messages, optional abort signal
 * @returns Assistant message text or error
 */
export async function callOpenRouterChat(
    params: CallOpenRouterChatParams,
): Promise<
    | {
          ok: true;
          rawContent: string;
          usage?: OpenRouterUsage;
          responseId?: string;
          responseModel?: string;
          finishReason?: string | null;
          nativeFinishReason?: string | null;
      }
    | { ok: false; error: string }
> {
    const { apiKey, model, messages, signal } = params;
    try {
        const res = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': MIME_APPLICATION_JSON,
            },
            body: JSON.stringify({
                model,
                messages,
                stream: false,
            }),
            signal,
        });
        const text = await res.text();
        if (!res.ok) {
            return {
                ok: false,
                error: `OpenRouter HTTP ${res.status}: ${text.slice(0, 200)}`,
            };
        }
        let json: unknown;
        try {
            json = JSON.parse(text) as unknown;
        } catch {
            return { ok: false, error: 'OpenRouter response was not JSON' };
        }
        if (!isRecord(json)) {
            return { ok: false, error: 'OpenRouter JSON shape invalid' };
        }
        const rawChoices = json.choices;
        if (!Array.isArray(rawChoices) || rawChoices.length === 0) {
            return { ok: false, error: 'OpenRouter response missing choices' };
        }
        const first: unknown = rawChoices[0];
        if (!isRecord(first)) {
            return {
                ok: false,
                error: 'OpenRouter first choice shape invalid',
            };
        }
        const message = first.message;
        if (!isRecord(message)) {
            return { ok: false, error: 'OpenRouter response missing message' };
        }
        const content = message.content;
        if (typeof content !== 'string') {
            return { ok: false, error: 'OpenRouter assistant content missing' };
        }
        return {
            ok: true,
            rawContent: content,
            usage: parseUsage(json.usage),
            responseId: getString(json.id),
            responseModel: getString(json.model),
            finishReason: getNullableString(first.finish_reason),
            nativeFinishReason: getNullableString(first.native_finish_reason),
        };
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, error: msg };
    }
}
