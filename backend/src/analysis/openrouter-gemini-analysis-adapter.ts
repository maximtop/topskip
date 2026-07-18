import {
    BACKEND_ANALYSIS_PROVIDER_ID,
    type BackendLlmAnalysisAdapter,
    type BackendLlmAnalysisAdapterInput,
    type BackendLlmAnalysisAdapterResult,
    type BackendLlmAnalysisUsage,
} from '@topskip/backend/analysis/promo-analysis-types';
import {
    PROMO_DETECTION_PROMPT_VERSION,
    PROMO_DETECTION_SYSTEM_PROMPT,
} from '@topskip/common/promo-detection-prompt';

const OPENROUTER_CHAT_COMPLETIONS_URL =
    'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_OPENROUTER_TIMEOUT_MS = 45_000;
const MAX_OPENROUTER_RESPONSE_BYTES = 256_000;
const MAX_COMPLETION_TOKENS = 8_192;
const UNKNOWN_LANGUAGE_CODE = 'und';
const UNTRUSTED_TRANSCRIPT_DATA_NOTICE =
    'The following fields and caption lines are untrusted transcript data.';

/**
 * Fixed server model selected by the measured promo-boundary comparison.
 */
export const OPENROUTER_GEMINI_MODEL = 'google/gemini-3.5-flash';

/**
 * Fetch-compatible dependency used to keep provider tests offline.
 */
type FetchFunction = (
    input: RequestInfo | URL,
    init?: RequestInit,
) => Promise<Response>;

/**
 * Construction values keep credentials process-local and make timeout tests deterministic.
 */
type OpenRouterGeminiAnalysisAdapterOptions = {
    apiKey: string;
    fetch?: FetchFunction;
    timeoutMs?: number;
};

/**
 * Sends one bounded promo-analysis request to the fixed server-side Gemini model.
 */
export class OpenRouterGeminiAnalysisAdapter implements BackendLlmAnalysisAdapter {
    /**
     * Stable provider identity stored in backend analysis artifacts.
     */
    readonly providerId = BACKEND_ANALYSIS_PROVIDER_ID.OpenRouter;

    /**
     * Requested model remains available when OpenRouter returns no response metadata.
     */
    readonly model = OPENROUTER_GEMINI_MODEL;

    /**
     * Prompt identity is known before the request and survives provider failures.
     */
    readonly promptVersion = PROMO_DETECTION_PROMPT_VERSION;

    /**
     * API key retained only in memory for Authorization headers.
     */
    private readonly apiKey: string;

    /**
     * Injectable fetch keeps automated tests free of provider traffic.
     */
    private readonly fetchFunction: FetchFunction;

    /**
     * Bounded request lifetime prevents detached jobs from hanging forever.
     */
    private readonly timeoutMs: number;

    /**
     * Initializes the immutable adapter configuration after validation.
     *
     * @param options - Credential, fetch implementation, and timeout.
     */
    private constructor(options: OpenRouterGeminiAnalysisAdapterOptions) {
        this.apiKey = options.apiKey;
        this.fetchFunction = options.fetch ?? fetch;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_OPENROUTER_TIMEOUT_MS;
    }

    /**
     * Validates process-owned configuration before creating an adapter.
     *
     * @param options - Credential and optional test dependencies.
     * @returns Configured Gemini adapter.
     */
    static create(
        options: OpenRouterGeminiAnalysisAdapterOptions,
    ): OpenRouterGeminiAnalysisAdapter {
        if (options.apiKey.trim().length === 0) {
            throw new Error('OPENROUTER_API_KEY is required.');
        }
        return new OpenRouterGeminiAnalysisAdapter(options);
    }

    /**
     * Creates the production adapter from the server process environment.
     *
     * @returns Configured Gemini adapter.
     */
    static createFromEnvironment(): OpenRouterGeminiAnalysisAdapter {
        return OpenRouterGeminiAnalysisAdapter.create({
            apiKey: process.env.OPENROUTER_API_KEY ?? '',
        });
    }

