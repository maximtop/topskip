import { randomUUID } from 'node:crypto';
import * as v from 'valibot';

import {
    BACKEND_REQUEST_COST_CLASS,
    BackendApiProtection,
} from '@topskip/backend/api-protection';
import { AnalysisArtifactStore } from '@topskip/backend/analysis-artifact-store';
import {
    BackendAnalysisJobs,
    type BackendAnalysisJobResponse,
    type BackendAnalysisTerminalResponse,
    type ExactTranscriptIdentity,
} from '@topskip/backend/analysis-jobs';
import {
    BackendLegacyServerAnalysis,
    type BackendLegacyAnalysisResult,
} from '@topskip/backend/legacy/legacy-server-analysis';
import {
    legacyServerAnalysisResponseSchema,
    type LegacyServerAnalysisResponse,
} from '@topskip/backend/legacy/legacy-server-analysis-contract';
import { BackendServerAnalysisBoundary } from '@topskip/backend/server-analysis-boundary';
import { BackendServerAnalysisLog } from '@topskip/backend/server-analysis-log';
import {
    BACKEND_CAPTION_SOURCE,
    type BackendCaptionSource,
} from '@topskip/backend/server-config';
import { TranscriptFingerprint } from '@topskip/backend/transcript-fingerprint';
import {
    transcriptArtifactSchema,
    type TranscriptArtifact,
} from '@topskip/backend/extraction/subtitle-extraction-types';
import {
    CaptionTranscriptCanonicalizer,
    type CanonicalTranscriptFailureCode,
} from '@topskip/common/captions/canonical-transcript';
import {
    errorResponseSchema,
    identifiedRateLimitedResponseSchema,
    isValidYouTubeVideoId,
    serverAnalysisResponseEmissionSchema,
    SERVER_ANALYSIS_ALGORITHM_VERSION,
    SERVER_ANALYSIS_FAILURE_CODE,
    type ErrorResponse,
    type ServerAnalysisRequest,
    type ServerAnalysisResponse,
} from '@topskip/common/server-analysis-contract';

const LOCAL_INSTALLATION_HASH = 'local-development';
const LOCAL_IP_HASH = 'local-development';
const CAPACITY_RETRY_AFTER_SEC = 3;

const fixtureCompletionRequestSchema = v.strictObject({
    status: v.picklist(['ready', 'no_promo', 'unavailable', 'error'] as const),
});

/**
 * HTTP result shape returned before or during asynchronous backend analysis.
 */
export type BackendApiResult =
    | {
          statusCode: 200 | 202 | 400 | 403 | 404 | 422 | 429;
          body: ServerAnalysisResponse | LegacyServerAnalysisResponse;
      }
    | BackendLegacyAnalysisResult;

/**
 * Hashed request identities connect public quota and ownership checks without raw credentials.
 */
export type BackendAnalysisRequestContext = {
    installationHash: string;
    ipHash: string;
    requestId?: string;
};

/**
 * Owns process-selected analysis routing while keeping upload and legacy paths isolated; static API only.
 */
export class BackendAnalysisApi {
    /**
     * Returns minimal process health without disclosing runtime internals.
     *
     * @returns Typed health response.
     */
    static health(): { ok: true } {
        return { ok: true };
    }

