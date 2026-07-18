import * as v from 'valibot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BackendApiProtection } from '@topskip/backend/api-protection';
import { AnalysisArtifactStore } from '@topskip/backend/analysis-artifact-store';
import { BackendAnalysisApi } from '@topskip/backend/analysis-api';
import { BackendAnalysisJobs } from '@topskip/backend/analysis-jobs';
import { BackendPublicState } from '@topskip/backend/public-state';
import { BACKEND_CAPTION_SOURCE } from '@topskip/backend/server-config';
import { TranscriptFingerprint } from '@topskip/backend/transcript-fingerprint';
import {
    transcriptArtifactSchema,
    type TranscriptArtifact,
} from '@topskip/backend/extraction/subtitle-extraction-types';
import {
    CaptionTranscriptCanonicalizer,
    MAX_TRANSCRIPT_CHARACTER_COUNT,
    MAX_TRANSCRIPT_TIMELINE_SEC,
} from '@topskip/common/captions/canonical-transcript';
import {
    SERVER_ANALYSIS_ALGORITHM_VERSION,
    type ServerAnalysisRequest,
} from '@topskip/common/server-analysis-contract';

const TEST_NOW_MS = 1_900_000_000_000;
const PRIMARY_VIDEO_ID = 'dQw4w9WgXcQ';
const SECONDARY_VIDEO_ID = 'M7lc1UVf-VE';
const THIRD_VIDEO_ID = 'aqz-KE-bpKQ';

const BASE_SEGMENTS = [
    { startSec: 0, durationSec: 2, text: 'Introduction' },
    { startSec: 4, durationSec: 56, text: 'Buy this useful product' },
];

function buildUploadRequest(
    overrides: Partial<ServerAnalysisRequest> = {},
): ServerAnalysisRequest {
    return {
        videoId: PRIMARY_VIDEO_ID,
        extensionVersion: '0.1.0',
        languageCode: 'en',
        segments: BASE_SEGMENTS.map((segment) => ({ ...segment })),
        client: {
            source: 'chrome-extension',
            capabilities: ['processing-status', 'typed-server-errors-v1'],
        },
        ...overrides,
    };
}

function buildUploadArtifact(
    request: ServerAnalysisRequest,
): TranscriptArtifact {
    const canonical = CaptionTranscriptCanonicalizer.canonicalize({
        languageCode: request.languageCode,
        segments: request.segments,
    });
    if (!canonical.ok) {
        throw new Error('Expected a canonical test transcript.');
    }
    const transcriptHash = TranscriptFingerprint.sha256Hex(
        canonical.transcript.canonicalBytes,
    );
    return v.parse(transcriptArtifactSchema, {
        artifactId: 'transcript-test-upload',
        videoId: request.videoId,
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        strategy: 'extension_caption_upload',
        sourceType: 'extension_caption_upload',
        languageCode: canonical.transcript.languageCode,
        transcriptHash,
        videoDurationSec: canonical.transcript.timelineEndSec,
        acquiredAtMs: TEST_NOW_MS,
        segments: canonical.transcript.segments,
        transcriptText: canonical.transcript.segments
            .map((segment) => segment.text)
            .join(' '),
    });
}

