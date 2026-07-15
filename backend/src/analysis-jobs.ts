import * as v from 'valibot';
import { randomUUID } from 'node:crypto';

import { AnalysisArtifactStore } from '@topskip/backend/analysis-artifact-store';
import { BackendPromoAnalysisWorker } from '@topskip/backend/analysis/promo-analysis-worker';
import type {
    AnalysisRunArtifact,
    BackendLlmAnalysisAdapter,
} from '@topskip/backend/analysis/promo-analysis-types';
import {
    noPromoResponseSchema,
    processingResponseSchema,
    readyResponseSchema,
    SERVER_ANALYSIS_ERROR_CODE,
    SERVER_ANALYSIS_UNAVAILABLE_REASON,
    terminalErrorResponseSchema,
    unavailableResponseSchema,
    type NoPromoResponse,
    type ProcessingResponse,
    type ReadyResponse,
    type ServerAnalysisFailureCode,
    type TerminalErrorResponse,
    type UnavailableResponse,
} from '@topskip/common/server-analysis-contract';
import { BackendSubtitleExtractionPipeline } from '@topskip/backend/extraction/subtitle-extraction-pipeline';
import {
    type SubtitleExtractionAttempt,
    type SubtitleExtractionStrategy,
    type TranscriptArtifact,
} from '@topskip/backend/extraction/subtitle-extraction-types';
import { BackendServerAnalysisLog } from '@topskip/backend/server-analysis-log';
import { BackendPublicState } from '@topskip/backend/public-state';

const DEFAULT_POLL_AFTER_SEC = 3;
const FIXTURE_RESULT_EXPIRES_AT_MS = 4_102_444_800_000;
const TERMINAL_JOB_RETENTION_MS = 5 * 60 * 1_000;
const MAX_ACTIVE_COLD_JOBS = 2;
const MAX_QUEUED_COLD_JOBS = 10;
const MAX_VIDEO_DURATION_SEC = 5 * 60 * 60;
const FAILURE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const LOCAL_INSTALLATION_HASH = 'local-development';

const ANALYSIS_JOB_STAGE = {
    Queued: 'queued',
    Extracting: 'extracting',
    AwaitingAnalysis: 'awaiting_analysis',
    Analyzing: 'analyzing',
    Complete: 'complete',
} as const;

/**
 * Job stages make cold-work progress inspectable without exposing internals over HTTP.
 */
type AnalysisJobStage =
    (typeof ANALYSIS_JOB_STAGE)[keyof typeof ANALYSIS_JOB_STAGE];

/**
 * Terminal fixture states supported by the local deterministic completion hook.
 */
export type FixtureCompletionStatus =
    | 'ready'
    | 'no_promo'
    | 'unavailable'
    | 'error';

/**
 * Terminal response shapes that stop content-script polling.
 */
export type BackendAnalysisTerminalResponse =
    | ReadyResponse
    | NoPromoResponse
    | UnavailableResponse
    | TerminalErrorResponse;

/**
 * Any response a stored local job can currently expose.
 */
export type BackendAnalysisJobResponse =
    | ProcessingResponse
    | BackendAnalysisTerminalResponse;

/**
 * Stable test-only diagnostics for proving extraction side effects.
 */
type AnalysisJobDiagnostics = {
    stage: AnalysisJobStage;
    extractionAttempts: SubtitleExtractionAttempt[];
    selectedTranscriptArtifact: TranscriptArtifact | null;
    analysisRun: AnalysisRunArtifact | null;
    completedAtMs: number | null;
    terminalStatus: BackendAnalysisTerminalResponse['status'] | null;
    joinedRequestCount: number;
};

/**
 * Internal in-memory record keyed by video id and algorithm version.
 */