    /**
     * Validates the selected request contract before cache lookup, joining, or cold work.
     *
     * @param raw - Untrusted JSON body from the HTTP server.
     * @param options - Deterministic clock, ownership context, and immutable source mode.
     * @returns Typed API result for the HTTP layer.
     */
    static handleAnalysisRequest(
        raw: unknown,
        options: {
            nowMs?: number;
            context?: BackendAnalysisRequestContext;
            captionSource?: BackendCaptionSource;
        } = {},
    ): BackendApiResult {
        const nowMs = options.nowMs ?? Date.now();
        const captionSource =
            options.captionSource ?? BACKEND_CAPTION_SOURCE.ExtensionUpload;

        if (BackendAnalysisApi.hasInvalidVideoId(raw)) {
            return {
                statusCode: 400,
                body: BackendAnalysisApi.error(
                    SERVER_ANALYSIS_FAILURE_CODE.InvalidVideoId,
                ),
            };
        }

        const parsed =
            BackendServerAnalysisBoundary.forSource(captionSource).parseRequest(
                raw,
            );
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
        if (captionSource === BACKEND_CAPTION_SOURCE.LegacyYtDlp) {
            if ('segments' in parsed.output) {
                return {
                    statusCode: 400,
                    body: BackendAnalysisApi.error(
                        SERVER_ANALYSIS_FAILURE_CODE.InvalidRequest,
                    ),
                };
            }
            return BackendLegacyServerAnalysis.handle(parsed.output, {
                nowMs,
                installationHash: context.installationHash,
                ipHash: context.ipHash,
                requestId: context.requestId,
                publicContext: options.context !== undefined,
            });
        }

        if (!('segments' in parsed.output)) {
            return {
                statusCode: 400,
                body: BackendAnalysisApi.error(
                    SERVER_ANALYSIS_FAILURE_CODE.InvalidRequest,
                ),
            };
        }
        return BackendAnalysisApi.handleUpload(parsed.output, {
            nowMs,
            context,
            publicContext: options.context !== undefined,
        });
    }

    /**
     * Reads one owner-authorized in-memory response without inferring its process mode.
     *
     * @param jobId - Opaque job id from a previous processing response.
     * @param options - Optional deterministic clock and installation ownership hash.
     * @returns Current job state or typed not-found error.
     */
    static handleJobStatusRequest(
        jobId: string,
        options: {
            nowMs?: number;
            installationHash?: string;
        } = {},
    ): BackendApiResult {
        const response = BackendAnalysisJobs.getStatus(jobId, {
            nowMs: options.nowMs,
            ownerInstallationHash:
                options.installationHash ?? LOCAL_INSTALLATION_HASH,
        });
        if (response === null) {
            return {
                statusCode: 404,
                body: BackendAnalysisApi.error(
                    SERVER_ANALYSIS_FAILURE_CODE.JobNotFound,
                ),
            };
        }
        return BackendAnalysisApi.jobResponseResult(response);
    }

