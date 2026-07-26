import browser from '@/shared/browser';

const TRUSTED_STORAGE_ACCESS_LEVEL = 'TRUSTED_CONTEXTS';

/**
 * Restricts extension-local storage before background code can read secrets;
 * static API only.
 */
export class BackgroundStorageAccess {
    /**
     * Shares the startup restriction across every storage-dependent handler.
     */
    private static accessPromise: Promise<void> | null = null;

    /**
     * Applies Chrome's trusted-context-only storage boundary and fails closed
     * when the target browser cannot enforce it.
     *
     * @returns Promise resolved only after the restriction is active.
     */
    private static async applyRestriction(): Promise<void> {
        const setter: unknown = Reflect.get(
            browser.storage.local,
            'setAccessLevel',
        );
        if (typeof setter !== 'function') {
            throw new Error('Trusted storage access is unavailable.');
        }
        const result: unknown = Reflect.apply(setter, browser.storage.local, [
            { accessLevel: TRUSTED_STORAGE_ACCESS_LEVEL },
        ]);
        await result;
    }

    /**
     * Exposes one startup barrier for all background-owned storage operations.
     *
     * @returns Shared promise for trusted-context storage enforcement.
     */
    static ready(): Promise<void> {
        if (BackgroundStorageAccess.accessPromise === null) {
            BackgroundStorageAccess.accessPromise =
                BackgroundStorageAccess.applyRestriction();
        }
        return BackgroundStorageAccess.accessPromise;
    }
}