type AnalysisJobRecord = {
    jobId: string;
    jobKey: string;
    videoId: string;
    algorithmVersion: string;
    durationSec: number | undefined;
    pollAfterSec: number;
    createdAtMs: number;
    completedAtMs: number | null;
    retryCount: number;
    joinedRequestCount: number;
    stage: AnalysisJobStage;
    extractionAttempts: SubtitleExtractionAttempt[];
    selectedTranscriptArtifact: TranscriptArtifact | null;
    analysisRun: AnalysisRunArtifact | null;
    analysisAdapter: BackendLlmAnalysisAdapter | undefined;
    extractionStrategies: readonly SubtitleExtractionStrategy[] | undefined;
    ownerInstallationHashes: Set<string>;
    requestId: string | undefined;
    processingResponse: ProcessingResponse;
    terminalResponse: BackendAnalysisTerminalResponse | null;
    extractionPromise: Promise<void> | null;
};

/**
 * Owns local cold-miss jobs for the development backend; static API only.
 */
export class BackendAnalysisJobs {
    /**
     * Pollable job records by deterministic local job id.
     */
    private static readonly jobsById = new Map<string, AnalysisJobRecord>();

    /**
     * Dedupe index that enforces one job per video and algorithm version.
     */
    private static readonly jobIdsByKey = new Map<string, string>();

    /**
     * Active extraction/model jobs are capped independently of cheap cache and join work.
     */
    private static activeJobCount = 0;

    /**
     * Bounded queued starters avoid detached work growing without limit.
     */
    private static readonly queuedJobStarts: Array<() => void> = [];

    /**
     * Reports whether another cold job can be admitted without overflowing the queue.
     *
     * @returns Whether capacity remains for immediate or queued work.
     */
    static canAcceptColdJob(): boolean {
        return (
            BackendAnalysisJobs.queuedJobStarts.length < MAX_QUEUED_COLD_JOBS
        );
    }

    /**
     * Exposes bounded queue depth for operational logging and capacity responses.
     *
     * @returns Number of admitted cold jobs waiting to start.
     */
    static queueDepth(): number {
        return BackendAnalysisJobs.queuedJobStarts.length;
    }

    /**
     * Starts or joins a local job for a cold server-analysis miss.
     *
     * @param input - Validated video/version key and creation timestamp.
     * @returns Existing or newly created processing/terminal response.
     */
    static start(input: {
        videoId: string;
        algorithmVersion: string;
        durationSec?: number;
        nowMs: number;
        analysisAdapter?: BackendLlmAnalysisAdapter;
        extractionStrategies?: readonly SubtitleExtractionStrategy[];
        ownerInstallationHash?: string;
        requestId?: string;
    }): BackendAnalysisJobResponse {
        BackendAnalysisJobs.pruneTerminalJobs(input.nowMs);
        const jobKey = BackendAnalysisJobs.buildJobKey(input);
        const existingJobId = BackendAnalysisJobs.jobIdsByKey.get(jobKey);
        if (existingJobId !== undefined) {
            const existing = BackendAnalysisJobs.jobsById.get(existingJobId);
            if (existing !== undefined && existing.terminalResponse === null) {
                existing.joinedRequestCount += 1;
                return existing.processingResponse;
            }
            BackendAnalysisJobs.jobsById.delete(existingJobId);
            BackendAnalysisJobs.jobIdsByKey.delete(jobKey);
        }

        const jobId = BackendAnalysisJobs.buildJobId(input);
        const processingResponse = v.parse(processingResponseSchema, {
            status: 'processing',
            videoId: input.videoId,
            algorithmVersion: input.algorithmVersion,
            jobId,
            pollAfterSec: DEFAULT_POLL_AFTER_SEC,
        });
        const record: AnalysisJobRecord = {
            jobId,
            jobKey,
            videoId: input.videoId,
            algorithmVersion: input.algorithmVersion,
            durationSec: input.durationSec,
            pollAfterSec: DEFAULT_POLL_AFTER_SEC,
            createdAtMs: input.nowMs,
            completedAtMs: null,
            retryCount: 0,
            joinedRequestCount: 0,
            stage: ANALYSIS_JOB_STAGE.Queued,
            extractionAttempts: [],
            selectedTranscriptArtifact: null,
            analysisRun: null,
            analysisAdapter: input.analysisAdapter,
            extractionStrategies: input.extractionStrategies,
            ownerInstallationHashes: new Set([
                input.ownerInstallationHash ?? LOCAL_INSTALLATION_HASH,
            ]),
            requestId: input.requestId,
            processingResponse,
            terminalResponse: null,
            extractionPromise: null,
        };

        BackendAnalysisJobs.jobsById.set(jobId, record);
        BackendAnalysisJobs.jobIdsByKey.set(jobKey, jobId);
        record.extractionPromise = BackendAnalysisJobs.scheduleJob(
            record,
            input.nowMs,
        );
        return record.processingResponse;
    }