    /**
     * Completes a local fixture job while retaining the record's own response identity.
     *
     * @param jobId - Opaque job id from a previous processing response.
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

        const response = BackendAnalysisJobs.completeFixture({
            jobId,
            status: parsed.output.status,
            nowMs: Date.now(),
        });
        if (response === null) {
            return {
                statusCode: 404,
                body: BackendAnalysisApi.error(
                    SERVER_ANALYSIS_FAILURE_CODE.JobNotFound,
                ),
            };
        }
        return BackendAnalysisApi.jobResponseResult(response);
    }

    /**
     * Canonicalizes one accepted upload and routes its authoritative identity through exact reuse.
     *
     * @param request - Strict public upload request.
     * @param options - Hashed ownership and deterministic request metadata.
     * @returns Exact cache, join, admission, or new-job response.
     */
    private static handleUpload(
        request: ServerAnalysisRequest,
        options: {
            nowMs: number;
            context: BackendAnalysisRequestContext;
            publicContext: boolean;
        },
    ): BackendApiResult {
        const canonical = CaptionTranscriptCanonicalizer.canonicalize({
            languageCode: request.languageCode,
            segments: request.segments,
        });
        if (!canonical.ok) {
            return BackendAnalysisApi.canonicalFailure(canonical.code);
        }

        const transcriptHash = TranscriptFingerprint.sha256Hex(
            canonical.transcript.canonicalBytes,
        );
        const identity: ExactTranscriptIdentity = {
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            videoId: request.videoId,
            languageCode: canonical.transcript.languageCode,
            transcriptHash,
        };
        const transcriptArtifact = BackendAnalysisApi.buildUploadArtifact({
            request,
            identity,
            canonical: canonical.transcript,
            nowMs: options.nowMs,
        });

        const artifact =
            AnalysisArtifactStore.findLatestCacheableExact(identity);
        if (artifact !== null) {
            BackendServerAnalysisLog.info('backend-cache-hit', {
                requestId: options.context.requestId,
                videoId: identity.videoId,
                languageCode: identity.languageCode,
                source: 'artifact',
            });
            BackendApiProtection.evaluate({
                costClass: BACKEND_REQUEST_COST_CLASS.CacheLookup,
                nowMs: options.nowMs,
            });
            return BackendAnalysisApi.uploadResponseResult(
                identity,
                artifact.terminalResponse,
                200,
            );
        }

        const existing = BackendAnalysisJobs.findExisting({
            source: 'extension_upload',
            identity,
            installationHash: options.context.installationHash,
        });
        if (existing !== null) {
            BackendApiProtection.evaluate({
                costClass: BACKEND_REQUEST_COST_CLASS.JobJoin,
                nowMs: options.nowMs,
            });
            BackendServerAnalysisLog.info('job-joined', {
                requestId: options.context.requestId,
                videoId: identity.videoId,
                languageCode: identity.languageCode,
                jobId:
                    existing.status === 'processing'
                        ? existing.jobId
                        : undefined,
            });
            return BackendAnalysisApi.uploadResponseResult(
                identity,
                existing,
                existing.status === 'processing' ? 202 : 200,
            );
        }

        if (!BackendAnalysisJobs.canAcceptColdJob()) {
            return BackendAnalysisApi.identifiedRateLimited(
                identity,
                SERVER_ANALYSIS_FAILURE_CODE.CapacityLimited,
                CAPACITY_RETRY_AFTER_SEC,
                options.context.requestId,
            );
        }

        const protection = BackendApiProtection.evaluate({
            costClass: BACKEND_REQUEST_COST_CLASS.ColdJobStart,
            nowMs: options.nowMs,
            ...(options.publicContext
                ? {
                      installationHash: options.context.installationHash,
                      ipHash: options.context.ipHash,
                  }
                : {}),
        });
        if (!protection.allowed) {
            return BackendAnalysisApi.identifiedRateLimited(
                identity,
                SERVER_ANALYSIS_FAILURE_CODE.RateLimited,
                protection.retryAfterSec,
                options.context.requestId,
            );
        }

        const response = BackendAnalysisJobs.start({
            source: 'extension_upload',
            identity,
            transcriptArtifact,
            installationHash: options.context.installationHash,
            ipHash: options.context.ipHash,
            nowMs: options.nowMs,
            extensionVersion: request.extensionVersion,
            durationSec: request.durationSec,
            requestId: options.context.requestId,
        });
        BackendServerAnalysisLog.info('job-started', {
            requestId: options.context.requestId,
            videoId: identity.videoId,
            languageCode: identity.languageCode,
            jobId:
                response.status === 'processing' ? response.jobId : undefined,
            queueDepth: BackendAnalysisJobs.queueDepth(),
        });
        return BackendAnalysisApi.uploadResponseResult(
            identity,
            response,
            response.status === 'processing' ? 202 : 200,
        );
    }

    /**
     * Builds the only transcript artifact allowed to enter default-mode model analysis.
     *
     * @param input - Canonical request data and its authoritative identity.
     * @returns Strict canonical extension-caption artifact.
     */
    private static buildUploadArtifact(input: {
        request: ServerAnalysisRequest;
        identity: ExactTranscriptIdentity;
        canonical: {
            languageCode: string;
            segments: ServerAnalysisRequest['segments'];
            timelineEndSec: number;
        };
        nowMs: number;
    }): TranscriptArtifact {
        return v.parse(transcriptArtifactSchema, {
            artifactId: `transcript-${randomUUID()}`,
            videoId: input.identity.videoId,
            algorithmVersion: input.identity.algorithmVersion,
            strategy: 'extension_caption_upload',
            sourceType: 'extension_caption_upload',
            languageCode: input.identity.languageCode,
            transcriptHash: input.identity.transcriptHash,
            videoDurationSec: input.canonical.timelineEndSec,
            acquiredAtMs: Math.max(1, Math.trunc(input.nowMs)),
            segments: input.canonical.segments,
            transcriptText: input.canonical.segments
                .map((segment) => segment.text)
                .join(' '),
        });
    }

