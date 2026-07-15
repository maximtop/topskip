import * as v from 'valibot';

import { BackgroundServerAnalysisLog } from '@/background/server-analysis-log';
import { ServerInstallationStorage } from '@/background/storage/server-installation-storage';
import { MIME_APPLICATION_JSON } from '@/shared/constants';
import {
    SERVER_ANALYSIS_FAILURE_CODE,
    SERVER_ANALYSIS_SUPPORTED_CAPABILITIES,
    TOPSKIP_CAPABILITIES_HEADER_NAME,
    buildServerAnalysisRequest,
    installationRegistrationResponseSchema,
    serverAnalysisResponseSchema,
    serverConfigResponseSchema,
    type InstallationRegistrationResponse,
    type ServerAnalysisFailure,
    type ServerAnalysisResponse,
    type ServerConfigResponse,
} from '@topskip/common/server-analysis-contract';

const SERVER_ANALYSIS_REQUEST_TIMEOUT_MS = 5_000;
const SERVER_ANALYSIS_CAPABILITIES_HEADER_VALUE =
    SERVER_ANALYSIS_SUPPORTED_CAPABILITIES.join(',');
const DEV_SERVER_ANALYSIS_BASE_URL = 'http://127.0.0.1:8787';
const SERVER_ANALYSIS_BASE_URL =
    typeof __TOPSKIP_SERVER_BASE_URL__ === 'undefined'
        ? DEV_SERVER_ANALYSIS_BASE_URL
        : __TOPSKIP_SERVER_BASE_URL__;

/**
 * Safe operation labels used by development diagnostics.
 */
type ServerOperation = 'analysis' | 'poll' | 'config' | 'register';

const SERVER_OPERATION_MAX_ATTEMPTS = {
    analysis: 2,
    poll: 2,
    config: 2,
    // Registration is non-idempotent: a lost response must not mint a second token.
    register: 1,
} satisfies Record<ServerOperation, number>;

/**
 * Minimal decoded HTTP result passed to endpoint-specific validators.
 */
type BackendJsonResult = {
    ok: boolean;
    json: unknown;
};

/**
 * Carries only allow-listed diagnostics when transport or validation fails.
 */
export class ServerAnalysisClientError extends Error {
    /**
     * Stable details safe to map into popup state.
     */
    readonly failure: ServerAnalysisFailure;

    /**
     * Creates a sanitized client failure without retaining raw response text.
     *
     * @param failure - Stable server-analysis failure details.
     */
    constructor(failure: ServerAnalysisFailure) {
        super('TopSkip server request failed.');
        this.name = 'ServerAnalysisClientError';
        this.failure = failure;
    }
}

/**
 * Background-owned client for the configured TopSkip backend; static API only.
 */
export class ServerAnalysisClient {
    /**
     * Coalesces simultaneous first-use registration requests.
     */
    private static registrationInFlight: Promise<string> | null = null;

    /**
     * Creates the stable fallback used for network and malformed responses.
     *
     * @returns Sanitized client error.
     */
    private static invalidResponseError(): ServerAnalysisClientError {
        return new ServerAnalysisClientError({
            code: SERVER_ANALYSIS_FAILURE_CODE.InvalidServerResponse,
        });
    }

    /**
     * Fetches a bounded API endpoint with the shared timeout without retaining
     * raw provider or backend error bodies.
     *
     * @param input - Safe operation metadata and fetch configuration.
     * @param attempt - One-based transport attempt for safe diagnostics.
     * @returns HTTP success flag and opaque decoded JSON.
     */
    private static async fetchBackendJsonAttempt(
        input: {
            operation: ServerOperation;
            videoId?: string;
            jobId?: string;
            path: string;
            init: RequestInit;
        },
        attempt: number,
    ): Promise<BackendJsonResult | null> {
        const controller = new AbortController();
        const startedAtMs = Date.now();
        const timeoutId = setTimeout(() => {
            controller.abort();
        }, SERVER_ANALYSIS_REQUEST_TIMEOUT_MS);

        try {
            BackgroundServerAnalysisLog.info('http-start', {
                operation: input.operation,
                videoId: input.videoId,
                jobId: input.jobId,
                attempt,
            });
            let response: Response;
            try {
                response = await fetch(
                    `${SERVER_ANALYSIS_BASE_URL}${input.path}`,
                    {
                        ...input.init,
                        signal: controller.signal,
                    },
                );
            } catch {
                BackgroundServerAnalysisLog.warn('http-error', {
                    operation: input.operation,
                    videoId: input.videoId,
                    jobId: input.jobId,
                    code: controller.signal.aborted
                        ? 'timeout'
                        : 'request-failed',
                    elapsedMs: Date.now() - startedAtMs,
                    attempt,
                });
                return null;
            }

            let json: unknown;
            try {
                // Fetch JSON is untyped and is validated by the endpoint caller.
                json = (await response.json()) as unknown;
            } catch {
                if (controller.signal.aborted) {
                    BackgroundServerAnalysisLog.warn('http-error', {
                        operation: input.operation,
                        videoId: input.videoId,
                        jobId: input.jobId,
                        code: 'timeout',
                        elapsedMs: Date.now() - startedAtMs,
                        attempt,
                    });
                    return null;
                }
                throw ServerAnalysisClient.invalidResponseError();
            }
            BackgroundServerAnalysisLog.info('http-response', {
                operation: input.operation,
                videoId: input.videoId,
                jobId: input.jobId,
                statusCode: response.status,
                elapsedMs: Date.now() - startedAtMs,
                attempt,
            });
            return { ok: response.ok, json };
        } finally {
            clearTimeout(timeoutId);
        }
    }

