import * as v from 'valibot';

import {
    BACKEND_REQUEST_COST_CLASS,
    BackendApiProtection,
} from '@topskip/backend/api-protection';
import { AnalysisArtifactStore } from '@topskip/backend/analysis-artifact-store';
import {
    BackendAnalysisJobs,
    type BackendAnalysisJobResponse,
} from '@topskip/backend/analysis-jobs';
import { BackendCacheFixtures } from '@topskip/backend/cache-fixtures';
import {
    legacyServerAnalysisResponseSchema,
    legacyUnavailableResponseSchema,
    type LegacyServerAnalysisRequest,
    type LegacyServerAnalysisResponse,
} from '@topskip/backend/legacy/legacy-server-analysis-contract';
import { BackendServerAnalysisLog } from '@topskip/backend/server-analysis-log';
import {
    SERVER_ANALYSIS_ALGORITHM_VERSION,
    SERVER_ANALYSIS_FAILURE_CODE,
} from '@topskip/common/server-analysis-contract';

const MAX_VIDEO_DURATION_SEC = 5 * 60 * 60;
const CAPACITY_RETRY_AFTER_SEC = 3;

/**
 * Legacy orchestration returns only the private process-selected response contract.
 */
export type BackendLegacyAnalysisResult = {
    statusCode: 200 | 202 | 422 | 429;
    body: LegacyServerAnalysisResponse;
};

/**
 * Keeps metadata-only extraction isolated from the public caption-upload path; static API only.
 */
export class BackendLegacyServerAnalysis {
    /**
     * Runs cache, join, quota, and extraction admission for one validated legacy request.
     *
     * @param request - Private metadata request accepted by a legacy-mode process.
     * @param options - Hashed ownership context and deterministic request time.
     * @returns Private legacy response with its HTTP status.
     */
    static handle(
        request: LegacyServerAnalysisRequest,
        options: {
            nowMs: number;
            installationHash: string;
            ipHash: string;
            requestId?: string;
            publicContext: boolean;
        },
    ): BackendLegacyAnalysisResult {
        const cacheKey = {
            videoId: request.videoId,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        };
        const fixture = BackendCacheFixtures.findReady(cacheKey);
        if (fixture !== null) {
            BackendLegacyServerAnalysis.recordCacheHit(
                request.videoId,
                options.requestId,
                'seeded',
                options.nowMs,
            );
            return { statusCode: 200, body: fixture };
        }

        const artifact = AnalysisArtifactStore.findLatestLegacyCacheable(
            request.videoId,
            SERVER_ANALYSIS_ALGORITHM_VERSION,
        );
        if (
            artifact !== null &&
            (artifact.terminalResponse.status === 'ready' ||
                artifact.terminalResponse.status === 'no_promo')
        ) {
            BackendLegacyServerAnalysis.recordCacheHit(
                request.videoId,
                options.requestId,
                'artifact',
                options.nowMs,
            );
            return {
                statusCode: 200,
                body: BackendLegacyServerAnalysis.parseResponse(
                    artifact.terminalResponse,
                ),
            };
        }

        const existing = BackendAnalysisJobs.findExisting({
            source: 'legacy_yt_dlp',
            videoId: request.videoId,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            installationHash: options.installationHash,
        });
        if (existing !== null) {
            BackendApiProtection.evaluate({
                costClass: BACKEND_REQUEST_COST_CLASS.JobJoin,
                nowMs: options.nowMs,
            });
            BackendServerAnalysisLog.info('job-joined', {
                requestId: options.requestId,
                videoId: request.videoId,
                jobId:
                    existing.status === 'processing'
                        ? existing.jobId
                        : undefined,
            });
            return BackendLegacyServerAnalysis.jobResult(existing);
        }

        if (
            request.durationSec !== undefined &&
            request.durationSec > MAX_VIDEO_DURATION_SEC
        ) {
            return {
                statusCode: 422,
                body: v.parse(legacyUnavailableResponseSchema, {
                    status: 'unavailable',
                    videoId: request.videoId,
                    algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                    error: {
                        code: SERVER_ANALYSIS_FAILURE_CODE.VideoTooLong,
                    },
                }),
            };
        }

        if (!BackendAnalysisJobs.canAcceptColdJob()) {
            return BackendLegacyServerAnalysis.rateLimited(
                request.videoId,
                options.requestId,
                SERVER_ANALYSIS_FAILURE_CODE.CapacityLimited,
                CAPACITY_RETRY_AFTER_SEC,
            );
        }

        const protection = BackendApiProtection.evaluate({
            costClass: BACKEND_REQUEST_COST_CLASS.ColdJobStart,
            nowMs: options.nowMs,
            ...(options.publicContext
                ? {
                      installationHash: options.installationHash,
                      ipHash: options.ipHash,
                  }
                : {}),
        });
        if (!protection.allowed) {
            return BackendLegacyServerAnalysis.rateLimited(
                request.videoId,
                options.requestId,
                SERVER_ANALYSIS_FAILURE_CODE.RateLimited,
                protection.retryAfterSec,
            );
        }

        const response = BackendAnalysisJobs.start({
            source: 'legacy_yt_dlp',
            videoId: request.videoId,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            extensionVersion: request.extensionVersion,
            durationSec: request.durationSec,
            installationHash: options.installationHash,
            ipHash: options.ipHash,
            nowMs: options.nowMs,
            requestId: options.requestId,
        });
        BackendServerAnalysisLog.info('job-started', {
            requestId: options.requestId,
            videoId: request.videoId,
            jobId:
                response.status === 'processing' ? response.jobId : undefined,
            queueDepth: BackendAnalysisJobs.queueDepth(),
        });
        return BackendLegacyServerAnalysis.jobResult(response);
    }

