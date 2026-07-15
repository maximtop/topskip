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
import { BackendPublicState } from '@topskip/backend/public-state';
import { SERVER_ANALYSIS_ALGORITHM_VERSION } from '@topskip/common/server-analysis-contract';

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

    it('redacts secret-like operational metadata before storage', () => {
        const record = AnalysisArtifactStore.buildRecordForTests({
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            terminalStatus: 'unavailable',
            operationalMetadata: {
                diagnostics: {
                    authorization: 'Bearer sk-secret',
                    cookie: 'SID=youtube-account-token',
                    safeCode: 'caption_extraction_failed',
                },
            },
        });

        const serialized = JSON.stringify(
            v.parse(analysisArtifactRecordSchema, record),
        );
        expect(serialized).not.toContain('sk-secret');
        expect(serialized).not.toContain('youtube-account-token');
        expect(serialized).toContain('[REDACTED]');
        expect(serialized).toContain('caption_extraction_failed');
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
        saved.operationalMetadata.diagnostics.safeCode = 'mutated';

        const [stored] = AnalysisArtifactStore.findHistory({
            videoId: 'dQw4w9WgXcQ',
        });
        expect(
            stored?.operationalMetadata.diagnostics.safeCode,
        ).toBeUndefined();
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
