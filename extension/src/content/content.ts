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
     */
    static init(): void {
        YoutubeWatch.init();
    }
}
