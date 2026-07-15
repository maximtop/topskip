import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BackendApiProtection } from '@topskip/backend/api-protection';
import { AnalysisArtifactStore } from '@topskip/backend/analysis-artifact-store';
import { BackendAnalysisJobs } from '@topskip/backend/analysis-jobs';
import { BackendAnalysisApi } from '@topskip/backend/analysis-api';
import { BackendCacheFixtures } from '@topskip/backend/cache-fixtures';
import { OPENROUTER_GEMINI_MODEL } from '@topskip/backend/analysis/openrouter-gemini-analysis-adapter';
import { BACKEND_ANALYSIS_PROVIDER_ID } from '@topskip/backend/analysis/promo-analysis-types';
import { LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS } from '@topskip/backend/extraction/local-transcript-fixtures';
import { SERVER_ANALYSIS_ALGORITHM_VERSION } from '@topskip/common/server-analysis-contract';

function buildServerAnalysisRequest(input: {
    videoId: string;
    durationSec?: number;
    extensionVersion: string;
}): {
    videoId: string;
    durationSec?: number;
    extensionVersion: string;
    algorithmVersion: string;
    client: { source: 'chrome-extension'; capabilities: string[] };
} {
    return {
        videoId: input.videoId,
        durationSec: input.durationSec,
        extensionVersion: input.extensionVersion,
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        client: {
            source: 'chrome-extension',
            capabilities: ['processing-status'],
        },
    };
}

