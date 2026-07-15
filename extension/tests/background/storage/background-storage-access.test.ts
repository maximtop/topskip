import { describe, expect, it, vi } from 'vitest';

const setAccessLevel = vi.fn().mockResolvedValue(undefined);

vi.mock('@/shared/browser', () => ({
    default: {
        storage: {
            local: { setAccessLevel },
        },
    },
}));

const { BackgroundStorageAccess } =
    await import('@/background/storage/background-storage-access');

describe('BackgroundStorageAccess', () => {
    it('restricts local storage to trusted contexts exactly once', async () => {
        await Promise.all([
            BackgroundStorageAccess.ready(),
            BackgroundStorageAccess.ready(),
        ]);

        expect(setAccessLevel).toHaveBeenCalledOnce();
        expect(setAccessLevel).toHaveBeenCalledWith({
            accessLevel: 'TRUSTED_CONTEXTS',
        });
    });
});
