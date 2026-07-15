import * as v from 'valibot';

import browser from '@/shared/browser';
import {
    STORAGE_KEY_SERVER_CONFIG,
    STORAGE_KEY_SERVER_CONFIG_REFRESH_ATTEMPT,
} from '@/shared/constants';
import {
    serverConfigResponseSchema,
    type ServerConfigResponse,
} from '@topskip/common/server-analysis-contract';

const finiteEpochMsSchema = v.pipe(
    v.number(),
    v.check((value) => Number.isFinite(value), 'Epoch time must be finite.'),
    v.integer(),
    v.minValue(1),
);

const cachedServerConfigSchema = v.strictObject({
    config: serverConfigResponseSchema,
    fetchedAtMs: finiteEpochMsSchema,
});

/**
 * Public compatibility snapshot retained across service-worker restarts.
 */
export type CachedServerConfig = v.InferOutput<typeof cachedServerConfigSchema>;

/**
 * Persists only public server configuration in background-owned storage;
 * static API only.
 */
export class ServerConfigStorage {
    /**
     * Removes corrupt data so it cannot pin an invalid algorithm version.
     *
     * @returns Promise resolved after best-effort repair.
     */
    private static async removeInvalidState(): Promise<void> {
        try {
            await browser.storage.local.remove(STORAGE_KEY_SERVER_CONFIG);
        } catch {
            // Network analysis remains available when cache repair cannot persist.
        }
    }

    /**
     * Removes a corrupt refresh timestamp without discarding a valid config.
     *
     * @returns Promise resolved after best-effort repair.
     */
    private static async removeInvalidRefreshAttempt(): Promise<void> {
        try {
            await browser.storage.local.remove(
                STORAGE_KEY_SERVER_CONFIG_REFRESH_ATTEMPT,
            );
        } catch {
            // Failed repair must not make a previously fetched config unusable.
        }
    }

    /**
     * Loads the last validated config regardless of refresh age.
     *
     * @returns Cached config with fetch time, or `null` when unavailable.
     */
    static async load(): Promise<CachedServerConfig | null> {
        let raw: unknown;
        try {
            const stored = await browser.storage.local.get(
                STORAGE_KEY_SERVER_CONFIG,
            );
            raw = Reflect.get(stored, STORAGE_KEY_SERVER_CONFIG);
        } catch {
            return null;
        }
        if (raw === undefined) {
            return null;
        }

        const parsed = v.safeParse(cachedServerConfigSchema, raw);
        if (!parsed.success) {
            await ServerConfigStorage.removeInvalidState();
            return null;
        }
        return parsed.output;
    }

    /**
     * Reads the last attempted network refresh so an offline server cannot be
     * hammered after every watch-page message.
     *
     * @returns Epoch timestamp for the last attempt, or `null` when unavailable.
     */
    static async loadLastRefreshAttempt(): Promise<number | null> {
        let raw: unknown;
        try {
            const stored = await browser.storage.local.get(
                STORAGE_KEY_SERVER_CONFIG_REFRESH_ATTEMPT,
            );
            raw = Reflect.get(
                stored,
                STORAGE_KEY_SERVER_CONFIG_REFRESH_ATTEMPT,
            );
        } catch {
            return null;
        }
        if (raw === undefined) {
            return null;
        }

        const parsed = v.safeParse(finiteEpochMsSchema, raw);
        if (!parsed.success) {
            await ServerConfigStorage.removeInvalidRefreshAttempt();
            return null;
        }
        return parsed.output;
    }

    /**
     * Saves a server-validated public config and its actual fetch time.
     *
     * @param config - Public config accepted at the HTTP boundary.
     * @param fetchedAtMs - Epoch time of the successful request.
     * @returns Promise resolved after persistence.
     */
    static async save(
        config: ServerConfigResponse,
        fetchedAtMs = Date.now(),
    ): Promise<void> {
        const cached = v.parse(cachedServerConfigSchema, {
            config,
            fetchedAtMs,
        });
        await browser.storage.local.set({
            [STORAGE_KEY_SERVER_CONFIG]: cached,
        });
    }

    /**
     * Persists a refresh attempt independently from successful config fetches.
     *
     * @param attemptedAtMs - Epoch time immediately before the HTTP request.
     * @returns Promise resolved after persistence.
     */
    static async saveRefreshAttempt(attemptedAtMs = Date.now()): Promise<void> {
        const validated = v.parse(finiteEpochMsSchema, attemptedAtMs);
        await browser.storage.local.set({
            [STORAGE_KEY_SERVER_CONFIG_REFRESH_ATTEMPT]: validated,
        });
    }
}
