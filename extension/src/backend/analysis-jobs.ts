import * as v from 'valibot';

import { AnalysisArtifactStore } from '@/backend/analysis-artifact-store';
import { BackendPromoAnalysisWorker } from '@/backend/analysis/promo-analysis-worker';
import type { AnalysisRunArtifact } from '@/backend/analysis/promo-analysis-types';
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
    type TerminalErrorResponse,
    type UnavailableResponse,
} from '@/shared/server-analysis-contract';
import { BackendSubtitleExtractionPipeline } from '@/backend/extraction/subtitle-extraction-pipeline';
import {
    type SubtitleExtractionAttempt,
    type TranscriptArtifact,
} from '@/backend/extraction/subtitle-extraction-types';

const DEFAULT_POLL_AFTER_SEC = 3;
const FIXTURE_RESULT_EXPIRES_AT_MS = 4_102_444_800_000;
const TERMINAL_JOB_RETENTION_MS = 5 * 60 * 1_000;
const BACKEND_JOB_FAILURE_MESSAGE =
    'The server could not complete analysis for this video.';

const ANALYSIS_JOB_STAGE = {
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
            stage: ANALYSIS_JOB_STAGE.Extracting,
            extractionAttempts: [],
            selectedTranscriptArtifact: null,
            analysisRun: null,
            processingResponse,
            terminalResponse: null,
            extractionPromise: null,
        };

        BackendAnalysisJobs.jobsById.set(jobId, record);
        BackendAnalysisJobs.jobIdsByKey.set(jobKey, jobId);
        record.extractionPromise = BackendAnalysisJobs.runJob(
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
        options: { nowMs?: number } = {},
    ): BackendAnalysisJobResponse | null {
        void options;
        const record = BackendAnalysisJobs.jobsById.get(jobId);
        if (record === undefined) {
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
    }

    /**
     * Exposes stable diagnostics for tests that prove lookup has no side effects.
     *
     * @returns Current in-memory job count.
     */
    static snapshotForTests(): { jobCount: number } {
        return { jobCount: BackendAnalysisJobs.jobsById.size };
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
            const extraction = await BackendSubtitleExtractionPipeline.extract({
                videoId: record.videoId,
                algorithmVersion: record.algorithmVersion,
                nowMs,
            });
            if (record.terminalResponse !== null) {
                return;
            }
            record.extractionAttempts = extraction.attempts;

            if (extraction.status === 'selected') {
                record.stage = ANALYSIS_JOB_STAGE.AwaitingAnalysis;
                record.selectedTranscriptArtifact = extraction.artifact;
                BackendAnalysisJobs.runAnalysis(record, Date.now());
                return;
            }

            record.stage = ANALYSIS_JOB_STAGE.Complete;
            record.selectedTranscriptArtifact = null;
            record.completedAtMs = nowMs;
            record.terminalResponse = v.parse(unavailableResponseSchema, {
                status: 'unavailable',
                videoId: record.videoId,
                algorithmVersion: record.algorithmVersion,
                reason: extraction.reason,
                message: extraction.message,
            });
            BackendAnalysisJobs.persistArtifactRecordSafely(record, nowMs);
        } catch {
            BackendAnalysisJobs.completeUnexpectedFailure(record, Date.now());
        }
    }

    /**
     * Runs model analysis once for jobs that already selected a transcript.
     *
     * @param record - In-memory job record to complete.
     * @param nowMs - Deterministic analysis timestamp.
     * @returns Terminal worker response.
     */
    private static runAnalysis(
        record: AnalysisJobRecord,
        nowMs: number,
    ): BackendAnalysisTerminalResponse {
        if (record.terminalResponse !== null) {
            return record.terminalResponse;
        }
        if (record.selectedTranscriptArtifact === null) {
            throw new Error(
                'Cannot analyze a job without a selected transcript.',
            );
        }

        record.stage = ANALYSIS_JOB_STAGE.Analyzing;
        const result = BackendPromoAnalysisWorker.analyze({
            transcriptArtifact: record.selectedTranscriptArtifact,
            durationSec: record.durationSec,
            nowMs,
        });
        record.analysisRun = result.analysisRun;
        record.terminalResponse = result.terminalResponse;
        record.completedAtMs = nowMs;
        record.stage = ANALYSIS_JOB_STAGE.Complete;
        BackendAnalysisJobs.persistArtifactRecordSafely(record, nowMs);
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
        record.terminalResponse = v.parse(terminalErrorResponseSchema, {
            status: 'error',
            videoId: record.videoId,
            algorithmVersion: record.algorithmVersion,
            error: {
                code: SERVER_ANALYSIS_ERROR_CODE.ModelProviderError,
                message: BACKEND_JOB_FAILURE_MESSAGE,
            },
        });
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
    }): string {
        return `local-${input.videoId}-${input.algorithmVersion}`;
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
                    reason: SERVER_ANALYSIS_UNAVAILABLE_REASON.FixtureUnavailable,
                    message: 'Fixture analysis is unavailable.',
                });
            case 'error':
                return v.parse(terminalErrorResponseSchema, {
                    status: 'error',
                    videoId: record.videoId,
                    algorithmVersion: record.algorithmVersion,
                    error: {
                        code: SERVER_ANALYSIS_ERROR_CODE.FixtureError,
                        message: 'Fixture job failed.',
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
}
