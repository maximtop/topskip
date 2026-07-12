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
    await import('@/shared/server-analysis-contract');
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
});
