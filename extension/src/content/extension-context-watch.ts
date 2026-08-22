import browser from '@/shared/browser';

/**
 * Orphan detection is hygiene, not a user-visible path, so one cheap property
 * read per second is plenty and stays far below the video-binding poll cost.
 */
export const EXTENSION_CONTEXT_POLL_INTERVAL_MS = 1000;

/**
 * Notices when the extension that injected this content script is reloaded,
 * updated, or removed while the document stays open.
 *
 * Chrome keeps such a content context running but severs its runtime:
 * `runtime.id` becomes `undefined` and API access throws "Extension context
 * invalidated". No event announces this, so the context must poll. Static
 * API only.
 */
export class ExtensionContextWatch {
    /**
     * Reads the live runtime id through the polyfill proxy (a pass-through
     * getter, not a cached value) so the check reflects the current binding.
     * An access that throws is treated as invalidated because only a severed
     * binding throws here.
     *
     * @returns Whether this context can no longer reach its extension.
     */
    static isInvalidated(): boolean {
        try {
            const runtimeId: unknown = browser.runtime.id;
            return typeof runtimeId !== 'string' || runtimeId.length === 0;
        } catch {
            return true;
        }
    }

    /**
     * Polls until the first invalidation, then stops itself before notifying
     * so the callback runs exactly once.
     *
     * @param onInvalidated - Cleanup to run once the runtime is gone.
     * @returns Idempotent stop callback for a replacement content bundle.
     */
    static start(onInvalidated: () => void): () => void {
        let intervalId: ReturnType<typeof globalThis.setInterval> | null =
            null;
        const stop = (): void => {
            if (intervalId === null) {
                return;
            }
            globalThis.clearInterval(intervalId);
            intervalId = null;
        };
        intervalId = globalThis.setInterval(() => {
            if (!ExtensionContextWatch.isInvalidated()) {
                return;
            }
            stop();
            onInvalidated();
        }, EXTENSION_CONTEXT_POLL_INTERVAL_MS);
        return stop;
    }
}
