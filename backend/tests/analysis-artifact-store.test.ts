import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import * as v from 'valibot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    AnalysisArtifactStore,
    analysisArtifactRecordSchema,
} from '@topskip/backend/analysis-artifact-store';
import { BACKEND_ANALYSIS_PROVIDER_ID_MAX_LENGTH } from '@topskip/backend/analysis/promo-analysis-types';
import {
    transcriptArtifactSchema,
    type TranscriptArtifact,
} from '@topskip/backend/extraction/subtitle-extraction-types';
import { BackendPublicState } from '@topskip/backend/public-state';
import { SERVER_ANALYSIS_ALGORITHM_VERSION } from '@topskip/common/server-analysis-contract';

const TRANSCRIPT_HASH = 'a'.repeat(64);
const OTHER_TRANSCRIPT_HASH = 'b'.repeat(64);
type UploadedTranscriptArtifact = Extract<
    TranscriptArtifact,
    { sourceType: 'extension_caption_upload' }
>;

function buildUploadedTranscriptArtifact(
    overrides: Partial<TranscriptArtifact> = {},
): UploadedTranscriptArtifact {
    const artifact = v.parse(transcriptArtifactSchema, {
        artifactId: 'transcript-123e4567-e89b-42d3-a456-426614174000',
        videoId: 'dQw4w9WgXcQ',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        strategy: 'extension_caption_upload',
        sourceType: 'extension_caption_upload',
        languageCode: 'en-us',
        transcriptHash: TRANSCRIPT_HASH,
        acquiredAtMs: 1_900_000_000_000,
        segments: [
            { startSec: 4, durationSec: 20, text: 'Canonical caption text.' },
        ],
        transcriptText: 'Canonical caption text.',
        ...overrides,
    });
    if (artifact.sourceType !== 'extension_caption_upload') {
        throw new Error('Expected an uploaded transcript fixture.');
    }
    return artifact;
}

