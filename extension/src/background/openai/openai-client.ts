import { MIME_APPLICATION_JSON } from '@/shared/constants';
import { getErrorMessage } from '@/shared/error';

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
const HTTP_UNAUTHORIZED = 401;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_MIN = 500;

/**
 * Request values needed to call the OpenAI Responses API.
 */
export type CallOpenAiResponseParams = {
    apiKey: string;
    model: string;
    instructions: string;
    input: string;
    signal?: AbortSignal;
};

/**
 * Result of a Responses API call after extracting assistant text.
 */
export type CallOpenAiResponseResult =
    | { ok: true; rawContent: string }
    | { ok: false; error: string; retryable?: boolean };

/**
 * Result of checking whether an OpenAI key can access the models endpoint.
 */
export type TestOpenAiApiKeyResult =
    | { ok: true; valid: true }
    | { ok: true; valid: false; error: string }
    | { ok: false; error: string; retryable?: boolean };

/**
 * Narrows unknown JSON values to object records.
 *
 * @param value - Unknown JSON value.
 * @returns Whether value is a non-array object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Extracts first `output_text` item from OpenAI Responses API JSON.
 *
 * @param value - Untyped Responses API JSON.
 * @returns Output text or `undefined` when shape is not usable.
 */
function extractOutputText(value: unknown): string | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const output = value.output;
    if (!Array.isArray(output)) {
        return undefined;
    }
    for (const item of output) {
        if (!isRecord(item)) {
            continue;
        }
        const content = item.content;
        if (!Array.isArray(content)) {
            continue;
        }
        const textItem = content.find(
            (entry): entry is Record<string, unknown> => {
                return (
                    isRecord(entry) &&
                    entry.type === 'output_text' &&
                    typeof entry.text === 'string'
                );
            },
        );
        if (textItem) {
            const text = textItem.text;
            return typeof text === 'string' ? text : undefined;
        }
    }
    return undefined;
}

/**
 * Determines whether an OpenAI HTTP failure may succeed if retried later.
 *
 * @param status - HTTP status code.
 * @returns Whether the failure is retryable.
 */
function isRetryableStatus(status: number): boolean {
    return status === HTTP_TOO_MANY_REQUESTS || status >= HTTP_SERVER_ERROR_MIN;
}

/**
 * Calls OpenAI Responses API and extracts the assistant text.
 *
 * @param params - OpenAI request parameters.
 * @returns Assistant output text or error.
 */
export async function callOpenAiResponse(
    params: CallOpenAiResponseParams,
): Promise<CallOpenAiResponseResult> {
    try {
        const response = await fetch(OPENAI_RESPONSES_URL, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${params.apiKey}`,
                Accept: MIME_APPLICATION_JSON,
                'Content-Type': MIME_APPLICATION_JSON,
            },
            body: JSON.stringify({
                model: params.model,
                instructions: params.instructions,
                input: params.input,
                store: false,
            }),
            signal: params.signal,
        });
        if (!response.ok) {
            const body = await response.text();
            return {
                ok: false,
                error: `OpenAI HTTP ${response.status}: ${body}`,
                retryable: isRetryableStatus(response.status),
            };
        }
        const data = (await response.json()) as unknown;
        const rawContent = extractOutputText(data);
        if (rawContent === undefined) {
            return {
                ok: false,
                error: 'OpenAI response did not include output text',
            };
        }
        return { ok: true, rawContent };
    } catch (e) {
        return { ok: false, error: getErrorMessage(e), retryable: true };
    }
}

/**
 * Validates an OpenAI API key without spending completion tokens.
 *
 * @param apiKey - Draft or saved OpenAI API key.
 * @returns Validation result.
 */
export async function testOpenAiApiKey(
    apiKey: string,
): Promise<TestOpenAiApiKeyResult> {
    if (apiKey.trim().length === 0) {
        return { ok: true, valid: false, error: 'OpenAI API key is required.' };
    }
    try {
        const response = await fetch(OPENAI_MODELS_URL, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                Accept: MIME_APPLICATION_JSON,
            },
        });
        if (response.ok) {
            return { ok: true, valid: true };
        }
        if (response.status === HTTP_UNAUTHORIZED) {
            return {
                ok: true,
                valid: false,
                error: 'OpenAI API key is invalid.',
            };
        }
        const body = await response.text();
        return {
            ok: false,
            error: `OpenAI HTTP ${response.status}: ${body}`,
            retryable: isRetryableStatus(response.status),
        };
    } catch (e) {
        return { ok: false, error: getErrorMessage(e), retryable: true };
    }
}
