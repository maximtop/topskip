import { ExtensionContextWatch } from '@/content/extension-context-watch';
import { WatchCaptions } from '@/content/watch-captions';
import { YoutubeWatch } from '@/content/youtube-watch';

/**
 * Content script bundle: starts watch-page orchestration.
 *
 * i18n is not initialized here — content scripts rely on the native
 * `browser.i18n.getMessage()` fallback (always available, synchronous,
 * reads `_locales/` without fetch).
 */
export class Content {
    /**
     * Starts YouTube watch orchestration unconditionally: `YoutubeWatch`
     * re-gates on every navigation/poll tick, so a script that lands on a
     * non-watch page (home, SPA entry) still activates once the user reaches
     * a watch URL. A top-level URL gate here would leave such tabs dead.
     *
     * The bundle also watches its own extension runtime: an install, update,
     * or manual reload orphans this context without a replacement, so the
     * orphan must neutralize itself (see `teardownOrphanedContext`).
     *
     * @returns Cleanup callback used when a newer content bundle replaces this one.
     */
    static init(): () => void {
        const disposeWatch = YoutubeWatch.init();
        const stopContextWatch = ExtensionContextWatch.start(() => {
            Content.teardownOrphanedContext(disposeWatch);
        });
        return (): void => {
            stopContextWatch();
            disposeWatch();
        };
    }

    /**
     * An orphaned context is already inert towards the background, but its
     * page side effects outlive it: ISOLATED `<video>` listeners and timers,
     * and the MAIN bridge's `fetch`/XHR wrappers. Both are released here so
     * the document returns to its pre-extension state without a reload.
     *
     * The MAIN teardown command is sent only on this path, never from the
     * replacement dispose: when a newer bundle pair takes over the document,
     * its MAIN bridge has already retired the old one, and a `teardown` from
     * the outgoing ISOLATED side would kill the new bridge instead.
     *
     * @param disposeWatch - Cleanup returned by `YoutubeWatch.init`.
     */
    private static teardownOrphanedContext(disposeWatch: () => void): void {
        disposeWatch();
        // Nothing can report a failure here: the runtime is gone and the
        // document should not see an unhandled rejection from the orphan.
        void WatchCaptions.teardownPageBridge().catch(() => undefined);
    }
}
