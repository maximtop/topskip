import * as v from 'valibot';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AnalysisArtifactStore } from '@topskip/backend/analysis-artifact-store';
import { BackendAnalysisJobs } from '@topskip/backend/analysis-jobs';
import { startAnalysisJobForTest } from './analysis-jobs-test-helpers';
import { BackendPublicState } from '@topskip/backend/public-state';
import { TranscriptFingerprint } from '@topskip/backend/transcript-fingerprint';
import { BackendSubtitleExtractionPipeline } from '@topskip/backend/extraction/subtitle-extraction-pipeline';
import type { BackendLlmAnalysisAdapterResult } from '@topskip/backend/analysis/promo-analysis-types';
import {
    transcriptArtifactSchema,
    type SubtitleExtractionStrategy,
    type TranscriptArtifact,
} from '@topskip/backend/extraction/subtitle-extraction-types';
import { LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS } from '@topskip/backend/extraction/local-transcript-fixtures';
import {
    SERVER_ANALYSIS_ALGORITHM_VERSION,
    SERVER_ANALYSIS_API_VERSION,
    SERVER_ANALYSIS_UNAVAILABLE_REASON,
} from '@topskip/common/server-analysis-contract';
import { CaptionTranscriptCanonicalizer } from '@topskip/common/captions/canonical-transcript';

const UPLOAD_TEST_NOW_MS = 1_900_000_000_000;

function makeUploadArtifact(
    input: {
        videoId?: string;
        languageCode?: string;
        text?: string;
        startSec?: number;
    } = {},
): {
    identity: {
        videoId: string;
        algorithmVersion: string;
        languageCode: string;
        transcriptHash: string;
    };
    artifact: TranscriptArtifact;
} {
    const videoId = input.videoId ?? 'dQw4w9WgXcQ';
    const canonical = CaptionTranscriptCanonicalizer.canonicalize({
        languageCode: input.languageCode ?? 'en',
        segments: [
            {
                startSec: input.startSec ?? 0,
                durationSec: 40,
                text:
                    input.text ??
                    'This segment is sponsored before the main topic.',
            },
        ],
    });
    if (!canonical.ok) {
        throw new Error('Expected a valid upload fixture transcript.');
    }
    const transcriptHash = TranscriptFingerprint.sha256Hex(
        canonical.transcript.canonicalBytes,
    );
    const identity = {
        videoId,
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        languageCode: canonical.transcript.languageCode,
        transcriptHash,
    };
    return {
        identity,
        artifact: v.parse(transcriptArtifactSchema, {
            artifactId: 'transcript-upload-fixture',
            ...identity,
            strategy: 'extension_caption_upload',
            sourceType: 'extension_caption_upload',
            videoDurationSec: canonical.transcript.timelineEndSec,
            acquiredAtMs: UPLOAD_TEST_NOW_MS,
            segments: canonical.transcript.segments,
            transcriptText: canonical.transcript.segments
                .map((segment) => segment.text)
                .join(' '),
        }),
    };
}