    /**
     * Retries one replay-safe transport failure while leaving registration
     * single-shot and keeping HTTP or malformed JSON outcomes authoritative.
     *
     * @param input - Safe operation metadata and fetch configuration.
     * @returns HTTP success flag and opaque decoded JSON.
     */
    private static async fetchBackendJson(input: {
        operation: ServerOperation;
        videoId?: string;
        jobId?: string;
        path: string;
        init: RequestInit;
    }): Promise<BackendJsonResult> {
        for (
            let attempt = 1;
            attempt <= SERVER_OPERATION_MAX_ATTEMPTS[input.operation];
            attempt += 1
        ) {
            const result = await ServerAnalysisClient.fetchBackendJsonAttempt(
                input,
                attempt,
            );
            if (result !== null) {
                return result;
            }
        }
        throw ServerAnalysisClient.invalidResponseError();
    }

    /**
     * Parses an analysis response and replaces schema details with a stable
     * extension-safe code.
     *
     * @param json - Opaque decoded response.
     * @returns Validated analysis response.
     */
    private static parseAnalysisResponse(
        json: unknown,
    ): ServerAnalysisResponse {
        try {
            return v.parse(serverAnalysisResponseSchema, json);
        } catch {
            throw ServerAnalysisClient.invalidResponseError();
        }
    }

    /**
     * Extracts typed failure details from a non-success endpoint response.
     *
     * @param json - Opaque decoded response.
     * @returns Safe failure error.
     */
    private static parseEndpointFailure(
        json: unknown,
    ): ServerAnalysisClientError {
        const response = ServerAnalysisClient.parseAnalysisResponse(json);
        if (
            response.status === 'error' ||
            response.status === 'unavailable' ||
            response.status === 'rate_limited'
        ) {
            return new ServerAnalysisClientError(response.error);
        }
        return ServerAnalysisClient.invalidResponseError();
    }

    /**
     * Requires non-2xx authenticated responses to carry a typed failure rather
     * than accepting a forged or broken success body.
     *
     * @param result - Decoded HTTP result with its success flag.
     * @returns Validated analysis response.
     */
    private static parseAuthenticatedResult(
        result: BackendJsonResult,
    ): ServerAnalysisResponse {
        const response = ServerAnalysisClient.parseAnalysisResponse(
            result.json,
        );
        if (
            !result.ok &&
            response.status !== 'error' &&
            response.status !== 'unavailable' &&
            response.status !== 'rate_limited'
        ) {
            throw ServerAnalysisClient.invalidResponseError();
        }
        return response;
    }

    /**
     * Registers one anonymous installation only when server mode first needs it.
     *
     * @returns Newly persisted bearer token.
     */
    private static async registerInstallation(): Promise<string> {
        if (ServerAnalysisClient.registrationInFlight !== null) {
            return ServerAnalysisClient.registrationInFlight;
        }

        ServerAnalysisClient.registrationInFlight = (async () => {
            const result = await ServerAnalysisClient.fetchBackendJson({
                operation: 'register',
                path: '/v1/installations/register',
                init: {
                    method: 'POST',
                    headers: {
                        accept: MIME_APPLICATION_JSON,
                        [TOPSKIP_CAPABILITIES_HEADER_NAME]:
                            SERVER_ANALYSIS_CAPABILITIES_HEADER_VALUE,
                    },
                },
            });
            if (!result.ok) {
                throw ServerAnalysisClient.parseEndpointFailure(result.json);
            }

            let registration: InstallationRegistrationResponse;
            try {
                registration = v.parse(
                    installationRegistrationResponseSchema,
                    result.json,
                );
            } catch {
                throw ServerAnalysisClient.invalidResponseError();
            }
            await ServerInstallationStorage.save({
                token: registration.token,
                expiresAtMs: registration.expiresAtMs,
            });
            return registration.token;
        })();

        try {
            return await ServerAnalysisClient.registrationInFlight;
        } finally {
            ServerAnalysisClient.registrationInFlight = null;
        }
    }

