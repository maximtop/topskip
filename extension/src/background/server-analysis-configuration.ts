import { ServerAnalysisClient } from '@/background/server-analysis-client';
import { ServerConfigStorage } from '@/background/storage/server-config-storage';
import { ServerResultCacheStorage } from '@/background/storage/server-result-cache';
import { MS_PER_SECOND, SECONDS_PER_HOUR } from '@/shared/constants';
import type { ServerConfigResponse } from '@topskip/common/server-analysis-contract';

const SERVER_CONFIG_REFRESH_INTERVAL_MS = SECONDS_PER_HOUR * MS_PER_SECOND;

/**
 * Negotiates server-owned compatibility without coupling it to the extension
 * release; static API only.
 */
export class ServerAnalysisConfiguration {
    /**
     * Coalesces config refreshes caused by simultaneous watch tabs.
     */
    private static refreshInFlight: Promise<ServerConfigResponse | null> | null =
        null;

    /**
     * Covers the rare case where Chrome cannot persist an attempt timestamp
     * while the service worker remains alive.
     */
    private static unpersistedRefreshAttemptAtMs: number | null = null;

    /**
     * Invalidates cache rows produced by any other server algorithm.
     *
     * @param algorithmVersion - Active version reported by the server.
     * @returns Promise resolved after a best-effort cleanup.
     */
    private static async removeOtherAlgorithms(
        algorithmVersion: string,
    ): Promise<void> {
        try {
            await ServerResultCacheStorage.removeOtherAlgorithmVersions(
                algorithmVersion,
            );
        } catch {
            // Cache cleanup must not block analysis or a valid server response.
        }
    }

    /**
     * Refreshes stale configuration while retaining a stale snapshot only as
     * an offline cache hint.
     *
     * @param fallback - Last validated config, if any.
     * @param nowMs - Fetch time used for persistence.
     * @returns Fresh config, the offline fallback, or `null`.
     */
    private static async refresh(
        fallback: Awaited<ReturnType<typeof ServerConfigStorage.load>>,
        nowMs: number,
    ): Promise<ServerConfigResponse | null> {
        if (ServerAnalysisConfiguration.refreshInFlight !== null) {
            return ServerAnalysisConfiguration.refreshInFlight;
        }

        ServerAnalysisConfiguration.refreshInFlight = (async () => {
            try {
                await ServerConfigStorage.saveRefreshAttempt(nowMs);
                ServerAnalysisConfiguration.unpersistedRefreshAttemptAtMs =
                    null;
            } catch {
                ServerAnalysisConfiguration.unpersistedRefreshAttemptAtMs =
                    nowMs;
            }

            let fresh: ServerConfigResponse;
            try {
                fresh = await ServerAnalysisClient.requestConfig();
            } catch {
                return fallback?.config ?? null;
            }

            try {
                await ServerConfigStorage.save(fresh, nowMs);
            } catch {
                // The in-memory response remains authoritative for this request.
            }
            if (
                fallback === null ||
                fallback.config.algorithmVersion !== fresh.algorithmVersion
            ) {
                await ServerAnalysisConfiguration.removeOtherAlgorithms(
                    fresh.algorithmVersion,
                );
            }
            return fresh;
        })();

        try {
            return await ServerAnalysisConfiguration.refreshInFlight;
        } finally {
            ServerAnalysisConfiguration.refreshInFlight = null;
        }
    }

    /**
     * Resolves the active config, making at most one HTTP refresh per hour.
     *
     * @param nowMs - Current epoch time, injectable for tests.
     * @returns Active or offline-fallback config, otherwise `null`.
     */
    static async loadActive(
        nowMs = Date.now(),
    ): Promise<ServerConfigResponse | null> {
        const [cached, persistedAttemptAtMs] = await Promise.all([
            ServerConfigStorage.load(),
            ServerConfigStorage.loadLastRefreshAttempt(),
        ]);
        const lastAttemptAtMs = Math.max(
            persistedAttemptAtMs ?? 0,
            ServerAnalysisConfiguration.unpersistedRefreshAttemptAtMs ?? 0,
        );
        if (
            cached !== null &&
            nowMs - cached.fetchedAtMs < SERVER_CONFIG_REFRESH_INTERVAL_MS
        ) {
            return cached.config;
        }
        if (
            lastAttemptAtMs > 0 &&
            nowMs - lastAttemptAtMs < SERVER_CONFIG_REFRESH_INTERVAL_MS
        ) {
            return cached?.config ?? null;
        }
        return ServerAnalysisConfiguration.refresh(cached, nowMs);
    }

    /**
     * Reads support metadata without causing popup-driven server traffic.
     *
     * @returns Last validated config, otherwise `null`.
     */
    static async loadCached(): Promise<ServerConfigResponse | null> {
        return (await ServerConfigStorage.load())?.config ?? null;
    }

    /**
     * Accepts any bounded algorithm version returned under API v1 and makes
     * future local cache lookups follow that server-owned version.
     *
     * @param algorithmVersion - Version from an analysis response.
     * @returns Promise resolved after best-effort persistence and cleanup.
     */
    static async noteAlgorithmVersion(algorithmVersion: string): Promise<void> {
        const cached = await ServerConfigStorage.load();
        if (cached?.config.algorithmVersion === algorithmVersion) {
            return;
        }

        if (cached !== null) {
            try {
                await ServerConfigStorage.save(
                    { ...cached.config, algorithmVersion },
                    cached.fetchedAtMs,
                );
            } catch {
                // A response remains usable even if the compatibility hint is not saved.
            }
        }
        await ServerAnalysisConfiguration.removeOtherAlgorithms(
            algorithmVersion,
        );
    }
}
