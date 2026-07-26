import * as v from 'valibot';

import browser from '@/shared/browser';
import { STORAGE_KEY_SERVER_INSTALLATION } from '@/shared/constants';

const serverInstallationSchema = v.strictObject({
    token: v.pipe(v.string(), v.minLength(32), v.maxLength(128)),
    expiresAtMs: v.pipe(v.number(), v.finite(), v.integer(), v.minValue(1)),
});

/**
 * Validated credential persisted only in the background-owned storage path.
 */
export type ServerInstallation = v.InferOutput<typeof serverInstallationSchema>;

/**
 * Keeps the anonymous server credential out of popup and content bundles;
 * static API only.
 */
export class ServerInstallationStorage {
    /**
     * Removes unusable state without blocking a later registration attempt.
     *
     * @returns Promise resolved after the best-effort removal.
     */
    private static async removeInvalidState(): Promise<void> {
        try {
            await browser.storage.local.remove(STORAGE_KEY_SERVER_INSTALLATION);
        } catch {
            // A later registration can still proceed when storage repair fails.
        }
    }

    /**
     * Loads the current credential when it remains valid.
     *
     * @param nowMs - Current epoch time, injectable for tests.
     * @returns Fresh credential or `null` when registration is required.
     */
    static async loadFresh(
        nowMs = Date.now(),
    ): Promise<ServerInstallation | null> {
        let raw: unknown;
        try {
            const stored = await browser.storage.local.get(
                STORAGE_KEY_SERVER_INSTALLATION,
            );
            raw = Reflect.get(stored, STORAGE_KEY_SERVER_INSTALLATION);
        } catch {
            return null;
        }

        if (raw === undefined) {
            return null;
        }

        const parsed = v.safeParse(serverInstallationSchema, raw);
        if (!parsed.success || parsed.output.expiresAtMs <= nowMs) {
            await ServerInstallationStorage.removeInvalidState();
            return null;
        }
        return parsed.output;
    }

    /**
     * Persists a freshly registered credential after boundary validation.
     *
     * @param installation - Token and server-issued expiry.
     * @returns Promise resolved after storage completes.
     */
    static async save(installation: ServerInstallation): Promise<void> {
        const parsed = v.parse(serverInstallationSchema, installation);
        await browser.storage.local.set({
            [STORAGE_KEY_SERVER_INSTALLATION]: parsed,
        });
    }

    /**
     * Drops a rejected or expired credential before one safe retry.
     *
     * @returns Promise resolved after storage removal.
     */
    static async clear(): Promise<void> {
        await browser.storage.local.remove(STORAGE_KEY_SERVER_INSTALLATION);
    }
}