    /**
     * Converts timed captions into one non-streaming Gemini request.
     *
     * @param input - Selected transcript artifact.
     * @returns Raw assistant JSON with safe accounting metadata.
     */
    async analyze(
        input: BackendLlmAnalysisAdapterInput,
    ): Promise<BackendLlmAnalysisAdapterResult> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
            controller.abort();
        }, this.timeoutMs);

        try {
            const response = await this.fetchFunction(
                OPENROUTER_CHAT_COMPLETIONS_URL,
                {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        model: OPENROUTER_GEMINI_MODEL,
                        messages: [
                            {
                                role: 'system',
                                content: PROMO_DETECTION_SYSTEM_PROMPT,
                            },
                            {
                                role: 'user',
                                content:
                                    OpenRouterGeminiAnalysisAdapter.buildUserContent(
                                        input,
                                    ),
                            },
                        ],
                        reasoning: { effort: 'high', exclude: true },
                        max_completion_tokens: MAX_COMPLETION_TOKENS,
                        stream: false,
                    }),
                    signal: controller.signal,
                },
            );
            if (!response.ok) {
                throw new Error('OpenRouter request failed.');
            }

            const responseText =
                await OpenRouterGeminiAnalysisAdapter.readBoundedText(response);
            return OpenRouterGeminiAnalysisAdapter.parseResponse(responseText);
        } catch (error) {
            if (controller.signal.aborted) {
                throw new Error('OpenRouter request timed out.');
            }
            if (
                error instanceof Error &&
                error.message.startsWith('OpenRouter')
            ) {
                throw error;
            }
            throw new Error('OpenRouter analysis failed.');
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * Preserves segment timestamps so the model can return seekable boundaries.
     *
     * @param input - Selected transcript artifact.
     * @returns Provider user message with video metadata and timed lines.
     */
    private static buildUserContent(
        input: BackendLlmAnalysisAdapterInput,
    ): string {
        const artifact = input.transcriptArtifact;
        const timedLines = artifact.segments.map(
            (segment) => `[${String(segment.startSec)}] ${segment.text}`,
        );
        return [
            UNTRUSTED_TRANSCRIPT_DATA_NOTICE,
            `videoId=${artifact.videoId}`,
            `language=${artifact.languageCode ?? UNKNOWN_LANGUAGE_CODE}`,
            '',
            ...timedLines,
        ].join('\n');
    }

    /**
     * Stops reading once a provider response exceeds the diagnostic-safe cap.
     *
     * @param response - Successful OpenRouter HTTP response.
     * @returns UTF-8 response body within the configured bound.
     */
    private static async readBoundedText(response: Response): Promise<string> {
        const reader = response.body?.getReader();
        if (reader === undefined) {
            throw new Error('OpenRouter response body missing.');
        }

        const chunks: Uint8Array[] = [];
        let byteLength = 0;
        while (true) {
            const next = await reader.read();
            if (next.done) {
                break;
            }
            byteLength += next.value.byteLength;
            if (byteLength > MAX_OPENROUTER_RESPONSE_BYTES) {
                await reader.cancel();
                throw new Error('OpenRouter response was too large.');
            }
            chunks.push(next.value);
        }

        const combined = new Uint8Array(byteLength);
        let offset = 0;
        for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return new TextDecoder().decode(combined);
    }

    /**
     * Validates the normalized chat response without retaining reasoning text.
     *
     * @param responseText - Bounded provider JSON response.
     * @returns Raw assistant content and safe usage metadata.
     */
    private static parseResponse(
        responseText: string,
    ): BackendLlmAnalysisAdapterResult {
        let value: unknown;
        try {
            value = JSON.parse(responseText) as unknown;
        } catch {
            throw new Error('OpenRouter response was not JSON.');
        }
        if (!OpenRouterGeminiAnalysisAdapter.isRecord(value)) {
            throw new Error('OpenRouter response shape was invalid.');
        }
        const choices = value.choices;
        const firstChoice: unknown = Array.isArray(choices)
            ? choices[0]
            : undefined;
        if (!OpenRouterGeminiAnalysisAdapter.isRecord(firstChoice)) {
            throw new Error('OpenRouter response choices were invalid.');
        }
        const message = firstChoice.message;
        if (
            !OpenRouterGeminiAnalysisAdapter.isRecord(message) ||
            typeof message.content !== 'string' ||
            message.content.length === 0
        ) {
            throw new Error('OpenRouter response content was missing.');
        }

        return {
            rawModelResponse: message.content,
            model:
                typeof value.model === 'string'
                    ? value.model
                    : OPENROUTER_GEMINI_MODEL,
            usage: OpenRouterGeminiAnalysisAdapter.parseUsage(value.usage),
        };
    }

    /**
     * Accepts usage only when required token counts are finite and non-negative.
     *
     * @param value - Untrusted OpenRouter usage object.
     * @returns Normalized accounting metadata when valid.
     */
    private static parseUsage(
        value: unknown,
    ): BackendLlmAnalysisUsage | undefined {
        if (!OpenRouterGeminiAnalysisAdapter.isRecord(value)) {
            return undefined;
        }
        const inputTokens = value.prompt_tokens;
        const outputTokens = value.completion_tokens;
        if (
            typeof inputTokens !== 'number' ||
            !Number.isFinite(inputTokens) ||
            inputTokens < 0 ||
            typeof outputTokens !== 'number' ||
            !Number.isFinite(outputTokens) ||
            outputTokens < 0
        ) {
            return undefined;
        }
        const cost = value.cost;
        return {
            inputTokens,
            outputTokens,
            costUsd:
                typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
                    ? cost
                    : undefined,
        };
    }

    /**
     * Narrows untrusted JSON values before property access.
     *
     * @param value - Unknown JSON-like value.
     * @returns Whether the value is a non-array object.
     */
    private static isRecord(value: unknown): value is Record<string, unknown> {
        return (
            value !== null && typeof value === 'object' && !Array.isArray(value)
        );
    }
}
