import { beforeEach, describe, expect, it, vi } from 'vitest';

const storageGet = vi.fn();
const storageSet = vi.fn();
const storageRemove = vi.fn();

vi.mock('@/shared/browser', () => ({
    default: {
        storage: {
            local: {
                get: storageGet,
                set: storageSet,
                remove: storageRemove,
            },
        },
    },
}));

const { SERVER_ANALYSIS_ALGORITHM_VERSION } =
    await import('@topskip/common/server-analysis-contract');
const { STORAGE_KEY_SERVER_RESULT_CACHE } = await import('@/shared/constants');
const { ServerResultCacheStorage } =
    await import('@/background/storage/server-result-cache');

const NOW_MS = 1_900_000_000_000;
const EXPIRES_AT_MS = NOW_MS + 60_000;
const CACHE_KEY = `${STORAGE_KEY_SERVER_RESULT_CACHE}:${SERVER_ANALYSIS_ALGORITHM_VERSION}:e2eFixture1`;

describe('ServerResultCacheStorage', () => {
    beforeEach(() => {
        storageGet.mockReset();
        storageSet.mockReset();
        storageRemove.mockReset();
    });

    it('returns a fresh cache entry for the current video and algorithm', async () => {
        storageGet.mockResolvedValue({
            [CACHE_KEY]: {
                videoId: 'e2eFixture1',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                sourceResultId: 'result-e2eFixture1-server-v1',
                freshness: { expiresAtMs: EXPIRES_AT_MS },
                promoBlocks: [{ startSec: 4, endSec: 24, confidence: 'high' }],
                storedAtMs: NOW_MS - 1_000,
            },
        });

        const hit = await ServerResultCacheStorage.loadFresh({
            videoId: 'e2eFixture1',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: NOW_MS,
        });

        expect(hit?.sourceResultId).toBe('result-e2eFixture1-server-v1');
        expect(hit?.promoBlocks).toEqual([
            { startSec: 4, endSec: 24, confidence: 'high' },
        ]);
        expect(storageRemove).not.toHaveBeenCalled();
    });

    it('removes stale entries and returns a miss', async () => {
        storageGet.mockResolvedValue({
            [CACHE_KEY]: {
                videoId: 'e2eFixture1',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                sourceResultId: 'result-e2eFixture1-server-v1',
                freshness: { expiresAtMs: NOW_MS },
                promoBlocks: [{ startSec: 4, endSec: 24 }],
                storedAtMs: NOW_MS - 120_000,
            },
        });

        await expect(
            ServerResultCacheStorage.loadFresh({
                videoId: 'e2eFixture1',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                nowMs: NOW_MS,
            }),
        ).resolves.toBeNull();
        expect(storageRemove).toHaveBeenCalledWith(CACHE_KEY);
    });

    it('removes corrupt entries and returns a miss', async () => {
        storageGet.mockResolvedValue({
            [CACHE_KEY]: { videoId: 'e2eFixture1', promoBlocks: 'bad' },
        });

        await expect(
            ServerResultCacheStorage.loadFresh({
                videoId: 'e2eFixture1',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                nowMs: NOW_MS,
            }),
        ).resolves.toBeNull();
        expect(storageRemove).toHaveBeenCalledWith(CACHE_KEY);
    });

    it('removes algorithm-version mismatches and returns a miss', async () => {
        storageGet.mockResolvedValue({
            [CACHE_KEY]: {
                videoId: 'e2eFixture1',
                algorithmVersion: 'server-v0',
                sourceResultId: 'result-e2eFixture1-server-v0',
                freshness: { expiresAtMs: EXPIRES_AT_MS },
                promoBlocks: [{ startSec: 4, endSec: 24 }],
                storedAtMs: NOW_MS - 1_000,
            },
        });

        await expect(
            ServerResultCacheStorage.loadFresh({
                videoId: 'e2eFixture1',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                nowMs: NOW_MS,
            }),
        ).resolves.toBeNull();
        expect(storageRemove).toHaveBeenCalledWith(CACHE_KEY);
    });

    it('treats storage read failures as cache misses', async () => {
        storageGet.mockRejectedValueOnce(new Error('storage unavailable'));

        await expect(
            ServerResultCacheStorage.loadFresh({
                videoId: 'e2eFixture1',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                nowMs: NOW_MS,
            }),
        ).resolves.toBeNull();
        expect(storageRemove).not.toHaveBeenCalled();
    });

    it('treats corrupt-entry repair failures as cache misses', async () => {
        storageGet.mockResolvedValue({
            [CACHE_KEY]: { videoId: 'e2eFixture1', promoBlocks: 'bad' },
        });
        storageRemove.mockRejectedValueOnce(new Error('remove failed'));

        await expect(
            ServerResultCacheStorage.loadFresh({
                videoId: 'e2eFixture1',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                nowMs: NOW_MS,
            }),
        ).resolves.toBeNull();
        expect(storageRemove).toHaveBeenCalledWith(CACHE_KEY);
    });

    it('stores a validated ready response for future use', async () => {
        await ServerResultCacheStorage.saveReadyResponse(
            {
                status: 'ready',
                videoId: 'e2eFixture1',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                source: 'server_cache',
                sourceResultId: 'result-e2eFixture1-server-v1',
                freshness: { expiresAtMs: EXPIRES_AT_MS },
                promoBlocks: [{ startSec: 4, endSec: 24, confidence: 'high' }],
            },
            NOW_MS,
        );

        expect(storageSet).toHaveBeenCalledWith({
            [CACHE_KEY]: {
                videoId: 'e2eFixture1',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                sourceResultId: 'result-e2eFixture1-server-v1',
                freshness: { expiresAtMs: EXPIRES_AT_MS },
                promoBlocks: [{ startSec: 4, endSec: 24, confidence: 'high' }],
                storedAtMs: NOW_MS,
            },
        });
    });

    it('removes cached rows from every inactive algorithm version', async () => {
        const activeKey = `${STORAGE_KEY_SERVER_RESULT_CACHE}:server-v5:e2eFixture1`;
        const oldKey = `${STORAGE_KEY_SERVER_RESULT_CACHE}:server-v4:dQw4w9WgXcQ`;
        const corruptKey = `${STORAGE_KEY_SERVER_RESULT_CACHE}:broken:bad`;
        storageGet.mockResolvedValue({
            unrelated: { keep: true },
            [activeKey]: {
                videoId: 'e2eFixture1',
                algorithmVersion: 'server-v5',
                sourceResultId: 'result-v5',
                freshness: { expiresAtMs: EXPIRES_AT_MS },
                promoBlocks: [{ startSec: 4, endSec: 24 }],
                storedAtMs: NOW_MS,
            },
            [oldKey]: {
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: 'server-v4',
                sourceResultId: 'result-v4',
                freshness: { expiresAtMs: EXPIRES_AT_MS },
                promoBlocks: [{ startSec: 4, endSec: 24 }],
                storedAtMs: NOW_MS,
            },
            [corruptKey]: { nope: true },
        });

        await ServerResultCacheStorage.removeOtherAlgorithmVersions(
            'server-v5',
        );

        expect(storageGet).toHaveBeenCalledWith(null);
        expect(storageRemove).toHaveBeenCalledWith([oldKey, corruptKey]);
    });

    it('treats algorithm cache cleanup as best effort', async () => {
        storageGet.mockRejectedValueOnce(new Error('storage unavailable'));

        await expect(
            ServerResultCacheStorage.removeOtherAlgorithmVersions('server-v5'),
        ).resolves.toBeUndefined();
        expect(storageRemove).not.toHaveBeenCalled();
    });

    it('finds the newest fresh video row when config has never loaded', async () => {
        const oldVersionKey = `${STORAGE_KEY_SERVER_RESULT_CACHE}:server-v4:e2eFixture1`;
        const latestVersionKey = `${STORAGE_KEY_SERVER_RESULT_CACHE}:server-v5:e2eFixture1`;
        storageGet.mockResolvedValue({
            [oldVersionKey]: {
                videoId: 'e2eFixture1',
                algorithmVersion: 'server-v4',
                sourceResultId: 'result-v4',
                freshness: { expiresAtMs: EXPIRES_AT_MS },
                promoBlocks: [{ startSec: 4, endSec: 24 }],
                storedAtMs: NOW_MS - 10_000,
            },
            [latestVersionKey]: {
                videoId: 'e2eFixture1',
                algorithmVersion: 'server-v5',
                sourceResultId: 'result-v5',
                freshness: { expiresAtMs: EXPIRES_AT_MS },
                promoBlocks: [{ startSec: 5, endSec: 25 }],
                storedAtMs: NOW_MS - 1_000,
            },
        });

        const result = await ServerResultCacheStorage.loadLatestFreshForVideo({
            videoId: 'e2eFixture1',
            nowMs: NOW_MS,
        });

        expect(storageGet).toHaveBeenCalledWith(null);
        expect(result?.algorithmVersion).toBe('server-v5');
        expect(result?.promoBlocks).toEqual([{ startSec: 5, endSec: 25 }]);
    });

    it('does not use expired rows for the offline cache fallback', async () => {
        const key = `${STORAGE_KEY_SERVER_RESULT_CACHE}:server-v4:e2eFixture1`;
        storageGet.mockResolvedValue({
            [key]: {
                videoId: 'e2eFixture1',
                algorithmVersion: 'server-v4',
                sourceResultId: 'result-v4',
                freshness: { expiresAtMs: NOW_MS },
                promoBlocks: [{ startSec: 4, endSec: 24 }],
                storedAtMs: NOW_MS - 1_000,
            },
        });

        await expect(
            ServerResultCacheStorage.loadLatestFreshForVideo({
                videoId: 'e2eFixture1',
                nowMs: NOW_MS,
            }),
        ).resolves.toBeNull();
    });
});