describe('BackendAnalysisJobs', () => {
    beforeEach(() => {
        BackendAnalysisJobs.resetForTests();
        AnalysisArtifactStore.resetForTests();
    });

    it('creates a processing job and later completes it as ready', async () => {
        BackendAnalysisJobs.resetForTests();

        const processing = startAnalysisJobForTest({
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

        const response = startAnalysisJobForTest({
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

        const response = startAnalysisJobForTest({
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
            error: {
                code: SERVER_ANALYSIS_UNAVAILABLE_REASON.CaptionExtractionFailed,
            },
        });
        const diagnostics = BackendAnalysisJobs.getDiagnosticsForTests(
            `local-unknownVid1-${SERVER_ANALYSIS_ALGORITHM_VERSION}`,
        );
        expect(diagnostics?.stage).toBe('complete');
        expect(diagnostics?.selectedTranscriptArtifact).toBeNull();
        expect(diagnostics?.extractionAttempts[0]).toMatchObject({
            strategy: 'local_transcript_fixture',
            status: 'failed',
            failureReason: 'fixture_not_found',
        });
    });

    it.each([
        'video_unavailable',
        'captions_unavailable',
        'video_too_long',
        'too_many_caption_segments',
        'transcript_too_large',
        'subtitle_response_too_large',
    ] as const)(
        'never calls the model after extraction preflight %s',
        async (code) => {
            const analyze =
                vi.fn<() => Promise<BackendLlmAnalysisAdapterResult>>();
            const strategy: SubtitleExtractionStrategy = {
                name: 'preflight_fixture',
                extract: () => ({
                    status: 'failed',
                    failureReason: 'strategy_error',
                    diagnostics: { code },
                }),
            };
            const processing = startAnalysisJobForTest({
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                nowMs: 1_900_000_000_000,
                extractionStrategies: [strategy],
                analysisAdapter: {
                    providerId: 'test',
                    model: 'test',
                    promptVersion: 'test',
                    analyze,
                },
            });
            if (processing.status !== 'processing') {
                throw new Error('Expected processing response.');
            }

            const terminal =
                await BackendAnalysisJobs.waitForExtractionForTests(
                    processing.jobId,
                );

            expect(terminal).toMatchObject({
                status: 'unavailable',
                error: { code },
            });
            expect(analyze).not.toHaveBeenCalled();
        },
    );

    it('persists extraction failure history with attempts and terminal status', async () => {
        BackendAnalysisJobs.resetForTests();
        AnalysisArtifactStore.resetForTests();

        const processing = startAnalysisJobForTest({
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
                error: {
                    code: SERVER_ANALYSIS_UNAVAILABLE_REASON.CaptionExtractionFailed,
                },
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

        const first = startAnalysisJobForTest({
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: 1_900_000_000_000,
        });
        const second = startAnalysisJobForTest({
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

    it('joins callers while one asynchronous model analysis is pending', async () => {
        let resolveAnalysis:
            | ((result: BackendLlmAnalysisAdapterResult) => void)
            | undefined;
        const analyze = vi.fn(
            () =>
                new Promise<BackendLlmAnalysisAdapterResult>((resolve) => {
                    resolveAnalysis = resolve;
                }),
        );
        const first = startAnalysisJobForTest({
            videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            durationSec: 120,
            nowMs: 1_900_000_000_000,
            analysisAdapter: {
                providerId: 'test_adapter',
                model: 'test-model',
                promptVersion: 'test-prompt',
                analyze,
            },
        });
        const second = startAnalysisJobForTest({
            videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            durationSec: 120,
            nowMs: 1_900_000_000_100,
        });

        expect(second).toEqual(first);
        await vi.waitFor(() => {
            expect(analyze).toHaveBeenCalledTimes(1);
        });
        if (first.status !== 'processing') {
            throw new Error('Expected processing response.');
        }
        expect(BackendAnalysisJobs.getStatus(first.jobId)?.status).toBe(
            'processing',
        );
        if (resolveAnalysis === undefined) {
            throw new Error('Expected pending analysis resolver.');
        }
        resolveAnalysis({
            rawModelResponse:
                '{"hasPromo":true,"promoBlocks":[{"startSec":4,"endSec":24}]}',
            model: 'test-model',
            usage: {
                inputTokens: 120,
                outputTokens: 30,
                costUsd: 0.0042,
            },
        });

        const terminal = await BackendAnalysisJobs.waitForExtractionForTests(
            first.jobId,
        );
        expect(terminal).toMatchObject({
            status: 'ready',
            promoBlocks: [{ startSec: 4, endSec: 24 }],
        });
        expect(analyze).toHaveBeenCalledTimes(1);
        expect(
            AnalysisArtifactStore.findHistory({
                videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
            })[0]?.operationalMetadata,
        ).toMatchObject({
            promptVersion: 'test-prompt',
            modelVersion: 'test-model',
            cost: {
                estimatedUsd: 0.0042,
                inputTokens: 120,
                outputTokens: 30,
            },
        });
    });

    it('joins one exact upload job for authorized installations', async () => {
        let resolveAnalysis:
            | ((result: BackendLlmAnalysisAdapterResult) => void)
            | undefined;
        const analyze = vi.fn(
            () =>
                new Promise<BackendLlmAnalysisAdapterResult>((resolve) => {
                    resolveAnalysis = resolve;
                }),
        );
        const upload = makeUploadArtifact();
        const first = startAnalysisJobForTest({
            source: 'extension_upload',
            identity: upload.identity,
            transcriptArtifact: upload.artifact,
            installationHash: 'installation-a',
            ipHash: 'ip-a',
            nowMs: UPLOAD_TEST_NOW_MS,
            analysisAdapter: {
                providerId: 'test_adapter',
                model: 'test-model',
                promptVersion: 'test-prompt',
                analyze,
            },
        });
        const joined = startAnalysisJobForTest({
            source: 'extension_upload',
            identity: upload.identity,
            transcriptArtifact: upload.artifact,
            installationHash: 'installation-b',
            ipHash: 'ip-b',
            nowMs: UPLOAD_TEST_NOW_MS + 1,
        });

        expect(joined).toEqual(first);
        expect(first.status).toBe('processing');
        if (first.status !== 'processing') {
            throw new Error('Expected processing response.');
        }
        expect(first).toMatchObject(upload.identity);
        expect(first.jobId).toMatch(/^job-[0-9a-f-]{36}$/u);
        expect(first.jobId).not.toContain(upload.identity.transcriptHash);
        expect(
            BackendAnalysisJobs.getStatus(first.jobId, {
                ownerInstallationHash: 'installation-a',
            }),
        ).toEqual(first);
        expect(
            BackendAnalysisJobs.getStatus(first.jobId, {
                ownerInstallationHash: 'installation-b',
            }),
        ).toEqual(first);
        expect(
            BackendAnalysisJobs.getStatus(first.jobId, {
                ownerInstallationHash: 'installation-c',
            }),
        ).toBeNull();

        const otherUpload = makeUploadArtifact({ languageCode: 'de' });
        const otherAnalyze = vi.fn(() =>
            Promise.resolve({
                rawModelResponse: '{"hasPromo":false}',
                model: 'test-model',
            }),
        );
        const other = startAnalysisJobForTest({
            source: 'extension_upload',
            identity: otherUpload.identity,
            transcriptArtifact: otherUpload.artifact,
            installationHash: 'installation-a',
            ipHash: 'ip-a',
            nowMs: UPLOAD_TEST_NOW_MS + 2,
            analysisAdapter: {
                providerId: 'test_adapter',
                model: 'test-model',
                promptVersion: 'test-prompt',
                analyze: otherAnalyze,
            },
        });
        expect(other.status).toBe('processing');
        expect(other).not.toEqual(first);
        await vi.waitFor(() => {
            expect(analyze).toHaveBeenCalledTimes(1);
            expect(otherAnalyze).toHaveBeenCalledTimes(1);
        });

        if (resolveAnalysis === undefined) {
            throw new Error('Expected pending upload analysis resolver.');
        }
        resolveAnalysis({
            rawModelResponse:
                '{"hasPromo":true,"promoBlocks":[{"startSec":4,"endSec":24}]}',
            model: 'test-model',
        });
        const terminal = await BackendAnalysisJobs.waitForExtractionForTests(
            first.jobId,
        );
        expect(terminal).toMatchObject({
            status: 'ready',
            ...upload.identity,
        });
        expect(analyze).toHaveBeenCalledTimes(1);
        if (other.status === 'processing') {
            await BackendAnalysisJobs.waitForExtractionForTests(other.jobId);
        }
    });

    it('sends an uploaded artifact directly to Gemini', async () => {
        const extraction = vi.spyOn(
            BackendSubtitleExtractionPipeline,
            'extract',
        );
        const analyze = vi.fn(() =>
            Promise.resolve({
                rawModelResponse:
                    '{"hasPromo":true,"promoBlocks":[{"startSec":4,"endSec":24}]}',
                model: 'test-model',
                usage: {
                    inputTokens: 100,
                    outputTokens: 20,
                    costUsd: 0.002,
                },
            }),
        );
        const upload = makeUploadArtifact();
        const processing = startAnalysisJobForTest({
            source: 'extension_upload',
            identity: upload.identity,
            transcriptArtifact: upload.artifact,
            installationHash: 'installation-a',
            ipHash: 'ip-a',
            nowMs: UPLOAD_TEST_NOW_MS,
            durationSec: 1,
            analysisAdapter: {
                providerId: 'test_adapter',
                model: 'test-model',
                promptVersion: 'test-prompt',
                analyze,
            },
        });
        if (processing.status !== 'processing') {
            throw new Error('Expected processing response.');
        }

        const terminal = await BackendAnalysisJobs.waitForExtractionForTests(
            processing.jobId,
        );

        expect(extraction).not.toHaveBeenCalled();
        expect(analyze).toHaveBeenCalledTimes(1);
        expect(terminal).toMatchObject({
            status: 'ready',
            ...upload.identity,
            promoBlocks: [{ startSec: 4, endSec: 24 }],
        });
        expect(
            BackendAnalysisJobs.getDiagnosticsForTests(processing.jobId),
        ).toMatchObject({
            stage: 'complete',
            extractionAttempts: [],
            selectedTranscriptArtifact: {
                sourceType: 'extension_caption_upload',
                videoDurationSec: 40,
            },
        });
        expect(
            AnalysisArtifactStore.findLatestCacheableExact(upload.identity),
        ).toMatchObject({
            video: {
                ...upload.identity,
                sourceType: 'extension_caption_upload',
            },
        });
    });

    it('preserves upload identity when budget blocks model work', async () => {
        const previousNodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        const reserve = vi
            .spyOn(BackendPublicState, 'reserveModelBudget')
            .mockReturnValue(null);
        const extraction = vi.spyOn(
            BackendSubtitleExtractionPipeline,
            'extract',
        );
        const analyze = vi.fn<() => Promise<BackendLlmAnalysisAdapterResult>>();
        const upload = makeUploadArtifact();
        try {
            const processing = startAnalysisJobForTest({
                source: 'extension_upload',
                identity: upload.identity,
                transcriptArtifact: upload.artifact,
                installationHash: 'installation-a',
                ipHash: 'ip-a',
                nowMs: UPLOAD_TEST_NOW_MS,
                analysisAdapter: {
                    providerId: 'test',
                    model: 'test',
                    promptVersion: 'test',
                    analyze,
                },
            });
            if (processing.status !== 'processing') {
                throw new Error('Expected processing response.');
            }
            const terminal =
                await BackendAnalysisJobs.waitForExtractionForTests(
                    processing.jobId,
                );

            expect(terminal).toMatchObject({
                status: 'error',
                ...upload.identity,
                error: { code: 'budget_exhausted' },
            });
            expect(reserve).toHaveBeenCalledOnce();
            expect(extraction).not.toHaveBeenCalled();
            expect(analyze).not.toHaveBeenCalled();
        } finally {
            reserve.mockRestore();
            process.env.NODE_ENV = previousNodeEnv;
        }
    });

    it('runs two cold jobs and bounds the global queue at ten', async () => {
        const releases: Array<() => void> = [];
        const processingJobs = Array.from({ length: 12 }, (_, index) => {
            const videoId = `queueTest${String(index).padStart(2, '0')}`;
            const strategy: SubtitleExtractionStrategy = {
                name: 'pending_extraction',
                extract: () =>
                    new Promise((resolve) => {
                        releases.push(() => {
                            resolve({
                                status: 'failed',
                                failureReason: 'strategy_error',
                                diagnostics: { code: 'video_unavailable' },
                            });
                        });
                    }),
            };
            return startAnalysisJobForTest({
                videoId,
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                nowMs: 1_900_000_000_000 + index,
                extractionStrategies: [strategy],
            });
        });

        expect(BackendAnalysisJobs.snapshotForTests()).toMatchObject({
            activeJobCount: 2,
            queuedJobCount: 10,
        });
        expect(BackendAnalysisJobs.canAcceptColdJob()).toBe(false);

        let releasedCount = 0;
        while (releasedCount < processingJobs.length) {
            await vi.waitFor(() => {
                expect(releases.length).toBeGreaterThan(releasedCount);
            });
            releases[releasedCount]?.();
            releasedCount += 1;
        }
        await Promise.all(
            processingJobs.map((job) =>
                BackendAnalysisJobs.waitForExtractionForTests(
                    job.status === 'processing' ? job.jobId : '',
                ),
            ),
        );
        expect(BackendAnalysisJobs.snapshotForTests()).toMatchObject({
            activeJobCount: 0,
            queuedJobCount: 0,
        });
    });

    it('does not call the model when the global budget cannot reserve a call', async () => {
        const previousNodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        const reserve = vi
            .spyOn(BackendPublicState, 'reserveModelBudget')
            .mockReturnValue(null);
        const analyze = vi.fn<() => Promise<BackendLlmAnalysisAdapterResult>>();
        const strategy: SubtitleExtractionStrategy = {
            name: 'selected_fixture',
            extract: (input) => ({
                status: 'succeeded',
                artifact: {
                    artifactId: 'budget-transcript',
                    videoId: input.videoId,
                    algorithmVersion: input.algorithmVersion,
                    strategy: 'selected_fixture',
                    sourceType: 'local_fixture',
                    languageCode: 'en',
                    acquiredAtMs: input.nowMs,
                    videoDurationSec: 120,
                    segments: [{ startSec: 0, durationSec: 2, text: 'hello' }],
                    transcriptText: 'hello',
                },
            }),
        };
        try {
            const processing = startAnalysisJobForTest({
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                nowMs: 1_900_000_000_000,
                extractionStrategies: [strategy],
                analysisAdapter: {
                    providerId: 'test',
                    model: 'test',
                    promptVersion: 'test',
                    analyze,
                },
            });
            const terminal =
                await BackendAnalysisJobs.waitForExtractionForTests(
                    processing.status === 'processing' ? processing.jobId : '',
                );

            expect(terminal).toMatchObject({
                status: 'error',
                error: { code: 'budget_exhausted' },
            });
            expect(reserve).toHaveBeenCalledOnce();
            expect(analyze).not.toHaveBeenCalled();
        } finally {
            reserve.mockRestore();
            process.env.NODE_ENV = previousNodeEnv;
        }
    });

    it('finds existing jobs by video and algorithm without creating records', async () => {
        BackendAnalysisJobs.resetForTests();

        expect(
            BackendAnalysisJobs.findExisting({
                source: 'legacy_yt_dlp',
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                installationHash: 'local-development',
            }),
        ).toBeNull();
        expect(BackendAnalysisJobs.snapshotForTests().jobCount).toBe(0);

        const processing = startAnalysisJobForTest({
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: 1_900_000_000_000,
        });

        expect(
            BackendAnalysisJobs.findExisting({
                source: 'legacy_yt_dlp',
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                installationHash: 'local-development',
            }),
        ).toEqual(processing);
        expect(BackendAnalysisJobs.snapshotForTests().jobCount).toBe(1);

        if (processing.status !== 'processing') {
            throw new Error('Expected processing response.');
        }
        await BackendAnalysisJobs.waitForExtractionForTests(processing.jobId);

        expect(
            BackendAnalysisJobs.findExisting({
                source: 'legacy_yt_dlp',
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                installationHash: 'local-development',
            }),
        ).toBeNull();
        expect(BackendAnalysisJobs.snapshotForTests().jobCount).toBe(1);
    });

    it('starts fresh work after a terminal job is no longer active', async () => {
        BackendAnalysisJobs.resetForTests();

        const terminal = startAnalysisJobForTest({
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
        const duplicate = startAnalysisJobForTest({
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

        const processing = startAnalysisJobForTest({
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

        const processing = startAnalysisJobForTest({
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
        const processing = startAnalysisJobForTest({
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

        const processing = startAnalysisJobForTest({
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

            const processing = startAnalysisJobForTest({
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

        const processing = startAnalysisJobForTest({
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

        const processing = startAnalysisJobForTest({
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

    it('completes without support metadata when failure persistence throws', async () => {
        const recordFailure = vi
            .spyOn(BackendPublicState, 'recordFailure')
            .mockImplementation(() => {
                throw new Error('sqlite unavailable');
            });
        const processing = startAnalysisJobForTest({
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: 1_900_000_000_000,
            extractionStrategies: [
                {
                    name: 'failed_extraction',
                    extract: () => ({
                        status: 'failed',
                        failureReason: 'strategy_error',
                        diagnostics: { code: 'caption_extraction_failed' },
                    }),
                },
            ],
        });
        if (processing.status !== 'processing') {
            throw new Error('Expected processing response.');
        }

        const terminal = await BackendAnalysisJobs.waitForExtractionForTests(
            processing.jobId,
        );

        expect(terminal).toEqual({
            status: 'unavailable',
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            error: { code: 'caption_extraction_failed' },
        });
        expect(
            BackendAnalysisJobs.getDiagnosticsForTests(processing.jobId),
        ).toMatchObject({ stage: 'complete', terminalStatus: 'unavailable' });
        recordFailure.mockRestore();
    });

    it('retains safe request and server versions with support failures', async () => {
        const recordFailure = vi
            .spyOn(BackendPublicState, 'recordFailure')
            .mockImplementation(() => undefined);
        const processing = startAnalysisJobForTest({
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            extensionVersion: '0.1.0',
            nowMs: 1_900_000_000_000,
            extractionStrategies: [
                {
                    name: 'failed_extraction',
                    extract: () => ({
                        status: 'failed',
                        failureReason: 'strategy_error',
                        diagnostics: { code: 'caption_extraction_failed' },
                    }),
                },
            ],
        });
        if (processing.status !== 'processing') {
            throw new Error('Expected processing response.');
        }

        await BackendAnalysisJobs.waitForExtractionForTests(processing.jobId);

        expect(recordFailure).toHaveBeenCalledWith(
            expect.objectContaining({
                apiVersion: SERVER_ANALYSIS_API_VERSION,
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                extensionVersion: '0.1.0',
            }),
        );
        recordFailure.mockRestore();
    });

    it('publishes internal_error before best-effort support recording', async () => {
        const previousNodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        const reserve = vi
            .spyOn(BackendPublicState, 'reserveModelBudget')
            .mockImplementation(() => {
                throw new Error('sqlite unavailable');
            });
        const recordFailure = vi
            .spyOn(BackendPublicState, 'recordFailure')
            .mockImplementation(() => {
                throw new Error('sqlite unavailable');
            });
        const analyze = vi.fn<() => Promise<BackendLlmAnalysisAdapterResult>>();
        try {
            const processing = startAnalysisJobForTest({
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                nowMs: 1_900_000_000_000,
                extractionStrategies: [
                    {
                        name: 'selected_fixture',
                        extract: (input) => ({
                            status: 'succeeded',
                            artifact: {
                                artifactId: 'internal-error-transcript',
                                videoId: input.videoId,
                                algorithmVersion: input.algorithmVersion,
                                strategy: 'selected_fixture',
                                sourceType: 'local_fixture',
                                languageCode: 'en',
                                acquiredAtMs: input.nowMs,
                                videoDurationSec: 120,
                                segments: [
                                    {
                                        startSec: 0,
                                        durationSec: 1,
                                        text: 'hello',
                                    },
                                ],
                                transcriptText: 'hello',
                            },
                        }),
                    },
                ],
                analysisAdapter: {
                    providerId: 'test',
                    model: 'test',
                    promptVersion: 'test',
                    analyze,
                },
            });
            const terminal =
                await BackendAnalysisJobs.waitForExtractionForTests(
                    processing.status === 'processing' ? processing.jobId : '',
                );

            expect(terminal).toMatchObject({
                status: 'error',
                error: { code: 'internal_error' },
            });
            expect(
                terminal?.status === 'error'
                    ? terminal.error.supportId
                    : undefined,
            ).toBeUndefined();
            expect(analyze).not.toHaveBeenCalled();
        } finally {
            reserve.mockRestore();
            recordFailure.mockRestore();
            process.env.NODE_ENV = previousNodeEnv;
        }
    });

    it('keeps a model terminal result when budget settlement fails', async () => {
        const previousNodeEnv = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        const reserve = vi
            .spyOn(BackendPublicState, 'reserveModelBudget')
            .mockReturnValue({
                reservationId: 'reservation-1',
                reservedUsd: 0.35,
            });
        const settle = vi
            .spyOn(BackendPublicState, 'settleModelBudget')
            .mockImplementation(() => {
                throw new Error('sqlite unavailable');
            });
        try {
            const processing = startAnalysisJobForTest({
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                nowMs: 1_900_000_000_000,
                extractionStrategies: [
                    {
                        name: 'selected_fixture',
                        extract: (input) => ({
                            status: 'succeeded',
                            artifact: {
                                artifactId: 'settlement-transcript',
                                videoId: input.videoId,
                                algorithmVersion: input.algorithmVersion,
                                strategy: 'selected_fixture',
                                sourceType: 'local_fixture',
                                languageCode: 'en',
                                acquiredAtMs: input.nowMs,
                                videoDurationSec: 120,
                                segments: [
                                    {
                                        startSec: 0,
                                        durationSec: 1,
                                        text: 'hello',
                                    },
                                ],
                                transcriptText: 'hello',
                            },
                        }),
                    },
                ],
                analysisAdapter: {
                    providerId: 'test',
                    model: 'test',
                    promptVersion: 'test',
                    analyze: () =>
                        Promise.resolve({
                            rawModelResponse: '{"hasPromo":false}',
                            model: 'test',
                        }),
                },
            });
            const terminal =
                await BackendAnalysisJobs.waitForExtractionForTests(
                    processing.status === 'processing' ? processing.jobId : '',
                );

            expect(terminal?.status).toBe('no_promo');
            expect(settle).toHaveBeenCalledOnce();
        } finally {
            reserve.mockRestore();
            settle.mockRestore();
            process.env.NODE_ENV = previousNodeEnv;
        }
    });

    it('does not call the model for yt-dlp artifacts without duration', async () => {
        const analyze = vi.fn<() => Promise<BackendLlmAnalysisAdapterResult>>();
        const processing = startAnalysisJobForTest({
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: 1_900_000_000_000,
            extractionStrategies: [
                {
                    name: 'yt_dlp_without_duration',
                    extract: (input) => ({
                        status: 'succeeded',
                        artifact: {
                            artifactId: 'missing-duration-transcript',
                            videoId: input.videoId,
                            algorithmVersion: input.algorithmVersion,
                            strategy: 'yt_dlp_without_duration',
                            sourceType: 'youtube_yt_dlp',
                            languageCode: 'en',
                            acquiredAtMs: input.nowMs,
                            segments: [
                                {
                                    startSec: 0,
                                    durationSec: 1,
                                    text: 'hello',
                                },
                            ],
                            transcriptText: 'hello',
                        },
                    }),
                },
            ],
            analysisAdapter: {
                providerId: 'test',
                model: 'test',
                promptVersion: 'test',
                analyze,
            },
        });
        const terminal = await BackendAnalysisJobs.waitForExtractionForTests(
            processing.status === 'processing' ? processing.jobId : '',
        );

        expect(terminal).toMatchObject({
            status: 'unavailable',
            error: { code: 'video_unavailable' },
        });
        expect(analyze).not.toHaveBeenCalled();
    });

    it('keeps terminal state when artifact persistence throws', async () => {
        const save = vi
            .spyOn(AnalysisArtifactStore, 'save')
            .mockImplementation(() => {
                throw new Error('sqlite unavailable');
            });
        try {
            const processing = startAnalysisJobForTest({
                videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                nowMs: 1_900_000_000_000,
            });
            const terminal =
                await BackendAnalysisJobs.waitForExtractionForTests(
                    processing.status === 'processing' ? processing.jobId : '',
                );

            expect(terminal?.status).toBe('ready');
        } finally {
            save.mockRestore();
        }
    });
});
