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

const { STORAGE_KEY_SERVER_INSTALLATION } = await import('@/shared/constants');
const { ServerInstallationStorage } =
    await import('@/background/storage/server-installation-storage');

const NOW_MS = 1_900_000_000_000;

describe('ServerInstallationStorage', () => {
    beforeEach(() => {
        storageGet.mockReset();
        storageSet.mockReset();
        storageRemove.mockReset();
    });

    it('returns a validated unexpired token', async () => {
        storageGet.mockResolvedValue({
            [STORAGE_KEY_SERVER_INSTALLATION]: {
                token: 'a'.repeat(43),
                expiresAtMs: NOW_MS + 60_000,
            },
        });

        await expect(
            ServerInstallationStorage.loadFresh(NOW_MS),
        ).resolves.toEqual({
            token: 'a'.repeat(43),
            expiresAtMs: NOW_MS + 60_000,
        });
        expect(storageRemove).not.toHaveBeenCalled();
    });

    it.each([
        { token: '', expiresAtMs: NOW_MS + 60_000 },
        { token: 'a'.repeat(43), expiresAtMs: NOW_MS },
    ])('removes invalid or expired state %#', async (stored) => {
        storageGet.mockResolvedValue({
            [STORAGE_KEY_SERVER_INSTALLATION]: stored,
        });

        await expect(
            ServerInstallationStorage.loadFresh(NOW_MS),
        ).resolves.toBeNull();
        expect(storageRemove).toHaveBeenCalledWith(
            STORAGE_KEY_SERVER_INSTALLATION,
        );
    });

    it('persists only the token and its expiry', async () => {
        await ServerInstallationStorage.save({
            token: 'b'.repeat(43),
            expiresAtMs: NOW_MS + 60_000,
        });

        expect(storageSet).toHaveBeenCalledWith({
            [STORAGE_KEY_SERVER_INSTALLATION]: {
                token: 'b'.repeat(43),
                expiresAtMs: NOW_MS + 60_000,
            },
        });
    });

    it('clears the background-owned installation credential', async () => {
        await ServerInstallationStorage.clear();

        expect(storageRemove).toHaveBeenCalledWith(
            STORAGE_KEY_SERVER_INSTALLATION,
        );
    });
});
