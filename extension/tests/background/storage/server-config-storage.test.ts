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

const { STORAGE_KEY_SERVER_CONFIG, STORAGE_KEY_SERVER_CONFIG_REFRESH_ATTEMPT } =
    await import('@/shared/constants');
const { ServerConfigStorage } =
    await import('@/background/storage/server-config-storage');

const NOW_MS = 1_900_000_000_000;
const CONFIG = {
    apiVersion: 1 as const,
    algorithmVersion: 'server-v6',
    supportedCapabilities: ['processing-status', 'typed-server-errors-v1'],
    supportIssueBaseUrl: 'https://github.com/maximtop/topskip/issues/new',
};

describe('ServerConfigStorage', () => {
    beforeEach(() => {
        storageGet.mockReset();
        storageSet.mockReset();
        storageRemove.mockReset();
    });

    it('loads a validated config snapshot with its fetch time', async () => {
        storageGet.mockResolvedValue({
            [STORAGE_KEY_SERVER_CONFIG]: {
                config: CONFIG,
                fetchedAtMs: NOW_MS,
            },
        });

        await expect(ServerConfigStorage.load()).resolves.toEqual({
            config: CONFIG,
            fetchedAtMs: NOW_MS,
        });
    });

    it('removes malformed snapshots', async () => {
        storageGet.mockResolvedValue({
            [STORAGE_KEY_SERVER_CONFIG]: {
                config: { algorithmVersion: 'server-v6' },
                fetchedAtMs: NOW_MS,
            },
        });

        await expect(ServerConfigStorage.load()).resolves.toBeNull();
        expect(storageRemove).toHaveBeenCalledWith(STORAGE_KEY_SERVER_CONFIG);
    });

    it('persists only a validated public config and fetch time', async () => {
        await ServerConfigStorage.save(CONFIG, NOW_MS);

        expect(storageSet).toHaveBeenCalledWith({
            [STORAGE_KEY_SERVER_CONFIG]: {
                config: CONFIG,
                fetchedAtMs: NOW_MS,
            },
        });
    });

    it('persists and reads the last config refresh attempt independently', async () => {
        storageGet.mockResolvedValue({
            [STORAGE_KEY_SERVER_CONFIG_REFRESH_ATTEMPT]: NOW_MS,
        });

        await expect(
            ServerConfigStorage.loadLastRefreshAttempt(),
        ).resolves.toBe(NOW_MS);
        await ServerConfigStorage.saveRefreshAttempt(NOW_MS);

        expect(storageSet).toHaveBeenCalledWith({
            [STORAGE_KEY_SERVER_CONFIG_REFRESH_ATTEMPT]: NOW_MS,
        });
    });

    it('removes a malformed config refresh attempt', async () => {
        storageGet.mockResolvedValue({
            [STORAGE_KEY_SERVER_CONFIG_REFRESH_ATTEMPT]: 'not-an-epoch',
        });

        await expect(
            ServerConfigStorage.loadLastRefreshAttempt(),
        ).resolves.toBeNull();
        expect(storageRemove).toHaveBeenCalledWith(
            STORAGE_KEY_SERVER_CONFIG_REFRESH_ATTEMPT,
        );
    });
});
