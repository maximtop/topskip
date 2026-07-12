import * as v from 'valibot';

import {
    BACKEND_REQUEST_COST_CLASS,
    BackendApiProtection,
} from '@/backend/api-protection';
import { AnalysisArtifactStore } from '@/backend/analysis-artifact-store';
import {
    BackendAnalysisJobs,
    type BackendAnalysisTerminalResponse,
} from '@/backend/analysis-jobs';
import { BackendCacheFixtures } from '@/backend/cache-fixtures';
import {
    errorResponseSchema,
    isValidYouTubeVideoId,
    rateLimitedResponseSchema,
    serverAnalysisRequestSchema,
    type ErrorResponse,
    type ProcessingResponse,
    type RateLimitedResponse,
} from '@/shared/server-analysis-contract';

const JOB_NOT_FOUND_MESSAGE = 'Analysis job was not found.';
const INVALID_FIXTURE_COMPLETION_MESSAGE =
    'Invalid fixture completion request.';
const RATE_LIMITED_MESSAGE = 'Local cold-analysis limit reached. Retry later.';

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
    | { statusCode: 429; body: RateLimitedResponse };

/**
 * Pure local API behavior for validation and deterministic processing states;
 * static API only.
 */
export class BackendAnalysisApi {
    /**
     * Returns process metadata for local development health checks.
     *
     * @param version - Backend version string exposed to the extension.
     * @returns Typed health response.
     */
    static health(version: string): {
        ok: true;
        service: 'topskip-backend';
        version: string;
    } {
        return { ok: true, service: 'topskip-backend', version };
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
        options: { nowMs?: number } = {},
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
                    'invalid_video_id',
                    'Invalid YouTube video id.',
                ),
            };
        }

        const parsed = v.safeParse(serverAnalysisRequestSchema, raw);
        if (!parsed.success) {
            return {
                statusCode: 400,
                body: BackendAnalysisApi.error(
                    'invalid_request',
                    'Invalid analysis request.',
                ),
            };
        }

        const ready = BackendCacheFixtures.findReady({
            videoId: parsed.output.videoId,
            algorithmVersion: parsed.output.algorithmVersion,
        });
        if (ready !== null) {
            BackendApiProtection.evaluate({
                costClass: BACKEND_REQUEST_COST_CLASS.CacheLookup,
                nowMs,
            });
            return { statusCode: 200, body: ready };
        }

        const artifactReady = AnalysisArtifactStore.findLatestReady({
            videoId: parsed.output.videoId,
            algorithmVersion: parsed.output.algorithmVersion,
        });
        if (artifactReady !== null) {
            BackendApiProtection.evaluate({
                costClass: BACKEND_REQUEST_COST_CLASS.CacheLookup,
                nowMs,
            });
            return { statusCode: 200, body: artifactReady.terminalResponse };
        }

        const existingJob = BackendAnalysisJobs.findExisting({
            videoId: parsed.output.videoId,
            algorithmVersion: parsed.output.algorithmVersion,
        });
        if (existingJob !== null) {
            BackendApiProtection.evaluate({
                costClass: BACKEND_REQUEST_COST_CLASS.JobJoin,
                nowMs,
            });
            return BackendAnalysisApi.jobResponseResult(existingJob);
        }

        const protection = BackendApiProtection.evaluate({
            costClass: BACKEND_REQUEST_COST_CLASS.ColdJobStart,
            nowMs,
        });
        if (!protection.allowed) {
            return {
                statusCode: 429,
                body: BackendAnalysisApi.rateLimited(protection.retryAfterSec),
            };
        }

        const jobResponse = BackendAnalysisJobs.start({
            videoId: parsed.output.videoId,
            algorithmVersion: parsed.output.algorithmVersion,
            durationSec: parsed.output.durationSec,
            nowMs,
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
        options: { nowMs?: number } = {},
    ): BackendApiResult {
        const jobResponse = BackendAnalysisJobs.getStatus(jobId, options);
        if (jobResponse === null) {
            return {
                statusCode: 404,
                body: BackendAnalysisApi.error(
                    'job_not_found',
                    JOB_NOT_FOUND_MESSAGE,
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
                    'invalid_request',
                    INVALID_FIXTURE_COMPLETION_MESSAGE,
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
                    'job_not_found',
                    JOB_NOT_FOUND_MESSAGE,
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
            | 'job_not_found',
        message: string,
    ): ErrorResponse {
        return v.parse(errorResponseSchema, {
            status: 'invalid_request',
            error: { code, message },
        });
    }

    /**
     * Builds retryable responses for local cold-work throttling.
     *
     * @param retryAfterSec - Positive retry delay from the protection hook.
     * @returns Validated rate-limit response.
     */
    private static rateLimited(retryAfterSec: number): RateLimitedResponse {
        return v.parse(rateLimitedResponseSchema, {
            status: 'rate_limited',
            retryAfterSec,
            error: {
                code: 'rate_limited',
                message: RATE_LIMITED_MESSAGE,
            },
        });
    }
}
