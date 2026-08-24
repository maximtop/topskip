import * as v from 'valibot';

import browser from '@/shared/browser';
import {
    STORAGE_KEY_SERVER_RESULT_CACHE,
    STORAGE_KEY_SERVER_RESULT_CACHE_INDEX,
} from '@/shared/constants';
import {
    noPromoResponseSchema,
    normalizedCaptionLanguageCodeSchema,
    promoBlockSchema,
    readyResponseFreshnessSchema,
    readyResponseSchema,
    transcriptHashSchema,
    youtubeVideoIdSchema,
    type NoPromoResponse,
    type ReadyResponse,
} from '@topskip/common/server-analysis-contract';

const MAX_ALGORITHM_VERSION_LENGTH = 64;
const MAX_OPAQUE_ID_LENGTH = 160;

/**
 * Keys of every cached row; lets cleanup read only its own rows instead of
 * scanning all of `storage.local` (which would load the debug log).
 */
const cacheIndexSchema = v.array(v.string());

const finiteEpochMsSchema = v.pipe(
    v.number(),
    v.finite('Epoch milliseconds must be finite.'),
    v.integer(),
    v.minValue(1),
);

const cacheIdentityEntries = {
    videoId: youtubeVideoIdSchema,
    languageCode: normalizedCaptionLanguageCodeSchema,
    transcriptHash: transcriptHashSchema,
    algorithmVersion: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(MAX_ALGORITHM_VERSION_LENGTH),
    ),
};

const cacheResultEntries = {
    ...cacheIdentityEntries,
    sourceResultId: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(MAX_OPAQUE_ID_LENGTH),
    ),
    freshness: readyResponseFreshnessSchema,
    storedAtMs: finiteEpochMsSchema,
};

const readyCacheEntrySchema = v.strictObject({
    status: v.literal('ready'),
    ...cacheResultEntries,
    promoBlocks: v.pipe(v.array(promoBlockSchema), v.minLength(1)),
});

const noPromoCacheEntrySchema = v.strictObject({
    status: v.literal('no_promo'),
    ...cacheResultEntries,
});

/**
 * Validates one exact result row before any skip or popup path can use it.
 */
export const serverResultCacheEntrySchema = v.union([
    readyCacheEntrySchema,
    noPromoCacheEntrySchema,
]);

/**
 * Local result content bound to one exact server-observed transcript identity.
 */
export type ServerResultCacheEntry = v.InferOutput<
    typeof serverResultCacheEntrySchema
>;

/**
 * Exact cache lookup key excludes captions while distinguishing their digest.
 */
export type ServerResultCacheIdentity = {
    videoId: string;
    languageCode: string;
    transcriptHash: string;
    algorithmVersion: string;
};

/**
 * Background-owned exact result cache; static API only.
 */
export class ServerResultCacheStorage {
    /**
     * Builds the private storage key for one exact observed identity.
     *
     * @param input - Server-owned transcript identity.
     * @returns Stable browser-storage key.
     */
    private static keyFor(input: ServerResultCacheIdentity): string {
        return [
            STORAGE_KEY_SERVER_RESULT_CACHE,
            input.algorithmVersion,
            input.videoId,
            input.languageCode,
            input.transcriptHash,
        ].join(':');
    }

    /**
     * Best-effort repair keeps cache corruption from blocking server fallback;
     * the index forgets the row as well.
     *
     * @param key - Storage row to remove.
     * @returns Promise resolved after the repair attempt.
     */
    private static async removeInvalidEntry(key: string): Promise<void> {
        try {
            await browser.storage.local.remove(key);
            const keys = await ServerResultCacheStorage.readIndexKeys();
            if (keys !== null && keys.includes(key)) {
                await browser.storage.local.set({
                    [STORAGE_KEY_SERVER_RESULT_CACHE_INDEX]: keys.filter(
                        (candidate) => candidate !== key,
                    ),
                });
            }
        } catch {
            // Cache repair is opportunistic; the backend remains authoritative.
        }
    }

    /**
     * Drops rows from obsolete server algorithms after a validated observation.
     * Reads only the indexed rows; the one-time full scan happens only while
     * no index exists yet (installs that predate it).
     *
     * @param activeAlgorithmVersion - Server-owned algorithm currently observed.
     * @returns Promise resolved after best-effort cleanup.
     */
    static async removeOtherAlgorithmVersions(
        activeAlgorithmVersion: string,
    ): Promise<void> {
        let keys: string[];
        let stored: Record<string, unknown>;
        let migrated = false;
        try {
            const indexed = await ServerResultCacheStorage.readIndexKeys();
            if (indexed === null) {
                ({ keys, stored } = await ServerResultCacheStorage.scanCacheRows());
                migrated = true;
            } else {
                keys = indexed;
                stored =
                    keys.length === 0
                        ? {}
                        : await browser.storage.local.get(keys);
            }
        } catch {
            return;
        }

        const obsoleteKeys = keys.filter((key) => {
            const parsed = v.safeParse(
                serverResultCacheEntrySchema,
                Reflect.get(stored, key),
            );
            return (
                !parsed.success ||
                parsed.output.algorithmVersion !== activeAlgorithmVersion
            );
        });
        if (obsoleteKeys.length === 0 && !migrated) {
            return;
        }
        try {
            if (obsoleteKeys.length > 0) {
                await browser.storage.local.remove(obsoleteKeys);
            }
            const obsolete = new Set(obsoleteKeys);
            await browser.storage.local.set({
                [STORAGE_KEY_SERVER_RESULT_CACHE_INDEX]: keys.filter(
                    (key) => !obsolete.has(key),
                ),
            });
        } catch {
            // Exact keyed reads remain safe when opportunistic cleanup fails.
        }
    }