    /**
     * Validates every transcript-bound response against one stored authoritative identity.
     *
     * @param identity - Exact identity computed from canonical server input.
     * @param response - Candidate cache or in-memory job response.
     * @param statusCode - HTTP status selected by the orchestration state.
     * @returns Strict public response with no request-echo identity fields.
     */
    private static uploadResponseResult(
        identity: ExactTranscriptIdentity,
        response: unknown,
        statusCode: 200 | 202,
    ): BackendApiResult {
        const body = v.parse(serverAnalysisResponseEmissionSchema, response);
        if (
            !('videoId' in body) ||
            !('languageCode' in body) ||
            !('transcriptHash' in body) ||
            body.videoId !== identity.videoId ||
            body.algorithmVersion !== identity.algorithmVersion ||
            body.languageCode !== identity.languageCode ||
            body.transcriptHash !== identity.transcriptHash
        ) {
            throw new Error(
                'Upload response does not match its authoritative transcript identity.',
            );
        }
        return { statusCode, body };
    }

    /**
     * Parses source-tagged polling output without allowing one contract into the other mode.
     *
     * @param response - Current response from an owner-authorized job.
     * @returns Strict response and matching asynchronous HTTP status.
     */
    private static jobResponseResult(
        response: BackendAnalysisJobResponse | BackendAnalysisTerminalResponse,
    ): BackendApiResult {
        const body =
            'languageCode' in response && 'transcriptHash' in response
                ? v.parse(serverAnalysisResponseEmissionSchema, response)
                : v.parse(legacyServerAnalysisResponseSchema, response);
        return {
            statusCode: body.status === 'processing' ? 202 : 200,
            body,
        };
    }

    /**
     * Builds a transcript-bound retry response after canonical identity exists.
     *
     * @param identity - Authoritative identity that reached admission.
     * @param code - Stable quota or capacity outcome.
     * @param retryAfterSec - Positive whole-second retry delay.
     * @param requestId - Safe request correlation identifier.
     * @returns Strict identified retry result.
     */
    private static identifiedRateLimited(
        identity: ExactTranscriptIdentity,
        code: 'rate_limited' | 'capacity_limited',
        retryAfterSec: number,
        requestId: string | undefined,
    ): BackendApiResult {
        BackendServerAnalysisLog.warn('job-rate-limited', {
            requestId,
            videoId: identity.videoId,
            languageCode: identity.languageCode,
            code,
            retryAfterSec,
            queueDepth: BackendAnalysisJobs.queueDepth(),
        });
        return {
            statusCode: 429,
            body: v.parse(identifiedRateLimitedResponseSchema, {
                status: 'rate_limited',
                ...identity,
                error: { code, retryAfterSec },
            }),
        };
    }

    /**
     * Maps canonical validation limits before any reusable identity or model work exists.
     *
     * @param code - Stable canonicalization failure.
     * @returns Safe pre-identity validation response.
     */
    private static canonicalFailure(
        code: CanonicalTranscriptFailureCode,
    ): BackendApiResult {
        const statusCode = code === 'invalid_request' ? 400 : 422;
        return {
            statusCode,
            body: BackendAnalysisApi.error(code),
        };
    }

    /**
     * Builds safe failures that occur before a transcript identity can be trusted.
     *
     * @param code - Stable public failure code allowed before identity construction.
     * @returns Strict pre-identity error response.
     */
    private static error(
        code:
            | 'invalid_video_id'
            | 'invalid_request'
            | 'request_body_too_large'
            | 'job_not_found'
            | 'internal_error'
            | CanonicalTranscriptFailureCode,
    ): ErrorResponse {
        return v.parse(errorResponseSchema, {
            status: 'error',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            error: { code },
        });
    }

    /**
     * Preserves the specific invalid-video outcome without reading other untrusted fields.
     *
     * @param raw - Untrusted request candidate.
     * @returns Whether a present string video id violates the public identifier shape.
     */
    private static hasInvalidVideoId(raw: unknown): boolean {
        return (
            raw !== null &&
            typeof raw === 'object' &&
            'videoId' in raw &&
            typeof raw.videoId === 'string' &&
            !isValidYouTubeVideoId(raw.videoId)
        );
    }
}
