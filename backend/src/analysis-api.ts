import * as v from 'valibot';

import {
    BACKEND_REQUEST_COST_CLASS,
    BackendApiProtection,
} from '@topskip/backend/api-protection';
import { AnalysisArtifactStore } from '@topskip/backend/analysis-artifact-store';
import {
    BackendAnalysisJobs,
    type BackendAnalysisTerminalResponse,
} from '@topskip/backend/analysis-jobs';
import { BackendCacheFixtures } from '@topskip/backend/cache-fixtures';
import {
    errorResponseSchema,
    isValidYouTubeVideoId,
    rateLimitedResponseSchema,
    SERVER_ANALYSIS_FAILURE_CODE,
    SERVER_ANALYSIS_ALGORITHM_VERSION,
    serverAnalysisRequestSchema,
    type ErrorResponse,
    type ProcessingResponse,
    type RateLimitedResponse,
    unavailableResponseSchema,
} from '@topskip/common/server-analysis-contract';
import { BackendServerAnalysisLog } from '@topskip/backend/server-analysis-log';

const MAX_VIDEO_DURATION_SEC = 5 * 60 * 60;
const LOCAL_INSTALLATION_HASH = 'local-development';
const LOCAL_IP_HASH = 'local-development';

const fixtureCompletionRequestSchema = v.strictObject({
    status: v.picklist(['ready', 'no_promo', 'unavailable', 'error'] as const),
});

/**
 * HTTP result shape returned before the backend starts any expensive work.
 */
type BackendApiResult =
    | { statusCode: 200; body: BackendAnalysisTerminalResponse }
    | { statusCode: 202; body: ProcessingResponse }
    | { statusCode: 400; body: ErrorResponse }
    | { statusCode: 404; body: ErrorResponse }
    | { statusCode: 403; body: ErrorResponse }
    | { statusCode: 422; body: BackendAnalysisTerminalResponse }
    | { statusCode: 429; body: RateLimitedResponse };

/**
 * Hashed request identities connect public quota and ownership checks without raw credentials.
 */
export type BackendAnalysisRequestContext = {
    installationHash: string;
    ipHash: string;
    requestId?: string;
};

/**
 * Pure local API behavior for validation and deterministic processing states;
 * static API only.
 */
export class BackendAnalysisApi {
    /**
     * Returns process metadata for local development health checks.
     *
     * @returns Typed health response.
     */
    static health(): { ok: true } {
        return { ok: true };
    }