    /**
     * Looks up an existing job by the dedupe key without creating work.
     *
     * @param input - Validated video/version key.
     * @returns Current job response, or `null` when no job exists.
     */
    static findExisting(input: {
        videoId: string;
        algorithmVersion: string;
        installationHash?: string;
    }): BackendAnalysisJobResponse | null {
        const jobKey = BackendAnalysisJobs.buildJobKey(input);
        const jobId = BackendAnalysisJobs.jobIdsByKey.get(jobKey);
        if (jobId === undefined) {
            return null;
        }

        const record = BackendAnalysisJobs.jobsById.get(jobId);
        if (record === undefined) {
            return null;
        }
        record.ownerInstallationHashes.add(
            input.installationHash ?? LOCAL_INSTALLATION_HASH,
        );
        record.joinedRequestCount += 1;

        // Durable artifact lookup owns reusable terminal results. The in-memory
        // dedupe index is deliberately limited to active work so expired results
        // cannot keep suppressing a new analysis.
        return record.terminalResponse === null
            ? record.processingResponse
            : null;
    }

    /**
     * Reads a processing or terminal response for an existing local job.
     *
     * @param jobId - Deterministic local job id returned by `start`.
     * @param options - Optional deterministic clock used by tests.
     * @returns Current job response, or `null` when unknown.
     */
    static getStatus(
        jobId: string,
        options: {
            nowMs?: number;
            ownerInstallationHash?: string;
        } = {},
    ): BackendAnalysisJobResponse | null {
        void options;
        const record = BackendAnalysisJobs.jobsById.get(jobId);
        if (record === undefined) {
            return null;
        }
        if (
            !record.ownerInstallationHashes.has(
                options.ownerInstallationHash ?? LOCAL_INSTALLATION_HASH,
            )
        ) {
            return null;
        }
        if (record.terminalResponse !== null) {
            return record.terminalResponse;
        }

        return record.processingResponse;
    }

    /**
     * Moves a local job to a deterministic terminal fixture state.
     *
     * @param input - Job id, requested terminal state, and completion timestamp.
     * @returns Terminal response, or `null` when the job id is unknown.
     */
    static completeFixture(input: {
        jobId: string;
        status: FixtureCompletionStatus;
        nowMs: number;
    }): BackendAnalysisTerminalResponse | null {
        const record = BackendAnalysisJobs.jobsById.get(input.jobId);
        if (record === undefined) {
            return null;
        }
        if (record.terminalResponse !== null) {
            return record.terminalResponse;
        }

        const terminalResponse =
            BackendAnalysisJobs.buildFixtureTerminalResponse(record, input);
        record.completedAtMs = input.nowMs;
        record.stage = ANALYSIS_JOB_STAGE.Complete;
        record.terminalResponse = terminalResponse;
        BackendAnalysisJobs.persistArtifactRecordIfValid(record, input.nowMs);
        return terminalResponse;
    }

    /**
     * Clears process-local jobs so unit tests stay independent.
     */
    static resetForTests(): void {
        BackendAnalysisJobs.jobsById.clear();
        BackendAnalysisJobs.jobIdsByKey.clear();
        BackendAnalysisJobs.queuedJobStarts.splice(0);
        BackendAnalysisJobs.activeJobCount = 0;
    }

    /**
     * Exposes stable diagnostics for tests that prove lookup has no side effects.
     *
     * @returns Current in-memory job count.
     */
    static snapshotForTests(): {
        jobCount: number;
        activeJobCount: number;
        queuedJobCount: number;
    } {
        return {
            jobCount: BackendAnalysisJobs.jobsById.size,
            activeJobCount: BackendAnalysisJobs.activeJobCount,
            queuedJobCount: BackendAnalysisJobs.queuedJobStarts.length,
        };
    }