    /**
     * Counts legacy cache work without spending cold-job admission.
     *
     * @param videoId - Validated legacy video identifier.
     * @param requestId - Safe request correlation identifier.
     * @param source - Stable cache source diagnostic.
     * @param nowMs - Deterministic quota timestamp.
     */
    private static recordCacheHit(
        videoId: string,
        requestId: string | undefined,
        source: 'seeded' | 'artifact',
        nowMs: number,
    ): void {
        BackendServerAnalysisLog.info('backend-cache-hit', {
            requestId,
            videoId,
            source,
        });
        BackendApiProtection.evaluate({
            costClass: BACKEND_REQUEST_COST_CLASS.CacheLookup,
            nowMs,
        });
    }

    /**
     * Maps a legacy job response to its asynchronous HTTP status.
     *
     * @param response - Source-tagged job response from the shared scheduler.
     * @returns Strict private response and matching HTTP status.
     */
    private static jobResult(
        response: BackendAnalysisJobResponse,
    ): BackendLegacyAnalysisResult {
        const body = BackendLegacyServerAnalysis.parseResponse(response);
        return {
            statusCode: body.status === 'processing' ? 202 : 200,
            body,
        };
    }

    /**
     * Rejects any accidental public upload shape at the private legacy boundary.
     *
     * @param response - Candidate job or artifact response.
     * @returns Strict private legacy response.
     */
    private static parseResponse(
        response: unknown,
    ): LegacyServerAnalysisResponse {
        return v.parse(legacyServerAnalysisResponseSchema, response);
    }

    /**
     * Builds a bounded retry response without leaking queue or quota internals.
     *
     * @param videoId - Validated request video used only for safe logging.
     * @param requestId - Safe request correlation identifier.
     * @param code - Stable capacity outcome.
     * @param retryAfterSec - Positive whole-second retry delay.
     * @returns Private retry response.
     */
    private static rateLimited(
        videoId: string,
        requestId: string | undefined,
        code: 'rate_limited' | 'capacity_limited',
        retryAfterSec: number,
    ): BackendLegacyAnalysisResult {
        BackendServerAnalysisLog.warn('job-rate-limited', {
            requestId,
            videoId,
            code,
            retryAfterSec,
            queueDepth: BackendAnalysisJobs.queueDepth(),
        });
        return {
            statusCode: 429,
            body: BackendLegacyServerAnalysis.parseResponse({
                status: 'rate_limited',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                error: { code, retryAfterSec },
            }),
        };
    }
}
