import * as v from 'valibot';

import browser from '@/shared/browser';
import { STORAGE_KEY_SERVER_RESULT_CACHE } from '@/shared/constants';
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
     * Best-effort repair keeps cache corruption from blocking server fallback.
     *
     * @param key - Storage row to remove.
     * @returns Promise resolved after the repair attempt.
     */
    private static async removeInvalidEntry(key: string): Promise<void> {
        try {
            await browser.storage.local.remove(key);
        } catch {
            // Cache repair is opportunistic; the backend remains authoritative.
        }
    }

    /**
     * Drops rows from obsolete server algorithms after a validated observation.
     *
     * @param activeAlgorithmVersion - Server-owned algorithm currently observed.
     * @returns Promise resolved after best-effort cleanup.
     */
    static async removeOtherAlgorithmVersions(
        activeAlgorithmVersion: string,
    ): Promise<void> {
        let stored: Record<string, unknown>;
        try {
            stored = await browser.storage.local.get(null);
        } catch {
            return;
        }

        const prefix = `${STORAGE_KEY_SERVER_RESULT_CACHE}:`;
        const obsoleteKeys: string[] = [];
        for (const [key, raw] of Object.entries(stored)) {
            if (!key.startsWith(prefix)) {
                continue;
            }
            const parsed = v.safeParse(serverResultCacheEntrySchema, raw);
            if (
                !parsed.success ||
                parsed.output.algorithmVersion !== activeAlgorithmVersion
            ) {
                obsoleteKeys.push(key);
            }
        }

        if (obsoleteKeys.length === 0) {
            return;
        }
        try {
            await browser.storage.local.remove(obsoleteKeys);
        } catch {
            // Exact keyed reads remain safe when opportunistic cleanup fails.
        }
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
        await browser.storage.local.set({
            [ServerResultCacheStorage.keyFor(entry)]: entry,
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