    /**
     * Exposes extraction diagnostics without adding them to the HTTP contract.
     *
     * @param jobId - Deterministic local job id returned by `start`.
     * @returns Test diagnostics for the job, or `null` when unknown.
     */
    static getDiagnosticsForTests(
        jobId: string,
    ): AnalysisJobDiagnostics | null {
        const record = BackendAnalysisJobs.jobsById.get(jobId);
        if (record === undefined) {
            return null;
        }

        return {
            stage: record.stage,
            extractionAttempts: record.extractionAttempts,
            selectedTranscriptArtifact: record.selectedTranscriptArtifact,
            analysisRun: record.analysisRun,
            completedAtMs: record.completedAtMs,
            terminalStatus: record.terminalResponse?.status ?? null,
            joinedRequestCount: record.joinedRequestCount,
        };
    }

    /**
     * Waits for background extraction in tests without exposing work details to the HTTP API.
     *
     * @param jobId - Local job identifier returned by a processing response.
     * @returns Current job response after extraction, or `null` for an unknown job.
     */
    static async waitForExtractionForTests(
        jobId: string,
    ): Promise<BackendAnalysisJobResponse | null> {
        const record = BackendAnalysisJobs.jobsById.get(jobId);
        if (record === undefined) {
            return null;
        }
        await record.extractionPromise;
        return record.terminalResponse ?? record.processingResponse;
    }

    /**
     * Runs subtitle extraction once for a newly stored job record.
     *
     * @param record - New in-memory job record to update.
     * @param nowMs - Deterministic extraction timestamp.
     * @returns Processing response when extraction succeeds, otherwise terminal unavailable.
     */
    private static async runJob(
        record: AnalysisJobRecord,
        nowMs: number,
    ): Promise<void> {
        try {
            if (record.terminalResponse !== null) {
                return;
            }
            record.stage = ANALYSIS_JOB_STAGE.Extracting;
            BackendServerAnalysisLog.info('extraction-started', {
                requestId: record.requestId,
                videoId: record.videoId,
                jobId: record.jobId,
            });
            const extraction = await BackendSubtitleExtractionPipeline.extract({
                videoId: record.videoId,
                algorithmVersion: record.algorithmVersion,
                nowMs,
                strategies: record.extractionStrategies,
            });
            if (record.terminalResponse !== null) {
                return;
            }
            record.extractionAttempts = extraction.attempts;

            if (extraction.status === 'selected') {
                const durationFailureCode =
                    BackendAnalysisJobs.authoritativeDurationFailureCode(
                        extraction.artifact,
                    );
                if (durationFailureCode !== null) {
                    record.selectedTranscriptArtifact = null;
                    BackendAnalysisJobs.completeUnavailable(
                        record,
                        durationFailureCode,
                        nowMs,
                    );
                    BackendServerAnalysisLog.warn('extraction-unavailable', {
                        requestId: record.requestId,
                        videoId: record.videoId,
                        jobId: record.jobId,
                        code: durationFailureCode,
                        attemptCount: extraction.attempts.length,
                        supportId:
                            BackendAnalysisJobs.readTerminalSupportId(record),
                    });
                    return;
                }
                BackendServerAnalysisLog.info('extraction-selected', {
                    requestId: record.requestId,
                    videoId: record.videoId,
                    jobId: record.jobId,
                    strategy: extraction.artifact.strategy,
                    segmentCount: extraction.artifact.segments.length,
                });
                record.stage = ANALYSIS_JOB_STAGE.AwaitingAnalysis;
                record.selectedTranscriptArtifact = extraction.artifact;
                record.durationSec =
                    extraction.artifact.videoDurationSec ?? record.durationSec;
                await BackendAnalysisJobs.runAnalysis(record, Date.now());
                return;
            }

            BackendAnalysisJobs.completeUnavailable(
                record,
                extraction.code,
                nowMs,
            );
            BackendServerAnalysisLog.warn('extraction-unavailable', {
                requestId: record.requestId,
                videoId: record.videoId,
                jobId: record.jobId,
                code: extraction.code,
                attemptCount: extraction.attempts.length,
                supportId: BackendAnalysisJobs.readTerminalSupportId(record),
            });
        } catch {
            BackendAnalysisJobs.completeUnexpectedFailure(record, Date.now());
            BackendServerAnalysisLog.warn('job-failed', {
                requestId: record.requestId,
                videoId: record.videoId,
                jobId: record.jobId,
                code: 'unexpected-error',
            });
        }
    }

