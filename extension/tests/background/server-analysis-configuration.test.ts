import { beforeEach, describe, expect, it, vi } from 'vitest';

const clientMocks = vi.hoisted(() => ({
    requestConfig: vi.fn(),
}));
const configStorageMocks = vi.hoisted(() => ({
    load: vi.fn(),
    loadLastRefreshAttempt: vi.fn(),
    save: vi.fn(),
    saveRefreshAttempt: vi.fn(),
}));
const resultCacheMocks = vi.hoisted(() => ({
    removeOtherAlgorithmVersions: vi.fn(),
}));

vi.mock('@/background/server-analysis-client', () => ({
    ServerAnalysisClient: clientMocks,
}));
vi.mock('@/background/storage/server-config-storage', () => ({
    ServerConfigStorage: configStorageMocks,
}));
vi.mock('@/background/storage/server-result-cache', () => ({
    ServerResultCacheStorage: resultCacheMocks,
}));

const { ServerAnalysisConfiguration } =
    await import('@/background/server-analysis-configuration');

const NOW_MS = 1_900_000_000_000;
const CONFIG_V4 = {
    apiVersion: 1 as const,
    algorithmVersion: 'server-v4',
    supportedCapabilities: ['processing-status'],
    supportIssueBaseUrl: 'https://github.com/maximtop/topskip/issues/new',
};
const CONFIG_V5 = {
    ...CONFIG_V4,
    algorithmVersion: 'server-v6',
    supportedCapabilities: ['processing-status', 'typed-server-errors-v1'],
};

describe('ServerAnalysisConfiguration', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        configStorageMocks.loadLastRefreshAttempt.mockResolvedValue(null);
        configStorageMocks.save.mockResolvedValue(undefined);
        configStorageMocks.saveRefreshAttempt.mockResolvedValue(undefined);
        resultCacheMocks.removeOtherAlgorithmVersions.mockResolvedValue(
            undefined,
        );
    });

    it('uses a config fetched less than one hour ago without HTTP', async () => {
        configStorageMocks.load.mockResolvedValue({
            config: CONFIG_V4,
            fetchedAtMs: NOW_MS - 3_599_999,
        });

        await expect(
            ServerAnalysisConfiguration.loadActive(NOW_MS),
        ).resolves.toEqual(CONFIG_V4);
        expect(clientMocks.requestConfig).not.toHaveBeenCalled();
    });

    it('refreshes stale config and invalidates other algorithm caches', async () => {
        configStorageMocks.load.mockResolvedValue({
            config: CONFIG_V4,
            fetchedAtMs: NOW_MS - 3_600_000,
        });
        clientMocks.requestConfig.mockResolvedValue(CONFIG_V5);

        await expect(
            ServerAnalysisConfiguration.loadActive(NOW_MS),
        ).resolves.toEqual(CONFIG_V5);
        expect(configStorageMocks.save).toHaveBeenCalledWith(CONFIG_V5, NOW_MS);
        expect(configStorageMocks.saveRefreshAttempt).toHaveBeenCalledWith(
            NOW_MS,
        );
        expect(
            resultCacheMocks.removeOtherAlgorithmVersions,
        ).toHaveBeenCalledWith('server-v6');
    });

    it('uses a stale config only when refresh is unavailable', async () => {
        configStorageMocks.load.mockResolvedValue({
            config: CONFIG_V4,
            fetchedAtMs: NOW_MS - 3_600_000,
        });
        clientMocks.requestConfig.mockRejectedValue(new Error('offline'));

        await expect(
            ServerAnalysisConfiguration.loadActive(NOW_MS),
        ).resolves.toEqual(CONFIG_V4);
        expect(configStorageMocks.save).not.toHaveBeenCalled();
    });

    it('does not retry a failed refresh again within one hour', async () => {
        configStorageMocks.load.mockResolvedValue({
            config: CONFIG_V4,
            fetchedAtMs: NOW_MS - 7_200_000,
        });
        configStorageMocks.loadLastRefreshAttempt
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce(NOW_MS);
        clientMocks.requestConfig.mockRejectedValue(new Error('offline'));

        await expect(
            ServerAnalysisConfiguration.loadActive(NOW_MS),
        ).resolves.toEqual(CONFIG_V4);
        await expect(
            ServerAnalysisConfiguration.loadActive(NOW_MS + 3_599_999),
        ).resolves.toEqual(CONFIG_V4);

        expect(clientMocks.requestConfig).toHaveBeenCalledOnce();
        expect(configStorageMocks.saveRefreshAttempt).toHaveBeenCalledOnce();
    });

    it('returns null when no config has ever been fetched and HTTP fails', async () => {
        configStorageMocks.load.mockResolvedValue(null);
        clientMocks.requestConfig.mockRejectedValue(new Error('offline'));

        await expect(
            ServerAnalysisConfiguration.loadActive(NOW_MS),
        ).resolves.toBeNull();
    });

    it('records a server-owned response version without extending config TTL', async () => {
        configStorageMocks.load.mockResolvedValue({
            config: CONFIG_V4,
            fetchedAtMs: NOW_MS - 10_000,
        });

        await ServerAnalysisConfiguration.noteAlgorithmVersion('server-v6');

        expect(configStorageMocks.save).toHaveBeenCalledWith(
            { ...CONFIG_V4, algorithmVersion: 'server-v6' },
            NOW_MS - 10_000,
        );
        expect(
            resultCacheMocks.removeOtherAlgorithmVersions,
        ).toHaveBeenCalledWith('server-v6');
    });

    it('uses observed config without equality gating', async () => {
        configStorageMocks.load.mockResolvedValueOnce(null);
        clientMocks.requestConfig.mockRejectedValueOnce(new Error('offline'));

        await expect(
            ServerAnalysisConfiguration.loadActive(NOW_MS),
        ).resolves.toBeNull();
        expect(clientMocks.requestConfig).toHaveBeenCalledOnce();

        configStorageMocks.load.mockResolvedValueOnce({
            config: CONFIG_V4,
            fetchedAtMs: NOW_MS - 7_200_000,
        });
        await ServerAnalysisConfiguration.noteAlgorithmVersion('server-future');

        expect(configStorageMocks.save).toHaveBeenCalledWith(
            { ...CONFIG_V4, algorithmVersion: 'server-future' },
            NOW_MS - 7_200_000,
        );
        expect(
            resultCacheMocks.removeOtherAlgorithmVersions,
        ).toHaveBeenCalledWith('server-future');
        expect(clientMocks.requestConfig).toHaveBeenCalledOnce();
    });

    it('reads cached support configuration without making HTTP requests', async () => {
        configStorageMocks.load.mockResolvedValue({
            config: CONFIG_V4,
            fetchedAtMs: NOW_MS - 10_000,
        });

        await expect(ServerAnalysisConfiguration.loadCached()).resolves.toEqual(
            CONFIG_V4,
        );
        expect(clientMocks.requestConfig).not.toHaveBeenCalled();
    });
});