    /**
     * Validates the analysis request before cache lookup, job join, or cold extraction.
     *
     * @param raw - Untrusted JSON body from the HTTP server.
     * @param options - Deterministic clock override used by rate-limit tests.
     * @returns Typed API result for the HTTP layer.
     */
    static handleAnalysisRequest(
        raw: unknown,
        options: {
            nowMs?: number;
            context?: BackendAnalysisRequestContext;
        } = {},
    ): BackendApiResult {
        const nowMs = options.nowMs ?? Date.now();

        if (
            raw !== null &&
            typeof raw === 'object' &&
            'videoId' in raw &&
            typeof raw.videoId === 'string' &&
            !isValidYouTubeVideoId(raw.videoId)
        ) {
            return {
                statusCode: 400,
                body: BackendAnalysisApi.error(
                    SERVER_ANALYSIS_FAILURE_CODE.InvalidVideoId,
                ),
            };
        }

        const parsed = v.safeParse(serverAnalysisRequestSchema, raw);
        if (!parsed.success) {
            return {
                statusCode: 400,
                body: BackendAnalysisApi.error(
                    SERVER_ANALYSIS_FAILURE_CODE.InvalidRequest,
                ),
            };
        }

        const context = options.context ?? {
            installationHash: LOCAL_INSTALLATION_HASH,
            ipHash: LOCAL_IP_HASH,
        };
        const publicContext = options.context;

        const ready = BackendCacheFixtures.findReady({
            videoId: parsed.output.videoId,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        });
        if (ready !== null) {
            BackendServerAnalysisLog.info('backend-cache-hit', {
                requestId: context.requestId,
                videoId: parsed.output.videoId,
                source: 'seeded',
            });
            BackendApiProtection.evaluate({
                costClass: BACKEND_REQUEST_COST_CLASS.CacheLookup,
                nowMs,
            });
            return { statusCode: 200, body: ready };
        }

        const artifactResult = AnalysisArtifactStore.findLatestCacheable({
            videoId: parsed.output.videoId,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        });
        if (artifactResult !== null) {
            BackendServerAnalysisLog.info('backend-cache-hit', {
                requestId: context.requestId,
                videoId: parsed.output.videoId,
                source: 'artifact',
            });
            BackendApiProtection.evaluate({
                costClass: BACKEND_REQUEST_COST_CLASS.CacheLookup,
                nowMs,
            });
            const terminalResponse = artifactResult.terminalResponse;
            if (
                terminalResponse.status === 'ready' ||
                terminalResponse.status === 'no_promo'
            ) {
                return { statusCode: 200, body: terminalResponse };
            }
        }

        const existingJob = BackendAnalysisJobs.findExisting({
            videoId: parsed.output.videoId,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            installationHash: context.installationHash,
        });
        if (existingJob !== null) {
            BackendServerAnalysisLog.info('job-joined', {
                requestId: context.requestId,
                videoId: parsed.output.videoId,
                jobId:
                    existingJob.status === 'processing'
                        ? existingJob.jobId
                        : undefined,
            });
            BackendApiProtection.evaluate({
                costClass: BACKEND_REQUEST_COST_CLASS.JobJoin,
                nowMs,
            });
            return BackendAnalysisApi.jobResponseResult(existingJob);
        }

        if (
            parsed.output.durationSec !== undefined &&
            parsed.output.durationSec > MAX_VIDEO_DURATION_SEC
        ) {
            return {
                statusCode: 422,
                body: v.parse(
                    // Client duration is advisory and may only avoid a new cold job;
                    // reusable cache and joined work remain valid ahead of this check.
                    unavailableResponseSchema,
                    {
                        status: 'unavailable',
                        videoId: parsed.output.videoId,
                        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                        error: {
                            code: SERVER_ANALYSIS_FAILURE_CODE.VideoTooLong,
                        },
                    },
                ),
            };
        }

        if (!BackendAnalysisJobs.canAcceptColdJob()) {
            BackendServerAnalysisLog.warn('job-rate-limited', {
                requestId: context.requestId,
                videoId: parsed.output.videoId,
                code: SERVER_ANALYSIS_FAILURE_CODE.CapacityLimited,
                retryAfterSec: 3,
                queueDepth: BackendAnalysisJobs.queueDepth(),
            });
            return {
                statusCode: 429,
                body: BackendAnalysisApi.rateLimited(
                    3,
                    SERVER_ANALYSIS_FAILURE_CODE.CapacityLimited,
                ),
            };
        }
        const protection = BackendApiProtection.evaluate({
            costClass: BACKEND_REQUEST_COST_CLASS.ColdJobStart,
            nowMs,
            installationHash: publicContext?.installationHash,
            ipHash: publicContext?.ipHash,
        });
        if (!protection.allowed) {
            BackendServerAnalysisLog.warn('job-rate-limited', {
                requestId: context.requestId,
                videoId: parsed.output.videoId,
                code: SERVER_ANALYSIS_FAILURE_CODE.RateLimited,
                retryAfterSec: protection.retryAfterSec,
                queueDepth: BackendAnalysisJobs.queueDepth(),
            });
            return {
                statusCode: 429,
                body: BackendAnalysisApi.rateLimited(
                    protection.retryAfterSec,
                    SERVER_ANALYSIS_FAILURE_CODE.RateLimited,
                ),
            };
        }

        const jobResponse = BackendAnalysisJobs.start({
            videoId: parsed.output.videoId,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            durationSec: parsed.output.durationSec,
            nowMs,
            ownerInstallationHash: context.installationHash,
            requestId: context.requestId,
        });
        BackendServerAnalysisLog.info('job-started', {
            requestId: context.requestId,
            videoId: parsed.output.videoId,
            jobId:
                jobResponse.status === 'processing'
                    ? jobResponse.jobId
                    : undefined,
            queueDepth: BackendAnalysisJobs.queueDepth(),
        });
        return BackendAnalysisApi.jobResponseResult(jobResponse);
    }