    /**
     * Runs model analysis once for jobs that already selected a transcript.
     *
     * @param record - In-memory job record to complete.
     * @param nowMs - Deterministic analysis timestamp.
     * @returns Terminal worker response.
     */
    private static async runAnalysis(
        record: AnalysisJobRecord,
        nowMs: number,
    ): Promise<BackendAnalysisTerminalResponse> {
        if (record.terminalResponse !== null) {
            return record.terminalResponse;
        }
        if (record.selectedTranscriptArtifact === null) {
            throw new Error(
                'Cannot analyze a job without a selected transcript.',
            );
        }

        record.stage = ANALYSIS_JOB_STAGE.Analyzing;
        BackendServerAnalysisLog.info('model-analysis-started', {
            requestId: record.requestId,
            videoId: record.videoId,
            jobId: record.jobId,
        });
        const reservation =
            process.env.NODE_ENV === 'test'
                ? { reservationId: 'test-budget', reservedUsd: 0.35 }
                : BackendPublicState.reserveModelBudget({ nowMs });
        if (reservation === null) {
            record.completedAtMs = nowMs;
            record.stage = ANALYSIS_JOB_STAGE.Complete;
            record.terminalResponse = v.parse(terminalErrorResponseSchema, {
                status: 'error',
                videoId: record.videoId,
                algorithmVersion: record.algorithmVersion,
                error: {
                    code: SERVER_ANALYSIS_ERROR_CODE.BudgetExhausted,
                },
            });
            BackendAnalysisJobs.persistArtifactRecordSafely(record, nowMs);
            return record.terminalResponse;
        }
        let result:
            | Awaited<ReturnType<typeof BackendPromoAnalysisWorker.analyze>>
            | undefined;
        try {
            result = await BackendPromoAnalysisWorker.analyze({
                transcriptArtifact: record.selectedTranscriptArtifact,
                durationSec: record.durationSec,
                nowMs,
                adapter: record.analysisAdapter,
            });
        } finally {
            if (process.env.NODE_ENV !== 'test') {
                try {
                    BackendPublicState.settleModelBudget({
                        reservationId: reservation.reservationId,
                        costUsd: result?.analysisRun.usage?.costUsd,
                    });
                } catch {
                    // Crash reconciliation charges the full stale reserve later;
                    // persistence failures must not keep this job processing.
                }
            }
        }
        if (result === undefined) {
            throw new Error('Model analysis did not return a result.');
        }
        record.analysisRun = result.analysisRun;
        record.terminalResponse = result.terminalResponse;
        record.completedAtMs = result.analysisRun.completedAtMs;
        record.stage = ANALYSIS_JOB_STAGE.Complete;
        if (record.terminalResponse.status === 'error') {
            BackendAnalysisJobs.attachSupportIdSafely(
                record,
                record.terminalResponse.error.code,
                result.analysisRun.completedAtMs,
            );
        }
        BackendServerAnalysisLog.info('analysis-completed', {
            requestId: record.requestId,
            videoId: record.videoId,
            jobId: record.jobId,
            status: record.terminalResponse.status,
            provider: result.analysisRun.provider,
            model: result.analysisRun.model,
            inputTokens: result.analysisRun.usage?.inputTokens,
            outputTokens: result.analysisRun.usage?.outputTokens,
            costUsd: result.analysisRun.usage?.costUsd,
            supportId:
                record.terminalResponse.status === 'error'
                    ? record.terminalResponse.error.supportId
                    : undefined,
        });
        BackendAnalysisJobs.persistArtifactRecordSafely(
            record,
            result.analysisRun.completedAtMs,
        );
        return record.terminalResponse;
    }