    /**
     * Loads a fresh credential or lazily creates one for server mode.
     *
     * @param forceRegistration - Skips storage after the server rejects a token.
     * @returns Bearer token retained only in background memory/storage.
     */
    private static async getInstallationToken(
        forceRegistration = false,
    ): Promise<string> {
        if (!forceRegistration) {
            const stored = await ServerInstallationStorage.loadFresh();
            if (stored !== null) {
                return stored.token;
            }
        }
        return ServerAnalysisClient.registerInstallation();
    }

    /**
     * Executes one authenticated API request and retries once only when the
     * server reports an expired installation credential.
     *
     * @param input - Operation metadata and token-aware request factory.
     * @param canRetryToken - Whether the one safe auth retry remains.
     * @returns Validated analysis response.
     */
    private static async requestAuthenticated(
        input: {
            operation: 'analysis' | 'poll';
            videoId?: string;
            jobId?: string;
            path: string;
            method: 'GET' | 'POST';
            body?: string;
        },
        canRetryToken = true,
    ): Promise<ServerAnalysisResponse> {
        const token = await ServerAnalysisClient.getInstallationToken();
        const headers: Record<string, string> = {
            accept: MIME_APPLICATION_JSON,
            authorization: `Bearer ${token}`,
            [TOPSKIP_CAPABILITIES_HEADER_NAME]:
                SERVER_ANALYSIS_CAPABILITIES_HEADER_VALUE,
        };
        if (input.body !== undefined) {
            headers['content-type'] = MIME_APPLICATION_JSON;
        }
        const result = await ServerAnalysisClient.fetchBackendJson({
            operation: input.operation,
            videoId: input.videoId,
            jobId: input.jobId,
            path: input.path,
            init: {
                method: input.method,
                headers,
                ...(input.body === undefined ? {} : { body: input.body }),
            },
        });
        const response = ServerAnalysisClient.parseAuthenticatedResult(result);
        if (
            canRetryToken &&
            response.status === 'error' &&
            (response.error.code ===
                SERVER_ANALYSIS_FAILURE_CODE.TokenExpired ||
                response.error.code ===
                    SERVER_ANALYSIS_FAILURE_CODE.TokenInvalid)
        ) {
            await ServerInstallationStorage.clear();
            const replacementToken =
                await ServerAnalysisClient.getInstallationToken(true);
            const retryResult = await ServerAnalysisClient.fetchBackendJson({
                operation: input.operation,
                videoId: input.videoId,
                jobId: input.jobId,
                path: input.path,
                init: {
                    method: input.method,
                    headers: {
                        ...headers,
                        authorization: `Bearer ${replacementToken}`,
                    },
                    ...(input.body === undefined ? {} : { body: input.body }),
                },
            });
            return ServerAnalysisClient.parseAuthenticatedResult(retryResult);
        }
        return response;
    }

    /**
     * Loads public compatibility metadata without creating an installation.
     *
     * @returns Validated public server config.
     */
    static async requestConfig(): Promise<ServerConfigResponse> {
        const result = await ServerAnalysisClient.fetchBackendJson({
            operation: 'config',
            path: '/v1/config',
            init: {
                method: 'GET',
                headers: { accept: MIME_APPLICATION_JSON },
            },
        });
        if (!result.ok) {
            throw ServerAnalysisClient.parseEndpointFailure(result.json);
        }
        try {
            return v.parse(serverConfigResponseSchema, result.json);
        } catch {
            throw ServerAnalysisClient.invalidResponseError();
        }
    }

    /**
     * Requests the current server analysis state for a video.
     *
     * @param input - Current video metadata and extension version.
     * @returns Validated server analysis response.
     */
    static async requestAnalysis(input: {
        videoId: string;
        durationSec?: number;
        extensionVersion: string;
    }): Promise<ServerAnalysisResponse> {
        const request = buildServerAnalysisRequest(input);
        return ServerAnalysisClient.requestAuthenticated({
            operation: 'analysis',
            videoId: input.videoId,
            path: '/v1/analysis',
            method: 'POST',
            body: JSON.stringify(request),
        });
    }

    /**
     * Requests the latest state for an existing backend analysis job.
     *
     * @param jobId - Backend job id from a processing response.
     * @returns Validated server analysis response.
     */
    static async requestJobStatus(
        jobId: string,
    ): Promise<ServerAnalysisResponse> {
        return ServerAnalysisClient.requestAuthenticated({
            operation: 'poll',
            jobId,
            path: `/v1/analysis/jobs/${encodeURIComponent(jobId)}`,
            method: 'GET',
        });
    }
}
