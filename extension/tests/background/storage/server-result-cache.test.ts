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

const { STORAGE_KEY_SERVER_RESULT_CACHE } = await import('@/shared/constants');
const { ServerResultCacheStorage } =
    await import('@/background/storage/server-result-cache');

const NOW_MS = 1_900_000_000_000;
const EXPIRES_AT_MS = NOW_MS + 60_000;
const VIDEO_ID = 'e2eFixture1';
const ALGORITHM_VERSION = 'server-v5';
const LANGUAGE_CODE = 'en';
const TRANSCRIPT_HASH = 'a'.repeat(64);
const OTHER_TRANSCRIPT_HASH = 'b'.repeat(64);
const CACHE_KEY = [
    STORAGE_KEY_SERVER_RESULT_CACHE,
    ALGORITHM_VERSION,
    VIDEO_ID,
    LANGUAGE_CODE,
    TRANSCRIPT_HASH,
].join(':');

const EXACT_ENTRY = {
    status: 'ready' as const,
    videoId: VIDEO_ID,
    languageCode: LANGUAGE_CODE,
    transcriptHash: TRANSCRIPT_HASH,
    algorithmVersion: ALGORITHM_VERSION,
    sourceResultId: 'result-exact',
    freshness: { expiresAtMs: EXPIRES_AT_MS },
    promoBlocks: [{ startSec: 4, endSec: 24, confidence: 'high' as const }],
    storedAtMs: NOW_MS - 1_000,
};

describe('ServerResultCacheStorage', () => {
    beforeEach(() => {
        storageGet.mockReset();
        storageSet.mockReset();
        storageRemove.mockReset();
    });

    it('loads only an exact server result by algorithm, video, language, and hash', async () => {
        storageGet.mockImplementation((key: string) =>
            Promise.resolve(
                key === CACHE_KEY ? { [CACHE_KEY]: EXACT_ENTRY } : {},
            ),
        );

        await expect(
            ServerResultCacheStorage.loadExact({
                videoId: VIDEO_ID,
                languageCode: LANGUAGE_CODE,
                transcriptHash: TRANSCRIPT_HASH,
                algorithmVersion: ALGORITHM_VERSION,
                nowMs: NOW_MS,
            }),
        ).resolves.toMatchObject({ sourceResultId: 'result-exact' });

        await expect(
            ServerResultCacheStorage.loadExact({
                videoId: VIDEO_ID,
                languageCode: 'ru',
                transcriptHash: TRANSCRIPT_HASH,
                algorithmVersion: ALGORITHM_VERSION,
                nowMs: NOW_MS,
            }),
        ).resolves.toBeNull();
        await expect(
            ServerResultCacheStorage.loadExact({
                videoId: VIDEO_ID,
                languageCode: LANGUAGE_CODE,
                transcriptHash: OTHER_TRANSCRIPT_HASH,
                algorithmVersion: ALGORITHM_VERSION,
                nowMs: NOW_MS,
            }),
        ).resolves.toBeNull();

        expect(
            Reflect.get(ServerResultCacheStorage, 'loadLatestFreshForVideo'),
        ).toBeUndefined();
    });

    it('removes stale or corrupt exact rows and treats storage failures as misses', async () => {
        storageGet.mockResolvedValueOnce({
            [CACHE_KEY]: { ...EXACT_ENTRY, freshness: { expiresAtMs: NOW_MS } },
        });
        await expect(
            ServerResultCacheStorage.loadExact({
                videoId: VIDEO_ID,
                languageCode: LANGUAGE_CODE,
                transcriptHash: TRANSCRIPT_HASH,
                algorithmVersion: ALGORITHM_VERSION,
                nowMs: NOW_MS,
            }),
        ).resolves.toBeNull();
        expect(storageRemove).toHaveBeenCalledWith(CACHE_KEY);

        storageGet.mockResolvedValueOnce({ [CACHE_KEY]: { nope: true } });
        await expect(
            ServerResultCacheStorage.loadExact({
                videoId: VIDEO_ID,
                languageCode: LANGUAGE_CODE,
                transcriptHash: TRANSCRIPT_HASH,
                algorithmVersion: ALGORITHM_VERSION,
                nowMs: NOW_MS,
            }),
        ).resolves.toBeNull();

        storageGet.mockRejectedValueOnce(new Error('storage unavailable'));
        await expect(
            ServerResultCacheStorage.loadExact({
                videoId: VIDEO_ID,
                languageCode: LANGUAGE_CODE,
                transcriptHash: TRANSCRIPT_HASH,
                algorithmVersion: ALGORITHM_VERSION,
                nowMs: NOW_MS,
            }),
        ).resolves.toBeNull();
    });

    it('stores ready and no-promo results without captions', async () => {
        await ServerResultCacheStorage.saveTerminalResponse(
            {
                status: 'ready',
                videoId: VIDEO_ID,
                languageCode: LANGUAGE_CODE,
                transcriptHash: TRANSCRIPT_HASH,
                algorithmVersion: ALGORITHM_VERSION,
                source: 'server_cache',
                sourceResultId: 'result-exact',
                freshness: { expiresAtMs: EXPIRES_AT_MS },
                promoBlocks: [{ startSec: 4, endSec: 24, confidence: 'high' }],
            },
            NOW_MS,
        );
        await ServerResultCacheStorage.saveTerminalResponse(
            {
                status: 'no_promo',
                videoId: VIDEO_ID,
                languageCode: LANGUAGE_CODE,
                transcriptHash: TRANSCRIPT_HASH,
                algorithmVersion: ALGORITHM_VERSION,
                sourceResultId: 'result-clean',
                freshness: { expiresAtMs: EXPIRES_AT_MS },
            },
            NOW_MS,
        );

        expect(storageSet).toHaveBeenNthCalledWith(1, {
            [CACHE_KEY]: {
                ...EXACT_ENTRY,
                storedAtMs: NOW_MS,
            },
        });
        expect(storageSet).toHaveBeenNthCalledWith(2, {
            [CACHE_KEY]: {
                status: 'no_promo',
                videoId: VIDEO_ID,
                languageCode: LANGUAGE_CODE,
                transcriptHash: TRANSCRIPT_HASH,
                algorithmVersion: ALGORITHM_VERSION,
                sourceResultId: 'result-clean',
                freshness: { expiresAtMs: EXPIRES_AT_MS },
                storedAtMs: NOW_MS,
            },
        });
        expect(JSON.stringify(storageSet.mock.calls)).not.toContain('segments');
        expect(JSON.stringify(storageSet.mock.calls)).not.toContain(
            'transcriptText',
        );
    });

    it('removes rows from obsolete algorithms while preserving exact active rows', async () => {
        const oldKey = [
            STORAGE_KEY_SERVER_RESULT_CACHE,
            'server-v4',
            VIDEO_ID,
            LANGUAGE_CODE,
            TRANSCRIPT_HASH,
        ].join(':');
        const corruptKey = `${STORAGE_KEY_SERVER_RESULT_CACHE}:broken`;
        storageGet.mockResolvedValue({
            unrelated: { keep: true },
            [CACHE_KEY]: EXACT_ENTRY,
            [oldKey]: { ...EXACT_ENTRY, algorithmVersion: 'server-v4' },
            [corruptKey]: { nope: true },
        });

        await ServerResultCacheStorage.removeOtherAlgorithmVersions(
            ALGORITHM_VERSION,
        );

        expect(storageGet).toHaveBeenCalledWith(null);
        expect(storageRemove).toHaveBeenCalledWith([oldKey, corruptKey]);
    });
});
