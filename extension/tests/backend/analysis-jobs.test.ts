import { beforeEach, describe, expect, it } from 'vitest';

import { AnalysisArtifactStore } from '@/backend/analysis-artifact-store';
import { BackendAnalysisJobs } from '@/backend/analysis-jobs';
import { LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS } from '@/backend/extraction/local-transcript-fixtures';
import {
    SERVER_ANALYSIS_ALGORITHM_VERSION,
    SERVER_ANALYSIS_UNAVAILABLE_REASON,
} from '@/shared/server-analysis-contract';

describe('BackendAnalysisJobs', () => {
    beforeEach(() => {
        BackendAnalysisJobs.resetForTests();
        AnalysisArtifactStore.resetForTests();
    });

    it('creates a processing job and later completes it as ready', async () => {
        BackendAnalysisJobs.resetForTests();

        const processing = BackendAnalysisJobs.start({
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: 1_900_000_000_000,
        });

        expect(processing.status).toBe('processing');
        if (processing.status !== 'processing') {
            throw new Error('Expected processing response.');
        }
        await BackendAnalysisJobs.waitForExtractionForTests(processing.jobId);

        const ready = BackendAnalysisJobs.completeFixture({
            jobId: processing.jobId,
            status: 'ready',
            nowMs: 1_900_000_001_000,
        });

        expect(ready?.status).toBe('ready');
        expect(BackendAnalysisJobs.getStatus(processing.jobId)).toEqual(ready);
    });

    it('stores selected transcript artifacts on supported cold jobs', async () => {
        BackendAnalysisJobs.resetForTests();

        const response = BackendAnalysisJobs.start({
            videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: 1_900_000_000_000,
        });

        expect(response.status).toBe('processing');
        if (response.status !== 'processing') {
            throw new Error('Expected processing response.');
        }
        await BackendAnalysisJobs.waitForExtractionForTests(response.jobId);
        const diagnostics = BackendAnalysisJobs.getDiagnosticsForTests(
            response.jobId,
        );
        expect(diagnostics?.stage).toBe('complete');
        expect(diagnostics?.selectedTranscriptArtifact?.segments).toHaveLength(
            4,
        );
        expect(diagnostics?.analysisRun).not.toBeNull();
        expect(diagnostics?.extractionAttempts).toEqual([
            expect.objectContaining({
                strategy: 'local_transcript_fixture',
                status: 'succeeded',
            }),
        ]);
    });

    it('stores terminal unavailable when extraction cannot select a transcript', async () => {
        BackendAnalysisJobs.resetForTests();

        const response = BackendAnalysisJobs.start({
            videoId: 'unknownVid1',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: 1_900_000_000_000,
        });

        const terminal = await BackendAnalysisJobs.waitForExtractionForTests(
            response.status === 'processing' ? response.jobId : '',
        );
        expect(terminal).toMatchObject({
            status: 'unavailable',
            videoId: 'unknownVid1',
            reason: SERVER_ANALYSIS_UNAVAILABLE_REASON.CaptionExtractionFailed,
        });
        const diagnostics = BackendAnalysisJobs.getDiagnosticsForTests(
            'local-unknownVid1-server-v1',
        );
        expect(diagnostics?.stage).toBe('complete');
        expect(diagnostics?.selectedTranscriptArtifact).toBeNull();
        expect(diagnostics?.extractionAttempts[0]).toMatchObject({
            strategy: 'local_transcript_fixture',
            status: 'failed',
            failureReason: 'fixture_not_found',
        });
    });

    it('persists extraction failure history with attempts and terminal status', async () => {
        BackendAnalysisJobs.resetForTests();
        AnalysisArtifactStore.resetForTests();

        const processing = BackendAnalysisJobs.start({
            videoId: 'unknownVid1',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: 1_900_000_000_000,
        });
        if (processing.status !== 'processing') {
            throw new Error('Expected processing response.');
        }
        await BackendAnalysisJobs.waitForExtractionForTests(processing.jobId);

        const history = AnalysisArtifactStore.findHistory({
            videoId: 'unknownVid1',
        });
        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({
            terminalResponse: {
                status: 'unavailable',
                reason: SERVER_ANALYSIS_UNAVAILABLE_REASON.CaptionExtractionFailed,
            },
            selectedTranscriptArtifact: null,
            analysisRun: null,
        });
        expect(history[0]?.extractionAttempts[0]).toMatchObject({
            failureReason: 'fixture_not_found',
        });
    });

    it('returns the same active job for duplicate cold starts', () => {
        BackendAnalysisJobs.resetForTests();

        const first = BackendAnalysisJobs.start({
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: 1_900_000_000_000,
        });
        const second = BackendAnalysisJobs.start({
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: 1_900_000_009_000,
        });

        expect(second).toEqual(first);
        expect(second.status).toBe('processing');
        if (first.status !== 'processing') {
            throw new Error('Expected processing response.');
        }
    });

    it('finds existing jobs by video and algorithm without creating records', async () => {
        BackendAnalysisJobs.resetForTests();

        expect(
            BackendAnalysisJobs.findExisting({
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            }),
        ).toBeNull();
        expect(BackendAnalysisJobs.snapshotForTests().jobCount).toBe(0);

        const processing = BackendAnalysisJobs.start({
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: 1_900_000_000_000,
        });

        expect(
            BackendAnalysisJobs.findExisting({
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            }),
        ).toEqual(processing);
        expect(BackendAnalysisJobs.snapshotForTests().jobCount).toBe(1);

        if (processing.status !== 'processing') {
            throw new Error('Expected processing response.');
        }
        await BackendAnalysisJobs.waitForExtractionForTests(processing.jobId);

        expect(
            BackendAnalysisJobs.findExisting({
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            }),
        ).toBeNull();
        expect(BackendAnalysisJobs.snapshotForTests().jobCount).toBe(1);
    });

    it('starts fresh work after a terminal job is no longer active', async () => {
        BackendAnalysisJobs.resetForTests();

        const terminal = BackendAnalysisJobs.start({
            videoId: 'unknownVid1',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: 1_900_000_000_000,
        });
        if (terminal.status !== 'processing') {
            throw new Error('Expected processing response.');
        }
        const completed = await BackendAnalysisJobs.waitForExtractionForTests(
            terminal.jobId,
        );
        const duplicate = BackendAnalysisJobs.start({
            videoId: 'unknownVid1',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: 1_900_000_010_000,
        });

        expect(completed?.status).toBe('unavailable');
        expect(completed?.status).toBe('unavailable');
        expect(duplicate.status).toBe('processing');
        expect(duplicate).not.toEqual(completed);
    });

    it('runs analysis on first status poll for a selected transcript job', async () => {
        BackendAnalysisJobs.resetForTests();

        const processing = BackendAnalysisJobs.start({
            videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            durationSec: 120,
            nowMs: 1_900_000_000_000,
        });
        if (processing.status !== 'processing') {
            throw new Error('Expected processing response.');
        }
        await BackendAnalysisJobs.waitForExtractionForTests(processing.jobId);

        const ready = BackendAnalysisJobs.getStatus(processing.jobId, {
            nowMs: 1_900_000_001_000,
        });

        expect(ready).toMatchObject({
            status: 'ready',
            videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
            promoBlocks: [
                { startSec: 4, endSec: 24, confidence: 'high' },
                { startSec: 35, endSec: 45, confidence: 'medium' },
            ],
        });
        const diagnostics = BackendAnalysisJobs.getDiagnosticsForTests(
            processing.jobId,
        );
        expect(diagnostics?.stage).toBe('complete');
        expect(diagnostics?.analysisRun?.rawModelResponse).toContain(
            'promoBlocks',
        );
    });

    it('persists successful analysis artifacts with transcript and model output', async () => {
        BackendAnalysisJobs.resetForTests();
        AnalysisArtifactStore.resetForTests();

        const processing = BackendAnalysisJobs.start({
            videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            durationSec: 120,
            nowMs: 1_900_000_000_000,
        });
        if (processing.status !== 'processing') {
            throw new Error('Expected processing response.');
        }
        await BackendAnalysisJobs.waitForExtractionForTests(processing.jobId);

        BackendAnalysisJobs.getStatus(processing.jobId, {
            nowMs: 1_900_000_001_000,
        });

        const [record] = AnalysisArtifactStore.findHistory({
            videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
        });
        expect(record?.terminalResponse.status).toBe('ready');
        expect(record?.selectedTranscriptArtifact?.transcriptText).toContain(
            'sponsored',
        );
        expect(record?.analysisRun?.rawModelResponse).toContain('promoBlocks');
        expect(record?.analysisRun?.parsedResult).toMatchObject({
            hasPromo: true,
        });
        expect(record?.analysisRun?.normalizedPromoBlocks).toEqual(
            record?.terminalResponse.status === 'ready'
                ? record.terminalResponse.promoBlocks
                : [],
        );
    });

    it('persists no-promo worker history with analysis artifacts', async () => {
        const processing = BackendAnalysisJobs.start({
            videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Secondary,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            durationSec: 120,
            nowMs: 1_900_000_000_000,
        });
        if (processing.status !== 'processing') {
            throw new Error('Expected processing response.');
        }
        await BackendAnalysisJobs.waitForExtractionForTests(processing.jobId);

        BackendAnalysisJobs.getStatus(processing.jobId, {
            nowMs: 1_900_000_001_000,
        });

        const [record] = AnalysisArtifactStore.findHistory({
            videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Secondary,
        });
        expect(record?.terminalResponse.status).toBe('no_promo');
        expect(record?.selectedTranscriptArtifact).not.toBeNull();
        expect(record?.analysisRun).toMatchObject({
            parsedResult: { hasPromo: false },
            failureReason: null,
        });
    });

    it('does not re-run analysis after a terminal response exists', async () => {
        BackendAnalysisJobs.resetForTests();

        const processing = BackendAnalysisJobs.start({
            videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            durationSec: 120,
            nowMs: 1_900_000_000_000,
        });
        if (processing.status !== 'processing') {
            throw new Error('Expected processing response.');
        }
        await BackendAnalysisJobs.waitForExtractionForTests(processing.jobId);

        const first = BackendAnalysisJobs.getStatus(processing.jobId, {
            nowMs: 1_900_000_001_000,
        });
        const second = BackendAnalysisJobs.getStatus(processing.jobId, {
            nowMs: 1_900_000_999_000,
        });

        expect(second).toEqual(first);
    });

    it.each(['no_promo', 'unavailable', 'error'] as const)(
        'does not override an already completed job as %s',
        async (status) => {
            BackendAnalysisJobs.resetForTests();

            const processing = BackendAnalysisJobs.start({
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                nowMs: 1_900_000_000_000,
            });
            if (processing.status !== 'processing') {
                throw new Error('Expected processing response.');
            }
            await BackendAnalysisJobs.waitForExtractionForTests(
                processing.jobId,
            );
            const terminal = BackendAnalysisJobs.completeFixture({
                jobId: processing.jobId,
                status,
                nowMs: 1_900_000_001_000,
            });

            expect(terminal?.status).toBe('ready');
        },
    );

    it('preserves worker-backed history when fixture completion arrives late', async () => {
        BackendAnalysisJobs.resetForTests();
        AnalysisArtifactStore.resetForTests();

        const processing = BackendAnalysisJobs.start({
            videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: 1_900_000_000_000,
        });
        if (processing.status !== 'processing') {
            throw new Error('Expected processing response.');
        }
        await BackendAnalysisJobs.waitForExtractionForTests(processing.jobId);

        BackendAnalysisJobs.completeFixture({
            jobId: processing.jobId,
            status: 'error',
            nowMs: 1_900_000_001_000,
        });

        const [record] = AnalysisArtifactStore.findHistory({
            videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
        });
        expect(record?.terminalResponse.status).toBe('ready');
        expect(record?.selectedTranscriptArtifact).not.toBeNull();
        expect(record?.analysisRun).not.toBeNull();
    });

    it('persists worker-backed ready artifacts without fixture overrides', async () => {
        BackendAnalysisJobs.resetForTests();
        AnalysisArtifactStore.resetForTests();

        const processing = BackendAnalysisJobs.start({
            videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: 1_900_000_000_000,
        });
        if (processing.status !== 'processing') {
            throw new Error('Expected processing response.');
        }
        await BackendAnalysisJobs.waitForExtractionForTests(processing.jobId);

        const ready = BackendAnalysisJobs.completeFixture({
            jobId: processing.jobId,
            status: 'ready',
            nowMs: 1_900_000_001_000,
        });

        expect(ready?.status).toBe('ready');
        expect(
            AnalysisArtifactStore.findHistory({
                videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
            }),
        ).toHaveLength(1);
        expect(
            AnalysisArtifactStore.findLatestReady({
                videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            }),
        ).not.toBeNull();
    });

    it('returns null for unknown job status and completion requests', () => {
        BackendAnalysisJobs.resetForTests();

        expect(BackendAnalysisJobs.getStatus('missing-job')).toBeNull();
        expect(
            BackendAnalysisJobs.completeFixture({
                jobId: 'missing-job',
                status: 'ready',
                nowMs: 1_900_000_000_000,
            }),
        ).toBeNull();
    });
});