    /**
     * Reads the cache index.
     *
     * @returns Indexed keys, or `null` when absent or malformed.
     */
    private static async readIndexKeys(): Promise<string[] | null> {
        const result: unknown = await browser.storage.local.get(
            STORAGE_KEY_SERVER_RESULT_CACHE_INDEX,
        );
        if (result === null || typeof result !== 'object') {
            return null;
        }
        const parsed = v.safeParse(
            cacheIndexSchema,
            Reflect.get(result, STORAGE_KEY_SERVER_RESULT_CACHE_INDEX),
        );
        return parsed.success ? parsed.output : null;
    }

    /**
     * One-time migration for installs without an index: the only remaining
     * full scan, which rebuilds the key list from the cache prefix.
     *
     * @returns Cache keys and the rows read for them.
     */
    private static async scanCacheRows(): Promise<{
        keys: string[];
        stored: Record<string, unknown>;
    }> {
        const all: unknown = await browser.storage.local.get(null);
        if (all === null || typeof all !== 'object') {
            return { keys: [], stored: {} };
        }
        const prefix = `${STORAGE_KEY_SERVER_RESULT_CACHE}:`;
        const stored: Record<string, unknown> = {};
        const keys: string[] = [];
        for (const [key, value] of Object.entries(all)) {
            if (key.startsWith(prefix)) {
                keys.push(key);
                stored[key] = value;
            }
        }
        return { keys, stored };
    }

    /**
     * Reads only a fresh row whose complete server identity matches the captions.
     *
     * @param input - Exact identity and optional deterministic clock.
     * @returns Fresh exact cache entry, otherwise `null`.
     */
    static async loadExact(
        input: ServerResultCacheIdentity & { nowMs?: number },
    ): Promise<ServerResultCacheEntry | null> {
        const key = ServerResultCacheStorage.keyFor(input);
        let raw: unknown;
        try {
            const result = await browser.storage.local.get(key);
            raw = Reflect.get(result, key);
        } catch {
            return null;
        }

        if (raw === undefined) {
            return null;
        }

        const parsed = v.safeParse(serverResultCacheEntrySchema, raw);
        if (!parsed.success) {
            await ServerResultCacheStorage.removeInvalidEntry(key);
            return null;
        }

        const entry = parsed.output;
        const nowMs = input.nowMs ?? Date.now();
        if (
            entry.videoId !== input.videoId ||
            entry.languageCode !== input.languageCode ||
            entry.transcriptHash !== input.transcriptHash ||
            entry.algorithmVersion !== input.algorithmVersion ||
            entry.freshness.expiresAtMs <= nowMs
        ) {
            await ServerResultCacheStorage.removeInvalidEntry(key);
            return null;
        }
        return entry;
    }

    /**
     * Persists only terminal result data and exact identity, never captions.
     *
     * @param response - Valid ready or no-promo server response.
     * @param nowMs - Local write time, injectable for tests.
     * @returns Promise resolved after the exact row is written.
     */
    static async saveTerminalResponse(
        response: ReadyResponse | NoPromoResponse,
        nowMs = Date.now(),
    ): Promise<void> {
        const terminal =
            response.status === 'ready'
                ? v.parse(readyResponseSchema, response)
                : v.parse(noPromoResponseSchema, response);
        const entry = v.parse(serverResultCacheEntrySchema, {
            status: terminal.status,
            videoId: terminal.videoId,
            languageCode: terminal.languageCode,
            transcriptHash: terminal.transcriptHash,
            algorithmVersion: terminal.algorithmVersion,
            sourceResultId: terminal.sourceResultId,
            freshness: terminal.freshness,
            ...(terminal.status === 'ready'
                ? { promoBlocks: terminal.promoBlocks }
                : {}),
            storedAtMs: nowMs,
        });
        const key = ServerResultCacheStorage.keyFor(entry);
        const indexed = await ServerResultCacheStorage.readIndexKeys();
        const keys =
            indexed ?? (await ServerResultCacheStorage.scanCacheRows()).keys;
        await browser.storage.local.set({
            [key]: entry,
            [STORAGE_KEY_SERVER_RESULT_CACHE_INDEX]: keys.includes(key)
                ? keys
                : [...keys, key],
        });
    }

    /**
     * Preserves the ready-only call site while orchestration moves to terminal caching.
     *
     * @param response - Valid ready server response.
     * @param nowMs - Local write time, injectable for tests.
     * @returns Promise resolved after the exact row is written.
     */
    static async saveReadyResponse(
        response: ReadyResponse,
        nowMs = Date.now(),
    ): Promise<void> {
        return ServerResultCacheStorage.saveTerminalResponse(response, nowMs);
    }
}