    /**
     * Saves terminal fixture records only when they represent valid history.
     *
     * @param record - Completed job record.
     * @param completedAtMs - Completion timestamp.
     */
    private static persistArtifactRecordIfValid(
        record: AnalysisJobRecord,
        completedAtMs: number,
    ): void {
        if (record.terminalResponse === null) {
            return;
        }
        if (
            record.terminalResponse.status === 'ready' &&
            (record.selectedTranscriptArtifact === null ||
                record.analysisRun === null)
        ) {
            // Fixture ready completions are terminal test responses, not cacheable analysis artifacts.
            return;
        }

        BackendAnalysisJobs.persistArtifactRecordSafely(record, completedAtMs);
    }

    /**
     * Persists one completed job as artifact history behind the repository boundary.
     *
     * @param record - Completed backend job record.
     * @param completedAtMs - Terminal completion timestamp.
     */
    private static persistArtifactRecord(
        record: AnalysisJobRecord,
        completedAtMs: number,
    ): void {
        if (record.terminalResponse === null) {
            return;
        }

        AnalysisArtifactStore.save({
            recordId: AnalysisArtifactStore.buildRecordId(
                {
                    videoId: record.videoId,
                    algorithmVersion: record.algorithmVersion,
                    jobId: record.jobId,
                    terminalResponse: record.terminalResponse,
                },
                completedAtMs,
            ),
            video: {
                videoId: record.videoId,
                durationSec: record.durationSec,
                algorithmVersion: record.algorithmVersion,
            },
            job: {
                jobId: record.jobId,
                createdAtMs: record.createdAtMs,
                completedAtMs,
                retryCount: record.retryCount,
                joinedRequestCount: record.joinedRequestCount,
                finalStatus: record.terminalResponse.status,
            },
            extractionAttempts: record.extractionAttempts,
            selectedTranscriptArtifact: record.selectedTranscriptArtifact,
            analysisRun: record.analysisRun,
            terminalResponse: record.terminalResponse,
            operationalMetadata:
                AnalysisArtifactStore.buildDefaultOperationalMetadata(
                    record,
                    completedAtMs,
                ),
        });
    }

    /**
     * Keeps durable-history failures from escaping the detached job worker.
     *
     * @param record - Completed backend job record.
     * @param completedAtMs - Terminal completion timestamp.
     */
    private static persistArtifactRecordSafely(
        record: AnalysisJobRecord,
        completedAtMs: number,
    ): void {
        try {
            BackendAnalysisJobs.persistArtifactRecord(record, completedAtMs);
        } catch {
            // Analysis results remain available in memory even if local history is unavailable.
        }
    }

    /**
     * Converts unexpected detached-worker failures into terminal API state.
     *
     * @param record - Job whose background work failed.
     * @param completedAtMs - Failure timestamp.
     */
    private static completeUnexpectedFailure(
        record: AnalysisJobRecord,
        completedAtMs: number,
    ): void {
        if (record.terminalResponse !== null) {
            return;
        }

        record.stage = ANALYSIS_JOB_STAGE.Complete;
        record.completedAtMs = completedAtMs;
        record.terminalResponse = {
            status: 'error',
            videoId: record.videoId,
            algorithmVersion: record.algorithmVersion,
            error: {
                code: SERVER_ANALYSIS_ERROR_CODE.InternalError,
            },
        };
        BackendAnalysisJobs.attachSupportIdSafely(
            record,
            SERVER_ANALYSIS_ERROR_CODE.InternalError,
            completedAtMs,
        );
        BackendAnalysisJobs.persistArtifactRecordSafely(record, completedAtMs);
    }

    /**
     * Releases terminal process state after clients have had time to poll it.
     *
     * @param nowMs - Current epoch time used for deterministic cleanup.
     */
    private static pruneTerminalJobs(nowMs: number): void {
        for (const [jobId, record] of BackendAnalysisJobs.jobsById) {
            if (
                record.completedAtMs === null ||
                nowMs - record.completedAtMs < TERMINAL_JOB_RETENTION_MS
            ) {
                continue;
            }
            BackendAnalysisJobs.jobsById.delete(jobId);
            BackendAnalysisJobs.jobIdsByKey.delete(record.jobKey);
        }
    }