    /**
     * Reads a pollable in-memory job response for the HTTP status endpoint.
     *
     * @param jobId - Local job id from a previous processing response.
     * @param options - Optional deterministic clock used by API tests.
     * @returns Current job state or typed not-found error.
     */
    static handleJobStatusRequest(
        jobId: string,
        options: {
            nowMs?: number;
            installationHash?: string;
        } = {},
    ): BackendApiResult {
        const jobResponse = BackendAnalysisJobs.getStatus(jobId, {
            nowMs: options.nowMs,
            ownerInstallationHash:
                options.installationHash ?? LOCAL_INSTALLATION_HASH,
        });
        if (jobResponse === null) {
            return {
                statusCode: 404,
                body: BackendAnalysisApi.error(
                    SERVER_ANALYSIS_FAILURE_CODE.JobNotFound,
                ),
            };
        }
        return BackendAnalysisApi.jobResponseResult(jobResponse);
    }

    /**
     * Completes a local fixture job with a deterministic terminal response.
     *
     * @param jobId - Local job id from a previous processing response.
     * @param raw - Untrusted fixture completion request body.
     * @returns Terminal job response or typed request/not-found error.
     */
    static handleFixtureCompletionRequest(
        jobId: string,
        raw: unknown,
    ): BackendApiResult {
        const parsed = v.safeParse(fixtureCompletionRequestSchema, raw);
        if (!parsed.success) {
            return {
                statusCode: 400,
                body: BackendAnalysisApi.error(
                    SERVER_ANALYSIS_FAILURE_CODE.InvalidRequest,
                ),
            };
        }

        const terminalResponse = BackendAnalysisJobs.completeFixture({
            jobId,
            status: parsed.output.status,
            nowMs: Date.now(),
        });
        if (terminalResponse === null) {
            return {
                statusCode: 404,
                body: BackendAnalysisApi.error(
                    SERVER_ANALYSIS_FAILURE_CODE.JobNotFound,
                ),
            };
        }
        return { statusCode: 200, body: terminalResponse };
    }

    /**
     * Maps processing and terminal job responses onto HTTP status codes.
     *
     * @param response - Current in-memory job response.
     * @returns HTTP API result for the response state.
     */
    private static jobResponseResult(
        response: ProcessingResponse | BackendAnalysisTerminalResponse,
    ): BackendApiResult {
        if (response.status === 'processing') {
            return { statusCode: 202, body: response };
        }
        return { statusCode: 200, body: response };
    }

    /**
     * Builds typed request errors for the backend contract.
     *
     * @param code - Stable API error code.
     * @param message - User-safe error summary.
     * @returns Validated error response.
     */
    private static error(
        code:
            | 'invalid_video_id'
            | 'invalid_request'
            | 'request_body_too_large'
            | 'job_not_found'
            | 'internal_error',
    ): ErrorResponse {
        return v.parse(errorResponseSchema, {
            status: 'error',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            error: { code },
        });
    }

    /**
     * Builds retryable responses for local cold-work throttling.
     *
     * @param retryAfterSec - Positive retry delay from the protection hook.
     * @param code - Stable quota or capacity failure code.
     * @returns Validated rate-limit response.
     */
    private static rateLimited(
        retryAfterSec: number,
        code: 'rate_limited' | 'capacity_limited',
    ): RateLimitedResponse {
        return v.parse(rateLimitedResponseSchema, {
            status: 'rate_limited',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            error: {
                code,
                retryAfterSec,
            },
        });
    }
}