describe('BackendAnalysisApi', () => {
    beforeEach(() => {
        BackendAnalysisJobs.resetForTests();
        AnalysisArtifactStore.resetForTests();
        BackendApiProtection.resetForTests();
    });

    it('returns health metadata', () => {
        expect(BackendAnalysisApi.health()).toEqual({ ok: true });
    });

    it('returns processing for a valid analysis request', () => {
        const response = BackendAnalysisApi.handleAnalysisRequest({
            videoId: 'dQw4w9WgXcQ',
            extensionVersion: '0.1.0',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            client: {
                source: 'chrome-extension',
                capabilities: ['processing-status'],
            },
        });

        expect(response).toEqual({
            statusCode: 202,
            body: {
                status: 'processing',
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                jobId: 'local-dQw4w9WgXcQ-server-v4',
                pollAfterSec: 3,
            },
        });
    });

    it('rejects invalid video ids without starting work', () => {
        expect(
            BackendAnalysisApi.handleAnalysisRequest({
                videoId: 'short',
                extensionVersion: '0.1.0',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                client: {
                    source: 'chrome-extension',
                    capabilities: ['processing-status'],
                },
            }),
        ).toEqual({
            statusCode: 400,
            body: {
                status: 'error',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                error: {
                    code: 'invalid_video_id',
                },
            },
        });
    });

    it('rejects missing video ids without protection accounting or job creation', () => {
        const response = BackendAnalysisApi.handleAnalysisRequest({
            extensionVersion: '0.1.0',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            client: {
                source: 'chrome-extension',
                capabilities: ['processing-status'],
            },
        });

        expect(response.statusCode).toBe(400);
        expect(BackendAnalysisJobs.snapshotForTests().jobCount).toBe(0);
        expect(BackendApiProtection.snapshotForTests()).toMatchObject({
            cacheLookups: 0,
            jobJoins: 0,
            coldJobStarts: 0,
        });
    });

    it('ignores stale client algorithm versions and uses the active server version', () => {
        const fixtureCacheSpy = vi.spyOn(BackendCacheFixtures, 'findReady');
        const artifactCacheSpy = vi.spyOn(
            AnalysisArtifactStore,
            'findLatestCacheable',
        );
        const existingJobSpy = vi.spyOn(BackendAnalysisJobs, 'findExisting');
        const startJobSpy = vi.spyOn(BackendAnalysisJobs, 'start');

        const response = BackendAnalysisApi.handleAnalysisRequest({
            videoId: 'dQw4w9WgXcQ',
            extensionVersion: '0.1.0',
            algorithmVersion: 'server-v3',
            client: {
                source: 'chrome-extension',
                capabilities: ['processing-status'],
            },
        });

        expect(response).toMatchObject({
            statusCode: 202,
            body: {
                status: 'processing',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            },
        });
        expect(fixtureCacheSpy).toHaveBeenCalledOnce();
        expect(artifactCacheSpy).toHaveBeenCalledOnce();
        expect(existingJobSpy).toHaveBeenCalledOnce();
        expect(startJobSpy).toHaveBeenCalledOnce();
        vi.restoreAllMocks();
    });

    it('returns ready promo blocks for a seeded cache hit', () => {
        const response = BackendAnalysisApi.handleAnalysisRequest({
            videoId: 'e2eFixture1',
            extensionVersion: '0.1.0',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            client: {
                source: 'chrome-extension',
                capabilities: ['processing-status'],
            },
        });

        expect(response).toEqual({
            statusCode: 200,
            body: {
                status: 'ready',
                videoId: 'e2eFixture1',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                source: 'server_cache',
                sourceResultId: 'result-e2eFixture1-server-v4',
                freshness: { expiresAtMs: 4_102_444_800_000 },
                promoBlocks: [{ startSec: 4, endSec: 24, confidence: 'high' }],
            },
        });
    });

    it('serves cache and joined jobs before advisory duration rejection', () => {
        const cached = BackendAnalysisApi.handleAnalysisRequest(
            buildServerAnalysisRequest({
                videoId: 'e2eFixture1',
                durationSec: 18_001,
                extensionVersion: '0.1.0',
            }),
        );
        expect(cached.statusCode).toBe(200);

        const first = BackendAnalysisApi.handleAnalysisRequest(
            buildServerAnalysisRequest({
                videoId: 'dQw4w9WgXcQ',
                durationSec: 120,
                extensionVersion: '0.1.0',
            }),
        );
        const joined = BackendAnalysisApi.handleAnalysisRequest(
            buildServerAnalysisRequest({
                videoId: 'dQw4w9WgXcQ',
                durationSec: 18_001,
                extensionVersion: '0.1.0',
            }),
        );

        expect(joined).toEqual(first);
        expect(
            BackendAnalysisJobs.getDiagnosticsForTests(
                first.body.status === 'processing' ? first.body.jobId : '',
            )?.joinedRequestCount,
        ).toBe(1);
    });

    it('rejects advisory over-duration only after cache and join misses', () => {
        const response = BackendAnalysisApi.handleAnalysisRequest(
            buildServerAnalysisRequest({
                videoId: 'unknownVid1',
                durationSec: 18_001,
                extensionVersion: '0.1.0',
            }),
        );

        expect(response).toMatchObject({
            statusCode: 422,
            body: {
                status: 'unavailable',
                error: { code: 'video_too_long' },
            },
        });
        expect(BackendAnalysisJobs.snapshotForTests().jobCount).toBe(0);
        expect(BackendApiProtection.snapshotForTests()).toMatchObject({
            coldJobStarts: 0,
        });
    });

    it('routes seeded fixture videos into cold analysis in production', () => {
        const previousNodeEnv = process.env.NODE_ENV;
        const startSpy = vi
            .spyOn(BackendAnalysisJobs, 'start')
            .mockReturnValue({
                status: 'processing',
                videoId: 'e2eFixture1',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                jobId: 'local-e2eFixture1-server-v4',
                pollAfterSec: 3,
            });
        process.env.NODE_ENV = 'production';

        try {
            const response = BackendAnalysisApi.handleAnalysisRequest({
                videoId: 'e2eFixture1',
                extensionVersion: '0.1.0',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                client: {
                    source: 'chrome-extension',
                    capabilities: ['processing-status'],
                },
            });

            expect(response.statusCode).toBe(202);
            expect(startSpy).toHaveBeenCalledOnce();
        } finally {
            startSpy.mockRestore();
            if (previousNodeEnv === undefined) {
                delete process.env.NODE_ENV;
            } else {
                process.env.NODE_ENV = previousNodeEnv;
            }
        }
    });

    it('creates a local job for an uncached valid request', async () => {
        const response = BackendAnalysisApi.handleAnalysisRequest({
            videoId: 'dQw4w9WgXcQ',
            durationSec: 120,
            extensionVersion: '0.1.0',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            client: {
                source: 'chrome-extension',
                capabilities: ['processing-status'],
            },
        });

        expect(response.statusCode).toBe(202);
        expect(response.body.status).toBe('processing');
        if (response.body.status !== 'processing') {
            throw new Error('Expected processing response.');
        }
        await BackendAnalysisJobs.waitForExtractionForTests(
            response.body.jobId,
        );
        const status = BackendAnalysisApi.handleJobStatusRequest(
            response.body.jobId,
            { nowMs: 1_900_000_001_000 },
        );
        expect(status).toMatchObject({
            statusCode: 200,
            body: {
                status: 'ready',
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                source: 'server_cache',
                sourceResultId: 'result-dQw4w9WgXcQ-server-v4',
                promoBlocks: [
                    { startSec: 4, endSec: 24, confidence: 'high' },
                    { startSec: 35, endSec: 45, confidence: 'medium' },
                ],
            },
        });
        if (status.body.status !== 'ready') {
            throw new Error('Expected ready response.');
        }
        expect(status.body.freshness.expiresAtMs).toBeGreaterThan(Date.now());
    });

    it('returns ready blocks when polling a worker-backed cold job', async () => {
        const initial = BackendAnalysisApi.handleAnalysisRequest({
            videoId: 'dQw4w9WgXcQ',
            durationSec: 120,
            extensionVersion: '0.1.0',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            client: {
                source: 'chrome-extension',
                capabilities: ['processing-status'],
            },
        });

        expect(initial.statusCode).toBe(202);
        if (initial.body.status !== 'processing') {
            throw new Error('Expected processing response.');
        }
        await BackendAnalysisJobs.waitForExtractionForTests(initial.body.jobId);

        const status = BackendAnalysisApi.handleJobStatusRequest(
            initial.body.jobId,
            { nowMs: 1_900_000_001_000 },
        );

        expect(status).toMatchObject({
            statusCode: 200,
            body: {
                status: 'ready',
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                source: 'server_cache',
                sourceResultId: 'result-dQw4w9WgXcQ-server-v4',
                promoBlocks: [
                    { startSec: 4, endSec: 24, confidence: 'high' },
                    { startSec: 35, endSec: 45, confidence: 'medium' },
                ],
            },
        });
        if (status.body.status !== 'ready') {
            throw new Error('Expected ready response.');
        }
        expect(status.body.freshness.expiresAtMs).toBeGreaterThan(Date.now());
    });

    it('returns no-promo when polling the secondary worker-backed fixture', async () => {
        const initial = BackendAnalysisApi.handleAnalysisRequest({
            videoId: 'M7lc1UVf-VE',
            durationSec: 120,
            extensionVersion: '0.1.0',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            client: {
                source: 'chrome-extension',
                capabilities: ['processing-status'],
            },
        });

        expect(initial.statusCode).toBe(202);
        if (initial.body.status !== 'processing') {
            throw new Error('Expected processing response.');
        }
        await BackendAnalysisJobs.waitForExtractionForTests(initial.body.jobId);

        const status = BackendAnalysisApi.handleJobStatusRequest(
            initial.body.jobId,
            {
                nowMs: 1_900_000_001_000,
            },
        );
        expect(status).toMatchObject({
            statusCode: 200,
            body: {
                status: 'no_promo',
                videoId: 'M7lc1UVf-VE',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                sourceResultId: 'result-M7lc1UVf-VE-server-v4',
            },
        });
        if (status.body.status !== 'no_promo') {
            throw new Error('Expected no-promo response.');
        }
        expect(status.body.freshness.expiresAtMs).toBeGreaterThan(Date.now());

        BackendAnalysisJobs.resetForTests();
        const cached = BackendAnalysisApi.handleAnalysisRequest({
            videoId: 'M7lc1UVf-VE',
            durationSec: 120,
            extensionVersion: '0.1.0',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            client: {
                source: 'chrome-extension',
                capabilities: ['processing-status'],
            },
        });

        expect(cached).toEqual(status);
        expect(BackendAnalysisJobs.snapshotForTests().jobCount).toBe(0);
    });

    it('returns terminal unavailable when extraction cannot select a transcript', async () => {
        const response = BackendAnalysisApi.handleAnalysisRequest({
            videoId: 'unknownVid1',
            extensionVersion: '0.1.0',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            client: {
                source: 'chrome-extension',
                capabilities: ['processing-status'],
            },
        });

        if (response.body.status !== 'processing') {
            throw new Error('Expected processing response.');
        }
        await BackendAnalysisJobs.waitForExtractionForTests(
            response.body.jobId,
        );
        const terminal = BackendAnalysisApi.handleJobStatusRequest(
            response.body.jobId,
        );
        expect(terminal.statusCode).toBe(200);
        expect(terminal.body).toMatchObject({
            status: 'unavailable',
            videoId: 'unknownVid1',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        });
        if (terminal.body.status !== 'unavailable') {
            throw new Error('Expected unavailable response.');
        }
        expect(terminal.body.error.code).toBe('caption_extraction_failed');
        expect(terminal.body.error.supportId).toMatch(/^support-/u);
        expect(BackendAnalysisJobs.snapshotForTests().jobCount).toBe(1);
    });

    it('returns the existing active job for duplicate cold analysis requests', async () => {
        const request = {
            videoId: 'dQw4w9WgXcQ',
            extensionVersion: '0.1.0',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            client: {
                source: 'chrome-extension',
                capabilities: ['processing-status'],
            },
        };

        const first = BackendAnalysisApi.handleAnalysisRequest(request);
        if (first.body.status !== 'processing') {
            throw new Error('Expected processing response.');
        }
        await BackendAnalysisJobs.waitForExtractionForTests(first.body.jobId);
        const terminal = BackendAnalysisApi.handleJobStatusRequest(
            first.body.jobId,
            { nowMs: 1_900_000_001_000 },
        );
        const second = BackendAnalysisApi.handleAnalysisRequest(request);

        expect(first.statusCode).toBe(202);
        expect(second.statusCode).toBe(200);
        expect(second.body).toEqual(terminal.body);
    });

    it('uses stored ready artifacts as cache hits before starting cold work', async () => {
        BackendAnalysisJobs.resetForTests();
        AnalysisArtifactStore.resetForTests();
        BackendApiProtection.resetForTests();

        const processing = BackendAnalysisApi.handleAnalysisRequest(
            buildServerAnalysisRequest({
                videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
                durationSec: 120,
                extensionVersion: '0.1.0',
            }),
            { nowMs: 1_900_000_000_000 },
        );
        expect(processing.statusCode).toBe(202);
        if (processing.body.status !== 'processing') {
            throw new Error('Expected processing response.');
        }
        await BackendAnalysisJobs.waitForExtractionForTests(
            processing.body.jobId,
        );
        BackendAnalysisJobs.getStatus(processing.body.jobId, {
            nowMs: 1_900_000_001_000,
        });
        BackendAnalysisJobs.resetForTests();

        const cached = BackendAnalysisApi.handleAnalysisRequest(
            buildServerAnalysisRequest({
                videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
                durationSec: 120,
                extensionVersion: '0.1.0',
            }),
            { nowMs: 1_900_000_002_000 },
        );

        expect(cached).toMatchObject({
            statusCode: 200,
            body: { status: 'ready', source: 'server_cache' },
        });
        expect(BackendAnalysisJobs.snapshotForTests().jobCount).toBe(0);
    });

    it('reuses persisted Gemini no-promo artifacts without starting a provider job', () => {
        const record = AnalysisArtifactStore.buildRecordForTests({
            videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Secondary,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            terminalStatus: 'no_promo',
        });
        if (record.analysisRun === null) {
            throw new Error('Expected a complete no-promo analysis artifact.');
        }
        AnalysisArtifactStore.save({
            ...record,
            analysisRun: {
                ...record.analysisRun,
                provider: BACKEND_ANALYSIS_PROVIDER_ID.OpenRouter,
                model: OPENROUTER_GEMINI_MODEL,
            },
        });
        AnalysisArtifactStore.resetRuntimeCacheForTests();
        const startSpy = vi.spyOn(BackendAnalysisJobs, 'start');

        try {
            const cached = BackendAnalysisApi.handleAnalysisRequest(
                buildServerAnalysisRequest({
                    videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Secondary,
                    durationSec: 120,
                    extensionVersion: '0.1.0',
                }),
            );

            expect(cached).toMatchObject({
                statusCode: 200,
                body: { status: 'no_promo' },
            });
            expect(startSpy).not.toHaveBeenCalled();
        } finally {
            startSpy.mockRestore();
        }
    });

    it('serves completed worker-backed artifacts from the durable cache', async () => {
        BackendAnalysisJobs.resetForTests();
        AnalysisArtifactStore.resetForTests();
        BackendApiProtection.resetForTests();

        const first = BackendAnalysisApi.handleAnalysisRequest(
            buildServerAnalysisRequest({
                videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
                durationSec: 120,
                extensionVersion: '0.1.0',
            }),
            { nowMs: 1_900_000_000_000 },
        );
        if (first.body.status !== 'processing') {
            throw new Error('Expected processing response.');
        }
        await BackendAnalysisJobs.waitForExtractionForTests(first.body.jobId);

        BackendAnalysisJobs.completeFixture({
            jobId: first.body.jobId,
            status: 'ready',
            nowMs: 1_900_000_001_000,
        });
        BackendAnalysisJobs.resetForTests();

        const second = BackendAnalysisApi.handleAnalysisRequest(
            buildServerAnalysisRequest({
                videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
                durationSec: 120,
                extensionVersion: '0.1.0',
            }),
            { nowMs: 1_900_000_002_000 },
        );

        expect(second.statusCode).toBe(200);
        expect(second.body.status).toBe('ready');
    });

    it('rate-limits only new cold job starts', () => {
        const requestFor = (videoId: string) => ({
            videoId,
            extensionVersion: '0.1.0',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            client: {
                source: 'chrome-extension',
                capabilities: ['processing-status'],
            },
        });

        expect(
            BackendAnalysisApi.handleAnalysisRequest(
                requestFor('dQw4w9WgXcQ'),
                {
                    nowMs: 1_900_000_000_000,
                },
            ).statusCode,
        ).toBe(202);
        expect(
            BackendAnalysisApi.handleAnalysisRequest(
                requestFor('M7lc1UVf-VE'),
                {
                    nowMs: 1_900_000_001_000,
                },
            ).statusCode,
        ).toBe(202);

        const limited = BackendAnalysisApi.handleAnalysisRequest(
            requestFor('aqz-KE-bpKQ'),
            { nowMs: 1_900_000_002_000 },
        );

        expect(limited).toEqual({
            statusCode: 429,
            body: {
                status: 'rate_limited',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                error: {
                    code: 'rate_limited',
                    retryAfterSec: 58,
                },
            },
        });
        expect(BackendAnalysisJobs.snapshotForTests().jobCount).toBe(2);
    });

    it('does not run extraction for rate-limited cold starts', () => {
        const requestFor = (videoId: string) => ({
            videoId,
            extensionVersion: '0.1.0',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            client: {
                source: 'chrome-extension',
                capabilities: ['processing-status'],
            },
        });

        BackendAnalysisApi.handleAnalysisRequest(requestFor('dQw4w9WgXcQ'), {
            nowMs: 1_900_000_000_000,
        });
        BackendAnalysisApi.handleAnalysisRequest(requestFor('M7lc1UVf-VE'), {
            nowMs: 1_900_000_001_000,
        });
        const limited = BackendAnalysisApi.handleAnalysisRequest(
            requestFor('unknownVid1'),
            { nowMs: 1_900_000_002_000 },
        );

        expect(limited.statusCode).toBe(429);
        expect(
            BackendAnalysisJobs.getDiagnosticsForTests(
                'local-unknownVid1-server-v4',
            ),
        ).toBeNull();
    });

    it('does not spend cold-start quota for duplicate active jobs or cache hits', () => {
        const coldRequest = {
            videoId: 'dQw4w9WgXcQ',
            extensionVersion: '0.1.0',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            client: {
                source: 'chrome-extension',
                capabilities: ['processing-status'],
            },
        };

        const first = BackendAnalysisApi.handleAnalysisRequest(coldRequest, {
            nowMs: 1_900_000_000_000,
        });
        const duplicate = BackendAnalysisApi.handleAnalysisRequest(
            coldRequest,
            {
                nowMs: 1_900_000_001_000,
            },
        );
        const cacheHit = BackendAnalysisApi.handleAnalysisRequest(
            {
                ...coldRequest,
                videoId: 'e2eFixture1',
            },
            {
                nowMs: 1_900_000_002_000,
            },
        );

        expect(duplicate.body).toEqual(first.body);
        expect(cacheHit.statusCode).toBe(200);
        expect(BackendApiProtection.snapshotForTests()).toMatchObject({
            cacheLookups: 1,
            jobJoins: 1,
            coldJobStarts: 1,
        });
    });

    it('starts fresh work after a terminal job is no longer active', () => {
        const request = {
            videoId: 'dQw4w9WgXcQ',
            extensionVersion: '0.1.0',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            client: {
                source: 'chrome-extension',
                capabilities: ['processing-status'],
            },
        };

        const first = BackendAnalysisApi.handleAnalysisRequest(request);
        if (first.body.status !== 'processing') {
            throw new Error('Expected processing response.');
        }
        const terminal = BackendAnalysisApi.handleFixtureCompletionRequest(
            first.body.jobId,
            { status: 'unavailable' },
        );
        const duplicate = BackendAnalysisApi.handleAnalysisRequest(request);

        expect(terminal.statusCode).toBe(200);
        expect(duplicate.statusCode).toBe(202);
        expect(duplicate.body.status).toBe('processing');
    });

    it('returns typed job_not_found errors for unknown status reads', () => {
        const response =
            BackendAnalysisApi.handleJobStatusRequest('missing-job');

        expect(response).toEqual({
            statusCode: 404,
            body: {
                status: 'error',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                error: {
                    code: 'job_not_found',
                },
            },
        });
    });
});