    /**
     * Derives the stable job dedupe key used by repeated cold starts.
     *
     * @param input - Validated video/version key.
     * @returns Internal map key.
     */
    private static buildJobKey(input: {
        videoId: string;
        algorithmVersion: string;
    }): string {
        return `${input.videoId}:${input.algorithmVersion}`;
    }

    /**
     * Derives a human-readable deterministic local job id.
     *
     * @param input - Validated video/version key.
     * @returns Stable local job id.
     */
    private static buildJobId(input: {
        videoId: string;
        algorithmVersion: string;
        ownerInstallationHash?: string;
    }): string {
        return input.ownerInstallationHash === undefined ||
            input.ownerInstallationHash === LOCAL_INSTALLATION_HASH
            ? `local-${input.videoId}-${input.algorithmVersion}`
            : `job-${randomUUID()}`;
    }

    /**
     * Builds terminal fixture payloads using the same contract as the HTTP API.
     *
     * @param record - Stored job record to complete.
     * @param input - Requested terminal fixture state.
     * @returns Validated terminal response.
     */
    private static buildFixtureTerminalResponse(
        record: AnalysisJobRecord,
        input: { status: FixtureCompletionStatus },
    ): BackendAnalysisTerminalResponse {
        switch (input.status) {
            case 'ready':
                return v.parse(readyResponseSchema, {
                    status: 'ready',
                    videoId: record.videoId,
                    algorithmVersion: record.algorithmVersion,
                    source: 'server_cache',
                    sourceResultId:
                        BackendAnalysisJobs.buildSourceResultId(record),
                    freshness: { expiresAtMs: FIXTURE_RESULT_EXPIRES_AT_MS },
                    promoBlocks: [
                        { startSec: 4, endSec: 24, confidence: 'high' },
                        { startSec: 35, endSec: 45, confidence: 'medium' },
                    ],
                });
            case 'no_promo':
                return v.parse(noPromoResponseSchema, {
                    status: 'no_promo',
                    videoId: record.videoId,
                    algorithmVersion: record.algorithmVersion,
                    sourceResultId:
                        BackendAnalysisJobs.buildSourceResultId(record),
                    freshness: { expiresAtMs: FIXTURE_RESULT_EXPIRES_AT_MS },
                });
            case 'unavailable':
                return v.parse(unavailableResponseSchema, {
                    status: 'unavailable',
                    videoId: record.videoId,
                    algorithmVersion: record.algorithmVersion,
                    error: {
                        code: SERVER_ANALYSIS_UNAVAILABLE_REASON.FixtureUnavailable,
                    },
                });
            case 'error':
                return v.parse(terminalErrorResponseSchema, {
                    status: 'error',
                    videoId: record.videoId,
                    algorithmVersion: record.algorithmVersion,
                    error: {
                        code: SERVER_ANALYSIS_ERROR_CODE.FixtureError,
                    },
                });
        }
    }

    /**
     * Builds the fixture result id exposed in terminal responses.
     *
     * @param record - Stored job record to identify.
     * @returns Stable source result id.
     */
    private static buildSourceResultId(record: AnalysisJobRecord): string {
        return `result-${record.videoId}-${record.algorithmVersion}`;
    }

    /**
     * Starts immediately below the active cap or appends one bounded queued starter.
     *
     * @param record - Newly admitted job record.
     * @param nowMs - Creation timestamp forwarded to extraction.
     * @returns Promise resolved after the queued or immediate job completes.
     */
    private static scheduleJob(
        record: AnalysisJobRecord,
        nowMs: number,
    ): Promise<void> {
        return new Promise((resolve) => {
            const start = (): void => {
                BackendAnalysisJobs.activeJobCount += 1;
                void BackendAnalysisJobs.runJob(record, nowMs).finally(() => {
                    BackendAnalysisJobs.activeJobCount = Math.max(
                        0,
                        BackendAnalysisJobs.activeJobCount - 1,
                    );
                    resolve();
                    BackendAnalysisJobs.queuedJobStarts.shift()?.();
                });
            };
            if (BackendAnalysisJobs.activeJobCount < MAX_ACTIVE_COLD_JOBS) {
                start();
                return;
            }
            BackendAnalysisJobs.queuedJobStarts.push(start);
        });
    }