describe('AnalysisArtifactStore', () => {
    let persistenceDirectory: string | null = null;

    beforeEach(() => {
        AnalysisArtifactStore.resetStoragePathForTests();
        AnalysisArtifactStore.resetForTests();
    });

    afterEach(() => {
        vi.useRealTimers();
        AnalysisArtifactStore.resetForTests();
        AnalysisArtifactStore.resetStoragePathForTests();
        if (persistenceDirectory !== null) {
            rmSync(persistenceDirectory, { force: true, recursive: true });
        }
    });

    it('persists only allow-listed bounded operational diagnostics', () => {
        const record = AnalysisArtifactStore.buildRecordForTests({
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            terminalStatus: 'unavailable',
        });
        const saved = AnalysisArtifactStore.save({
            ...record,
            operationalMetadata: {
                ...record.operationalMetadata,
                diagnostics: {
                    artifactSource: 'local_backend',
                    provider: 'openrouter',
                    authorization: 'Bearer sk-secret',
                    cookie: 'SID=youtube-account-token',
                    transcript: 'Raw caption text must not be retained.',
                    providerError: 'Raw provider failure must not be retained.',
                    signedUrl:
                        'https://captions.example/video?signature=sensitive',
                    rawData: '{"provider":"envelope"}',
                },
            },
        });

        const serialized = JSON.stringify(
            v.parse(analysisArtifactRecordSchema, saved),
        );
        expect(saved.operationalMetadata.diagnostics).toEqual({
            artifactSource: 'local_backend',
            provider: 'openrouter',
        });
        expect(serialized).not.toContain('sk-secret');
        expect(serialized).not.toContain('youtube-account-token');
        expect(serialized).not.toContain('Raw caption text');
        expect(serialized).not.toContain('Raw provider failure');
        expect(serialized).not.toContain('signature=sensitive');
        expect(serialized).not.toContain('provider":"envelope');
    });

    it('drops unbounded or payload-shaped values even for allow-listed keys', () => {
        const acceptedProvider = 'a'.repeat(
            BACKEND_ANALYSIS_PROVIDER_ID_MAX_LENGTH,
        );
        const accepted = AnalysisArtifactStore.buildRecordForTests({
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            terminalStatus: 'unavailable',
            operationalMetadata: {
                diagnostics: { provider: acceptedProvider },
            },
        });
        expect(accepted.operationalMetadata.diagnostics.provider).toBe(
            acceptedProvider,
        );

        for (const provider of [
            'a'.repeat(BACKEND_ANALYSIS_PROVIDER_ID_MAX_LENGTH + 1),
            'https://provider.example/signed?token=secret',
            'Raw provider error: quota exhausted',
        ]) {
            const record = AnalysisArtifactStore.buildRecordForTests({
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                terminalStatus: 'unavailable',
                operationalMetadata: { diagnostics: { provider } },
            });
            expect(record.operationalMetadata.diagnostics).toEqual({
                artifactSource: 'test_fixture',
            });
        }

        const invalidSourceInput = JSON.parse(
            JSON.stringify({
                ...accepted,
                operationalMetadata: {
                    ...accepted.operationalMetadata,
                    diagnostics: { artifactSource: 'client_transcript' },
                },
            }),
        ) as unknown;
        const invalidSource = v.parse(
            analysisArtifactRecordSchema,
            invalidSourceInput,
        );
        expect(invalidSource.operationalMetadata.diagnostics).toEqual({});
    });

    it('keeps the cwd production artifact store untouched during Vitest resets', () => {
        const directory = mkdtempSync(join(tmpdir(), 'topskip-test-cwd-'));
        persistenceDirectory = directory;
        const productionStoragePath = join(
            directory,
            '.topskip-data',
            'analysis-artifacts.json',
        );
        const sentinel = '{"production":"keep"}';
        mkdirSync(dirname(productionStoragePath), { recursive: true });
        writeFileSync(productionStoragePath, sentinel, 'utf8');
        const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(directory);

        try {
            AnalysisArtifactStore.resetStoragePathForTests();
            AnalysisArtifactStore.save(
                AnalysisArtifactStore.buildRecordForTests({
                    videoId: 'dQw4w9WgXcQ',
                    algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                    terminalStatus: 'ready',
                }),
            );
            AnalysisArtifactStore.resetForTests();

            expect(readFileSync(productionStoragePath, 'utf8')).toBe(sentinel);
        } finally {
            cwdSpy.mockRestore();
        }
    });

    it('rejects ready artifact records without transcript and analysis artifacts', () => {
        expect(() =>
            AnalysisArtifactStore.buildRecordForTests({
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                terminalStatus: 'ready',
                selectedTranscriptArtifact: null,
                analysisRun: null,
            }),
        ).toThrow();
    });

    it('requires canonical identity and transcript fields for extension uploads', () => {
        const valid = buildUploadedTranscriptArtifact();
        expect(valid.sourceType).toBe('extension_caption_upload');

        for (const overrides of [
            { languageCode: null },
            { languageCode: 'EN-us' },
            { languageCode: ' en-us ' },
            { transcriptHash: 'A'.repeat(64) },
            { transcriptHash: 'a'.repeat(63) },
            {
                segments: [
                    {
                        startSec: 4,
                        durationSec: 20,
                        text: ' Canonical caption text. ',
                    },
                ],
            },
            { transcriptText: 'Client-supplied alternative text.' },
        ]) {
            expect(
                v.safeParse(transcriptArtifactSchema, {
                    ...valid,
                    ...overrides,
                }).success,
            ).toBe(false);
        }
    });

    it('keeps all legacy transcript sources and null identity readable', () => {
        for (const sourceType of [
            'local_fixture',
            'youtube_timedtext',
            'youtube_yt_dlp',
        ] as const) {
            const parsed = v.safeParse(transcriptArtifactSchema, {
                artifactId: `legacy-${sourceType}`,
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: 'server-v4',
                strategy: sourceType,
                sourceType,
                languageCode: null,
                transcriptHash: null,
                acquiredAtMs: 1_900_000_000_000,
                segments: [
                    { startSec: 0, durationSec: 1, text: 'Legacy caption.' },
                ],
                transcriptText: 'Legacy caption.',
            });
            expect(parsed.success).toBe(true);
        }
    });

    it('requires cache-record identity to equal its uploaded transcript', () => {
        const transcript = buildUploadedTranscriptArtifact();
        const record = AnalysisArtifactStore.buildRecordForTests({
            videoId: transcript.videoId,
            algorithmVersion: transcript.algorithmVersion,
            terminalStatus: 'ready',
            selectedTranscriptArtifact: transcript,
        });
        expect(record.video).toMatchObject({
            languageCode: transcript.languageCode,
            transcriptHash: transcript.transcriptHash,
            sourceType: transcript.sourceType,
        });

        for (const video of [
            { ...record.video, languageCode: 'fr' },
            { ...record.video, transcriptHash: OTHER_TRANSCRIPT_HASH },
            { ...record.video, sourceType: 'youtube_yt_dlp' },
        ]) {
            expect(
                v.safeParse(analysisArtifactRecordSchema, {
                    ...record,
                    video,
                }).success,
            ).toBe(false);
        }
    });

    it('uses only exact uploaded identity while retaining a named legacy lookup', () => {
        const uploadedTranscript = buildUploadedTranscriptArtifact();
        const uploaded = AnalysisArtifactStore.buildRecordForTests({
            videoId: uploadedTranscript.videoId,
            algorithmVersion: uploadedTranscript.algorithmVersion,
            terminalStatus: 'ready',
            selectedTranscriptArtifact: uploadedTranscript,
        });
        const legacy = AnalysisArtifactStore.buildRecordForTests({
            videoId: uploadedTranscript.videoId,
            algorithmVersion: 'server-v4',
            terminalStatus: 'ready',
        });
        AnalysisArtifactStore.save(uploaded);
        AnalysisArtifactStore.save(legacy);

        expect(
            AnalysisArtifactStore.findLatestCacheableExact({
                videoId: uploadedTranscript.videoId,
                algorithmVersion: uploadedTranscript.algorithmVersion,
                languageCode: uploadedTranscript.languageCode,
                transcriptHash: uploadedTranscript.transcriptHash,
            })?.recordId,
        ).toBe(uploaded.recordId);
        expect(
            AnalysisArtifactStore.findLatestCacheableExact({
                videoId: uploadedTranscript.videoId,
                algorithmVersion: uploadedTranscript.algorithmVersion,
                languageCode: 'fr',
                transcriptHash: uploadedTranscript.transcriptHash,
            }),
        ).toBeNull();
        expect(
            AnalysisArtifactStore.findLatestCacheableExact({
                videoId: uploadedTranscript.videoId,
                algorithmVersion: uploadedTranscript.algorithmVersion,
                languageCode: uploadedTranscript.languageCode,
                transcriptHash: OTHER_TRANSCRIPT_HASH,
            }),
        ).toBeNull();
        expect(
            AnalysisArtifactStore.findLatestLegacyCacheable(
                legacy.video.videoId,
                legacy.video.algorithmVersion,
            )?.recordId,
        ).toBe(legacy.recordId);
    });

    it('generates opaque UUID-based record and source-result identifiers', () => {
        const first = AnalysisArtifactStore.buildRecordForTests({
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            terminalStatus: 'ready',
        });
        const second = AnalysisArtifactStore.buildRecordForTests({
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            terminalStatus: 'ready',
        });

        expect(first.recordId).toMatch(
            /^artifact-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        );
        expect(first.recordId).not.toBe(second.recordId);
        expect(first.recordId).not.toContain(first.video.videoId);
        if ('sourceResultId' in first.terminalResponse) {
            expect(first.terminalResponse.sourceResultId).toMatch(
                /^result-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
            );
            expect(first.terminalResponse.sourceResultId).not.toContain(
                first.video.videoId,
            );
        }
    });

    it('persists transcript and bounded assistant content without provider envelopes', () => {
        const transcript = buildUploadedTranscriptArtifact();
        const record = AnalysisArtifactStore.buildRecordForTests({
            videoId: transcript.videoId,
            algorithmVersion: transcript.algorithmVersion,
            terminalStatus: 'ready',
            selectedTranscriptArtifact: transcript,
        });
        const saved = AnalysisArtifactStore.save(record);
        const analysisRun = saved.analysisRun;
        if (analysisRun === null) {
            throw new Error('Expected a retained model run.');
        }

        expect(analysisRun.rawModelResponse).toBe(
            '{"hasPromo":true,"promoBlocks":[{"startSec":4,"endSec":24,"confidence":"high"}]}',
        );
        expect(Object.keys(analysisRun).sort()).toEqual(
            [
                'algorithmVersion',
                'completedAtMs',
                'failureReason',
                'normalizedPromoBlocks',
                'parsedResult',
                'provider',
                'rawModelResponse',
                'runId',
                'startedAtMs',
                'transcriptArtifactId',
                'videoId',
            ].sort(),
        );
        expect(JSON.stringify(analysisRun)).not.toMatch(
            /reasoning|providerEnvelope|providerError|providerDiagnostics/iu,
        );
        expect(saved.selectedTranscriptArtifact?.segments).toEqual(
            transcript.segments,
        );
    });

    it('keeps legacy no-promo history without artifacts out of cache lookup', () => {
        const record = AnalysisArtifactStore.buildRecordForTests({
            videoId: 'M7lc1UVf-VE',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            terminalStatus: 'no_promo',
            selectedTranscriptArtifact: null,
            analysisRun: null,
        });

        AnalysisArtifactStore.save(record);

        expect(
            AnalysisArtifactStore.findHistory({ videoId: 'M7lc1UVf-VE' }),
        ).toHaveLength(1);
        expect(
            AnalysisArtifactStore.findLatestCacheable({
                videoId: 'M7lc1UVf-VE',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            }),
        ).toBeNull();
    });

    it('keeps legacy message-bearing failure artifacts readable', () => {
        const record = AnalysisArtifactStore.buildRecordForTests({
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: 'server-v1',
            terminalStatus: 'unavailable',
        });
        const parsed = v.safeParse(analysisArtifactRecordSchema, {
            ...record,
            terminalResponse: {
                status: 'unavailable',
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: 'server-v1',
                reason: 'caption_extraction_failed',
                message: 'Legacy safe message.',
            },
        });

        expect(parsed.success).toBe(true);
    });

    it('keeps versioned history without overwriting earlier algorithm versions', () => {
        AnalysisArtifactStore.resetForTests();

        const first = AnalysisArtifactStore.buildRecordForTests({
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: 'server-v1',
            terminalStatus: 'ready',
            completedAtMs: 1_900_000_001_000,
        });
        const second = AnalysisArtifactStore.buildRecordForTests({
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: 'server-v2',
            terminalStatus: 'ready',
            completedAtMs: 1_900_000_002_000,
        });

        AnalysisArtifactStore.save(first);
        AnalysisArtifactStore.save(second);

        expect(
            AnalysisArtifactStore.findHistory({ videoId: 'dQw4w9WgXcQ' }),
        ).toHaveLength(2);
        expect(
            AnalysisArtifactStore.findLatestReady({
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: 'server-v1',
            })?.terminalResponse.algorithmVersion,
        ).toBe('server-v1');
    });

    it('returns defensive copies from save and read methods', () => {
        const record = AnalysisArtifactStore.buildRecordForTests({
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            terminalStatus: 'ready',
        });

        const saved = AnalysisArtifactStore.save(record);
        saved.operationalMetadata.diagnostics.artifactSource = 'local_backend';

        const [stored] = AnalysisArtifactStore.findHistory({
            videoId: 'dQw4w9WgXcQ',
        });
        expect(stored?.operationalMetadata.diagnostics.artifactSource).toBe(
            'test_fixture',
        );
    });

    it('uses single-row SQLite persistence and indexed video/version reads outside tests', () => {
        const originalVitest = process.env.VITEST;
        const record = AnalysisArtifactStore.buildRecordForTests({
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            terminalStatus: 'ready',
        });
        const upsert = vi
            .spyOn(BackendPublicState, 'upsertArtifact')
            .mockImplementation(() => {});
        const find = vi
            .spyOn(BackendPublicState, 'findArtifacts')
            .mockReturnValue([record]);
        delete process.env.VITEST;
        try {
            AnalysisArtifactStore.save(record);
            const history = AnalysisArtifactStore.findHistory({
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            });

            expect(upsert).toHaveBeenCalledWith(record);
            expect(find).toHaveBeenCalledWith({
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            });
            expect(history).toHaveLength(1);
        } finally {
            if (originalVitest === undefined) {
                delete process.env.VITEST;
            } else {
                process.env.VITEST = originalVitest;
            }
            upsert.mockRestore();
            find.mockRestore();
        }
    });

    it('loads completed artifacts from the local repository after a restart', () => {
        const persistence = AnalysisArtifactStoreTestHarness.configureStore();
        persistenceDirectory = persistence.directory;
        const record = AnalysisArtifactStore.buildRecordForTests({
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            terminalStatus: 'ready',
        });

        AnalysisArtifactStore.save(record);
        AnalysisArtifactStore.resetRuntimeCacheForTests();

        expect(existsSync(persistence.storagePath)).toBe(true);
        expect(
            AnalysisArtifactStore.findLatestReady({
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            })?.recordId,
        ).toBe(record.recordId);
    });

    it('loads an unexpired no-promo result from the local repository after a restart', () => {
        const persistence = AnalysisArtifactStoreTestHarness.configureStore();
        persistenceDirectory = persistence.directory;
        const record = AnalysisArtifactStore.buildRecordForTests({
            videoId: 'M7lc1UVf-VE',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            terminalStatus: 'no_promo',
        });

        AnalysisArtifactStore.save(record);
        AnalysisArtifactStore.resetRuntimeCacheForTests();

        expect(
            AnalysisArtifactStore.findLatestCacheable({
                videoId: 'M7lc1UVf-VE',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            })?.terminalResponse.status,
        ).toBe('no_promo');
    });

    it('removes expired history from disk before it can be reused', () => {
        const persistence = AnalysisArtifactStoreTestHarness.configureStore();
        persistenceDirectory = persistence.directory;
        const completedAtMs = 2_000_000_000_000;
        vi.useFakeTimers();
        vi.setSystemTime(completedAtMs);
        const record = AnalysisArtifactStore.buildRecordForTests({
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            terminalStatus: 'ready',
            completedAtMs,
        });

        AnalysisArtifactStore.save(record);
        AnalysisArtifactStore.resetRuntimeCacheForTests();
        vi.setSystemTime(completedAtMs + 31 * 24 * 60 * 60 * 1_000);

        expect(
            AnalysisArtifactStore.findHistory({ videoId: 'dQw4w9WgXcQ' }),
        ).toEqual([]);
        expect(existsSync(persistence.storagePath)).toBe(true);
    });
});

/**
 * Keeps per-test durable repository setup independent from the workspace data path.
 */
class AnalysisArtifactStoreTestHarness {
    /**
     * Configures a unique local repository file for one persistence test.
     *
     * @returns Directory and absolute path of the configured artifact file.
     */
    static configureStore(): { directory: string; storagePath: string } {
        const directory = mkdtempSync(join(tmpdir(), 'topskip-artifacts-'));
        const storagePath = join(directory, 'analysis-artifacts.json');
        AnalysisArtifactStore.setStoragePathForTests(storagePath);
        return { directory, storagePath };
    }
}