describe('BackendAnalysisApi', () => {
    beforeEach(() => {
        BackendAnalysisJobs.resetForTests();
        AnalysisArtifactStore.resetForTests();
        BackendApiProtection.resetForTests();
        BackendPublicState.resetForTests();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('returns minimal health metadata', () => {
        expect(BackendAnalysisApi.health()).toEqual({ ok: true });
    });

    it('canonicalizes an upload before any lookup', () => {
        const exactLookup = vi
            .spyOn(AnalysisArtifactStore, 'findLatestCacheableExact')
            .mockReturnValue(null);
        const start = vi
            .spyOn(BackendAnalysisJobs, 'start')
            .mockImplementation((input) => {
                if (
                    !('source' in input) ||
                    input.source !== 'extension_upload'
                ) {
                    throw new Error('Expected an upload job.');
                }
                return {
                    status: 'processing',
                    ...input.identity,
                    jobId: `job-${start.mock.calls.length}`,
                    pollAfterSec: 3,
                };
            });

        const submit = (request: ServerAnalysisRequest) => {
            BackendApiProtection.resetForTests();
            const response = BackendAnalysisApi.handleAnalysisRequest(request, {
                nowMs: TEST_NOW_MS,
            });
            expect(response.statusCode).toBe(202);
            const lookup = exactLookup.mock.calls.at(-1)?.[0];
            const startInput = start.mock.calls.at(-1)?.[0];
            if (
                lookup === undefined ||
                startInput === undefined ||
                !('source' in startInput) ||
                startInput.source !== 'extension_upload'
            ) {
                throw new Error('Expected exact upload orchestration.');
            }
            return {
                identity: lookup,
                artifact: startInput.transcriptArtifact,
            };
        };

        const equivalentA = submit(
            buildUploadRequest({
                languageCode: ' EN ',
                segments: [
                    {
                        startSec: -0,
                        durationSec: 2,
                        text: ' Cafe\u0301\r\npromo ',
                    },
                ],
                durationSec: 0,
            }),
        );
        const equivalentB = submit(
            buildUploadRequest({
                languageCode: 'en',
                segments: [
                    {
                        startSec: 0,
                        durationSec: 2,
                        text: 'Café\npromo',
                    },
                ],
                durationSec: 1_000,
            }),
        );

        expect(equivalentA.identity).toEqual(equivalentB.identity);
        expect(equivalentA.artifact.segments).toEqual(
            equivalentB.artifact.segments,
        );
        expect(equivalentA.artifact.videoDurationSec).toBe(2);
        expect(equivalentB.artifact.videoDurationSec).toBe(2);

        const changedLanguage = submit(
            buildUploadRequest({ languageCode: 'fr' }),
        );
        const changedText = submit(
            buildUploadRequest({
                segments: [
                    { startSec: 0, durationSec: 2, text: 'Different text' },
                ],
            }),
        );
        const changedTiming = submit(
            buildUploadRequest({
                segments: [
                    { startSec: 1, durationSec: 2, text: 'Introduction' },
                    {
                        startSec: 4,
                        durationSec: 56,
                        text: 'Buy this useful product',
                    },
                ],
            }),
        );
        const changedSegmentation = submit(
            buildUploadRequest({
                segments: [
                    { startSec: 0, durationSec: 1, text: 'Introduction' },
                    {
                        startSec: 1,
                        durationSec: 1,
                        text: 'Buy this useful product',
                    },
                ],
            }),
        );
        const changedVideo = submit(
            buildUploadRequest({ videoId: SECONDARY_VIDEO_ID }),
        );
        const baseline = submit(buildUploadRequest());

        expect(changedLanguage.identity.languageCode).toBe('fr');
        expect(changedLanguage.identity.transcriptHash).toBe(
            baseline.identity.transcriptHash,
        );
        expect(changedText.identity.transcriptHash).not.toBe(
            baseline.identity.transcriptHash,
        );
        expect(changedTiming.identity.transcriptHash).not.toBe(
            baseline.identity.transcriptHash,
        );
        expect(changedSegmentation.identity.transcriptHash).not.toBe(
            baseline.identity.transcriptHash,
        );
        expect(changedVideo.identity.videoId).toBe(SECONDARY_VIDEO_ID);
        expect(baseline.identity.algorithmVersion).toBe(
            SERVER_ANALYSIS_ALGORITHM_VERSION,
        );

        expect(
            BackendAnalysisApi.handleAnalysisRequest({
                ...buildUploadRequest(),
                algorithmVersion: 'client-owned-version',
                transcriptHash: '0'.repeat(64),
            }),
        ).toMatchObject({
            statusCode: 400,
            body: { status: 'error', error: { code: 'invalid_request' } },
        });
    });

    it('uses only the exact uploaded artifact cache', () => {
        const request = buildUploadRequest();
        const uploadArtifact = buildUploadArtifact(request);
        const legacyRecord = AnalysisArtifactStore.buildRecordForTests({
            videoId: request.videoId,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            terminalStatus: 'ready',
        });
        const exactRecord = AnalysisArtifactStore.buildRecordForTests({
            videoId: request.videoId,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            terminalStatus: 'ready',
            selectedTranscriptArtifact: uploadArtifact,
        });
        AnalysisArtifactStore.save(legacyRecord);
        AnalysisArtifactStore.save(exactRecord);
        const start = vi.spyOn(BackendAnalysisJobs, 'start');

        const cached = BackendAnalysisApi.handleAnalysisRequest(request, {
            nowMs: TEST_NOW_MS,
        });
        expect(cached).toMatchObject({
            statusCode: 200,
            body: {
                status: 'ready',
                videoId: request.videoId,
                languageCode: uploadArtifact.languageCode,
                transcriptHash: uploadArtifact.transcriptHash,
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            },
        });
        expect(start).not.toHaveBeenCalled();
        expect(BackendApiProtection.snapshotForTests()).toMatchObject({
            cacheLookups: 1,
            coldJobStarts: 0,
        });

        const differentLanguage = BackendAnalysisApi.handleAnalysisRequest(
            buildUploadRequest({ languageCode: 'fr' }),
            { nowMs: TEST_NOW_MS + 1 },
        );
        expect(differentLanguage.statusCode).toBe(202);
        expect(start).toHaveBeenCalledOnce();
    });

    it('joins only an exact upload job and authorizes every joining installation', () => {
        const request = buildUploadRequest();
        const first = BackendAnalysisApi.handleAnalysisRequest(request, {
            nowMs: TEST_NOW_MS,
            context: {
                installationHash: 'installation-a',
                ipHash: 'ip-a',
            },
        });
        const joined = BackendAnalysisApi.handleAnalysisRequest(request, {
            nowMs: TEST_NOW_MS + 1,
            context: {
                installationHash: 'installation-b',
                ipHash: 'ip-b',
            },
        });

        expect(first.statusCode).toBe(202);
        expect(joined).toEqual(first);
        if (first.body.status !== 'processing') {
            throw new Error('Expected processing response.');
        }
        expect(
            BackendAnalysisApi.handleJobStatusRequest(first.body.jobId, {
                installationHash: 'installation-a',
            }).statusCode,
        ).not.toBe(404);
        expect(
            BackendAnalysisApi.handleJobStatusRequest(first.body.jobId, {
                installationHash: 'installation-b',
            }).statusCode,
        ).not.toBe(404);
        expect(
            BackendAnalysisApi.handleJobStatusRequest(first.body.jobId, {
                installationHash: 'installation-c',
            }),
        ).toMatchObject({
            statusCode: 404,
            body: { error: { code: 'job_not_found' } },
        });
        expect(BackendApiProtection.snapshotForTests()).toMatchObject({
            jobJoins: 1,
            coldJobStarts: 1,
        });

        const different = BackendAnalysisApi.handleAnalysisRequest(
            buildUploadRequest({
                segments: [
                    { startSec: 0, durationSec: 2, text: 'Revised captions' },
                ],
            }),
            {
                nowMs: TEST_NOW_MS + 2,
                context: {
                    installationHash: 'installation-b',
                    ipHash: 'ip-b',
                },
            },
        );
        expect(different.statusCode).toBe(202);
        expect(different.body).not.toEqual(first.body);
    });

    it('preserves exact identity through processing and terminal states', async () => {
        const initial = BackendAnalysisApi.handleAnalysisRequest(
            buildUploadRequest({ durationSec: 0 }),
            { nowMs: TEST_NOW_MS },
        );
        expect(initial.statusCode).toBe(202);
        if (
            initial.body.status !== 'processing' ||
            !('languageCode' in initial.body) ||
            !('transcriptHash' in initial.body)
        ) {
            throw new Error('Expected processing response.');
        }
        const identity = {
            videoId: initial.body.videoId,
            languageCode: initial.body.languageCode,
            transcriptHash: initial.body.transcriptHash,
            algorithmVersion: initial.body.algorithmVersion,
        };

        await BackendAnalysisJobs.waitForExtractionForTests(initial.body.jobId);
        const terminal = BackendAnalysisApi.handleJobStatusRequest(
            initial.body.jobId,
        );
        expect(terminal).toMatchObject({
            statusCode: 200,
            body: { status: 'ready', ...identity },
        });
        expect(
            BackendAnalysisJobs.getDiagnosticsForTests(initial.body.jobId),
        ).toMatchObject({
            extractionAttempts: [],
            selectedTranscriptArtifact: {
                sourceType: 'extension_caption_upload',
                videoDurationSec: 60,
                ...identity,
            },
        });

        BackendAnalysisJobs.resetForTests();
        const cachedWithDifferentHint =
            BackendAnalysisApi.handleAnalysisRequest(
                buildUploadRequest({ durationSec: 10_000 }),
                { nowMs: TEST_NOW_MS + 1 },
            );
        expect(cachedWithDifferentHint).toMatchObject({
            statusCode: 200,
            body: { ...identity },
        });
    });

    it('returns an identified rate failure without starting a third cold job', () => {
        const submit = (videoId: string, nowMs: number) =>
            BackendAnalysisApi.handleAnalysisRequest(
                buildUploadRequest({ videoId }),
                { nowMs },
            );
        expect(submit(PRIMARY_VIDEO_ID, TEST_NOW_MS).statusCode).toBe(202);
        expect(submit(SECONDARY_VIDEO_ID, TEST_NOW_MS + 1).statusCode).toBe(
            202,
        );
        const limited = submit(THIRD_VIDEO_ID, TEST_NOW_MS + 2);

        expect(limited).toMatchObject({
            statusCode: 429,
            body: {
                status: 'rate_limited',
                videoId: THIRD_VIDEO_ID,
                languageCode: 'en',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                error: { code: 'rate_limited', retryAfterSec: 60 },
            },
        });
        if (!('transcriptHash' in limited.body)) {
            throw new Error('Expected an identified rate limit.');
        }
        expect(limited.body.transcriptHash).toMatch(/^[0-9a-f]{64}$/u);
        expect(BackendAnalysisJobs.snapshotForTests().jobCount).toBe(2);
    });

    it('rejects unsafe transcripts before cache, jobs, or model work', () => {
        const lookup = vi.spyOn(
            AnalysisArtifactStore,
            'findLatestCacheableExact',
        );
        const start = vi.spyOn(BackendAnalysisJobs, 'start');
        const tooLong = BackendAnalysisApi.handleAnalysisRequest(
            buildUploadRequest({
                segments: [
                    {
                        startSec: MAX_TRANSCRIPT_TIMELINE_SEC,
                        durationSec: 0.001,
                        text: 'Past the boundary',
                    },
                ],
            }),
        );
        const tooLarge = BackendAnalysisApi.handleAnalysisRequest(
            buildUploadRequest({
                segments: [
                    {
                        startSec: 0,
                        durationSec: 1,
                        text: 'x'.repeat(MAX_TRANSCRIPT_CHARACTER_COUNT + 1),
                    },
                ],
            }),
        );
        const malformed = BackendAnalysisApi.handleAnalysisRequest(
            buildUploadRequest({
                segments: [{ startSec: 0, durationSec: 1, text: '   ' }],
            }),
        );

        expect(tooLong).toMatchObject({
            statusCode: 422,
            body: { error: { code: 'video_too_long' } },
        });
        expect(tooLarge).toMatchObject({
            statusCode: 422,
            body: { error: { code: 'transcript_too_large' } },
        });
        expect(malformed).toMatchObject({
            statusCode: 400,
            body: { error: { code: 'invalid_request' } },
        });
        expect(lookup).not.toHaveBeenCalled();
        expect(start).not.toHaveBeenCalled();
    });

    it('routes metadata only in legacy process mode', async () => {
        const legacyLookup = vi.spyOn(
            AnalysisArtifactStore,
            'findLatestLegacyCacheable',
        );
        const exactLookup = vi.spyOn(
            AnalysisArtifactStore,
            'findLatestCacheableExact',
        );
        const metadataRequest = {
            videoId: PRIMARY_VIDEO_ID,
            durationSec: 120,
            extensionVersion: '0.1.0',
            algorithmVersion: 'ignored-client-version',
            client: {
                source: 'chrome-extension',
                capabilities: ['processing-status'],
            },
        };

        expect(
            BackendAnalysisApi.handleAnalysisRequest(metadataRequest),
        ).toMatchObject({
            statusCode: 400,
            body: { error: { code: 'invalid_request' } },
        });
        const processing = BackendAnalysisApi.handleAnalysisRequest(
            metadataRequest,
            {
                nowMs: TEST_NOW_MS,
                captionSource: BACKEND_CAPTION_SOURCE.LegacyYtDlp,
            },
        );
        expect(processing).toMatchObject({
            statusCode: 202,
            body: {
                status: 'processing',
                videoId: PRIMARY_VIDEO_ID,
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            },
        });
        expect(processing.body).not.toHaveProperty('languageCode');
        expect(processing.body).not.toHaveProperty('transcriptHash');
        expect(legacyLookup).toHaveBeenCalledOnce();
        expect(exactLookup).not.toHaveBeenCalled();

        if (processing.body.status !== 'processing') {
            throw new Error('Expected legacy processing response.');
        }
        await BackendAnalysisJobs.waitForExtractionForTests(
            processing.body.jobId,
        );
        expect(
            BackendAnalysisJobs.getDiagnosticsForTests(processing.body.jobId)
                ?.extractionAttempts.length,
        ).toBeGreaterThan(0);

        expect(
            BackendAnalysisApi.handleAnalysisRequest(buildUploadRequest(), {
                captionSource: BACKEND_CAPTION_SOURCE.LegacyYtDlp,
            }),
        ).toMatchObject({
            statusCode: 400,
            body: { error: { code: 'invalid_request' } },
        });
    });

    it('keeps the seeded video-only fixture private to legacy mode', () => {
        const upload = BackendAnalysisApi.handleAnalysisRequest(
            buildUploadRequest({ videoId: 'e2eFixture1' }),
            { nowMs: TEST_NOW_MS },
        );
        expect(upload.statusCode).toBe(202);

        BackendAnalysisJobs.resetForTests();
        BackendApiProtection.resetForTests();
        const legacy = BackendAnalysisApi.handleAnalysisRequest(
            {
                videoId: 'e2eFixture1',
                extensionVersion: '0.1.0',
                client: {
                    source: 'chrome-extension',
                    capabilities: ['processing-status'],
                },
            },
            {
                nowMs: TEST_NOW_MS,
                captionSource: BACKEND_CAPTION_SOURCE.LegacyYtDlp,
            },
        );
        expect(legacy).toMatchObject({
            statusCode: 200,
            body: {
                status: 'ready',
                videoId: 'e2eFixture1',
                sourceResultId: 'result-e2eFixture1-server-v5',
            },
        });
        expect(legacy.body).not.toHaveProperty('transcriptHash');
    });

    it('returns typed job_not_found for an unrelated poller', () => {
        expect(
            BackendAnalysisApi.handleJobStatusRequest('missing-job'),
        ).toEqual({
            statusCode: 404,
            body: {
                status: 'error',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                error: { code: 'job_not_found' },
            },
        });
    });
});