    /**
     * Rejects yt-dlp artifacts that cannot prove an ordinary VOD duration.
     *
     * @param artifact - Selected transcript candidate from the extraction pipeline.
     * @returns Stable duration failure or `null` when authoritative metadata is usable.
     */
    private static authoritativeDurationFailureCode(
        artifact: TranscriptArtifact,
    ): ServerAnalysisFailureCode | null {
        if (artifact.sourceType !== 'youtube_yt_dlp') {
            return null;
        }
        const durationSec = artifact.videoDurationSec;
        if (
            durationSec === undefined ||
            !Number.isFinite(durationSec) ||
            durationSec <= 0
        ) {
            return SERVER_ANALYSIS_UNAVAILABLE_REASON.VideoUnavailable;
        }
        return durationSec > MAX_VIDEO_DURATION_SEC
            ? SERVER_ANALYSIS_UNAVAILABLE_REASON.VideoTooLong
            : null;
    }

    /**
     * Publishes terminal unavailable state before attempting optional durable writes.
     *
     * @param record - Job whose extraction path cannot continue.
     * @param code - Stable public unavailable code.
     * @param completedAtMs - Failure timestamp.
     */
    private static completeUnavailable(
        record: AnalysisJobRecord,
        code: ServerAnalysisFailureCode,
        completedAtMs: number,
    ): void {
        record.stage = ANALYSIS_JOB_STAGE.Complete;
        record.selectedTranscriptArtifact = null;
        record.completedAtMs = completedAtMs;
        record.terminalResponse = {
            status: 'unavailable',
            videoId: record.videoId,
            algorithmVersion: record.algorithmVersion,
            error: { code },
        };
        if (
            code === SERVER_ANALYSIS_UNAVAILABLE_REASON.CaptionExtractionFailed
        ) {
            BackendAnalysisJobs.attachSupportIdSafely(
                record,
                code,
                completedAtMs,
            );
        }
        BackendAnalysisJobs.persistArtifactRecordSafely(record, completedAtMs);
    }

    /**
     * Adds support correlation only after the terminal response is observable.
     *
     * @param record - Already-completed job response to enrich.
     * @param code - Stable public failure code.
     * @param nowMs - Failure timestamp.
     */
    private static attachSupportIdSafely(
        record: AnalysisJobRecord,
        code: string,
        nowMs: number,
    ): void {
        const terminalResponse = record.terminalResponse;
        if (
            terminalResponse === null ||
            (terminalResponse.status !== 'error' &&
                terminalResponse.status !== 'unavailable')
        ) {
            return;
        }
        const supportId = BackendAnalysisJobs.recordSupportFailureSafely(
            code,
            record,
            nowMs,
        );
        if (supportId === undefined) {
            return;
        }
        record.terminalResponse = {
            ...terminalResponse,
            error: { ...terminalResponse.error, supportId },
        };
    }

    /**
     * Reads optional support correlation after a best-effort terminal write.
     *
     * @param record - Completed job record.
     * @returns Persisted support identifier when one was attached.
     */
    private static readTerminalSupportId(
        record: AnalysisJobRecord,
    ): string | undefined {
        const terminalResponse = record.terminalResponse;
        return terminalResponse?.status === 'error' ||
            terminalResponse?.status === 'unavailable'
            ? terminalResponse.error.supportId
            : undefined;
    }

    /**
     * Persists an opaque support row without allowing SQLite faults to escape.
     *
     * @param code - Stable public failure code.
     * @param record - Owning job metadata.
     * @param nowMs - Failure timestamp.
     * @returns Opaque support identifier only when persistence succeeded.
     */
    private static recordSupportFailureSafely(
        code: string,
        record: AnalysisJobRecord,
        nowMs: number,
    ): string | undefined {
        try {
            const supportId = BackendPublicState.createSupportId();
            BackendPublicState.recordFailure({
                supportId,
                code,
                videoId: record.videoId,
                jobId: record.jobId,
                createdAtMs: nowMs,
                expiresAtMs: nowMs + FAILURE_RETENTION_MS,
            });
            return supportId;
        } catch {
            return undefined;
        }
    }
}
