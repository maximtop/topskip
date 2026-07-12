import * as v from 'valibot';

import browser from '@/shared/browser';
import { STORAGE_KEY_SERVER_RESULT_CACHE } from '@/shared/constants';
import {
    promoBlockSchema,
    readyResponseFreshnessSchema,
    readyResponseSchema,
    youtubeVideoIdSchema,
    type ReadyResponse,
} from '@/shared/server-analysis-contract';

const finiteEpochMsSchema = v.pipe(
    v.number(),
    v.check(
        (value) => Number.isFinite(value),
        'Epoch milliseconds must be finite.',
    ),
    v.integer(),
    v.minValue(1),
);

/**
 * Validates one stored local cache row before any skip path can use it.
 */
export const serverResultCacheEntrySchema = v.strictObject({
    videoId: youtubeVideoIdSchema,
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    sourceResultId: v.pipe(v.string(), v.minLength(1)),
    freshness: readyResponseFreshnessSchema,
    promoBlocks: v.pipe(v.array(promoBlockSchema), v.minLength(1)),
    storedAtMs: finiteEpochMsSchema,
});

/**
 * Local copy of a ready server result.
 */
export type ServerResultCacheEntry = v.InferOutput<
    typeof serverResultCacheEntrySchema
>;

/**
 * Background-owned local result cache; static API only.
 */
export class ServerResultCacheStorage {
    /**
     * Builds the storage key for one video/version cache row.
     *
     * @param input - Cache namespace and video id.
     * @returns Stable `browser.storage.local` key.
     */
    private static keyFor(input: {
        videoId: string;
        algorithmVersion: string;
    }): string {
        return `${STORAGE_KEY_SERVER_RESULT_CACHE}:${input.algorithmVersion}:${input.videoId}`;
    }

    /**
     * Best-effort repair keeps cache corruption from blocking server fallback.
     *
     * @param key - Storage row to remove.
     * @returns Promise resolved after the repair attempt is complete.
     */
    private static async removeInvalidEntry(key: string): Promise<void> {
        try {
            await browser.storage.local.remove(key);
        } catch {
            // Cache repair is opportunistic; the backend path remains authoritative.
        }
    }

    /**
     * Reads a fresh cache row or repairs stale/corrupt data as a miss.
     *
     * @param input - Cache lookup key and optional test clock.
     * @returns Fresh cache entry, otherwise `null`.
     */
    static async loadFresh(input: {
        videoId: string;
        algorithmVersion: string;
        nowMs?: number;
    }): Promise<ServerResultCacheEntry | null> {
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

        let entry: ServerResultCacheEntry;
        try {
            entry = v.parse(serverResultCacheEntrySchema, raw);
        } catch {
            await ServerResultCacheStorage.removeInvalidEntry(key);
            return null;
        }

        const nowMs = input.nowMs ?? Date.now();
        if (
            entry.videoId !== input.videoId ||
            entry.algorithmVersion !== input.algorithmVersion ||
            entry.freshness.expiresAtMs <= nowMs
        ) {
            await ServerResultCacheStorage.removeInvalidEntry(key);
            return null;
        }

        return entry;
    }

    /**
     * Persists a validated ready server response for future server-mode starts.
     *
     * @param response - Ready response accepted from the backend.
     * @param nowMs - Local write time, injectable for tests.
     * @returns Promise resolved after the row is written.
     */
    static async saveReadyResponse(
        response: ReadyResponse,
        nowMs = Date.now(),
    ): Promise<void> {
        const ready = v.parse(readyResponseSchema, response);
        const entry = v.parse(serverResultCacheEntrySchema, {
            videoId: ready.videoId,
            algorithmVersion: ready.algorithmVersion,
            sourceResultId: ready.sourceResultId,
            freshness: ready.freshness,
            promoBlocks: ready.promoBlocks,
            storedAtMs: nowMs,
        });
        await browser.storage.local.set({
            [ServerResultCacheStorage.keyFor(entry)]: entry,
        });
    }
}
