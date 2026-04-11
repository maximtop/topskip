import { YoutubeWatch } from '@/content/youtube-watch';

/**
 * Content script bundle: gates activation and starts watch-page orchestration.
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
