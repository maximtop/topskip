import { YoutubeWatch } from '@/content/youtube-watch';

/**
 * Content script bundle: gates activation and starts watch-page orchestration.
 *
 * i18n is not initialized here — content scripts rely on the native
 * `browser.i18n.getMessage()` fallback (always available, synchronous,
 * reads `_locales/` without fetch).
 */
export class Content {
  private constructor() {}

  /**
   * Runs YouTube watch logic when the current URL matches TopSkip rules.
   */
  static init(): void {
    if (!YoutubeWatch.shouldActivateForPage()) {
      return;
    }
    YoutubeWatch.init();
  }
}
