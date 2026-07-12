import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as v from 'valibot';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    AnalysisArtifactStore,
    analysisArtifactRecordSchema,
} from '@/backend/analysis-artifact-store';
import { SERVER_ANALYSIS_ALGORITHM_VERSION } from '@/shared/server-analysis-contract';

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
