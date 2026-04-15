import browser from '@/shared/browser';
import { getWatchContentScriptMatches } from '@/shared/content-script-matches';

import { PrefsSyncStorage } from '@/background/storage/prefs-sync';

const WATCH_SCRIPT_ID = 'topskip-watch';

/**
 * Registers or unregisters the watch `content.js` bundle based on prefs.
 */
export class ContentScriptsRegistration {
  private constructor() {}

  /**
   * Applies `enabled`: when `true`, registers YouTube (+ dev localhost)
   * matches; when `false`, unregisters.
   *
   * @returns Promise that settles when scripting APIs finish
   */
  static async syncFromPrefs(): Promise<void> {
    await PrefsSyncStorage.ready();
    const prefs = await PrefsSyncStorage.load();
    if (prefs.enabled) {
      await ContentScriptsRegistration.registerWatchScript();
    } else {
      await ContentScriptsRegistration.unregisterWatchScript();
    }
  }

  /**
   * @returns Promise that settles when the script is registered
   */
  private static async registerWatchScript(): Promise<void> {
    await ContentScriptsRegistration.unregisterWatchScript();
    const matches = getWatchContentScriptMatches();
    const js = ['content.js'];
    await browser.scripting.registerContentScripts([
      {
        id: WATCH_SCRIPT_ID,
        matches,
        js,
        runAt: 'document_idle',
      },
    ]);
  }

  /**
   * @returns Promise that settles when unregister completes (errors ignored)
   */
  private static async unregisterWatchScript(): Promise<void> {
    try {
      await browser.scripting.unregisterContentScripts({
        ids: [WATCH_SCRIPT_ID],
      });
    } catch {
      /* not registered */
    }
  }
}
