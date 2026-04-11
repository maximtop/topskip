import browser from '@/shared/browser';
import type { UserPreferences } from '@/shared/constants';
import { TOPSKIP_MESSAGE, type TopSkipRuntimeMessage } from '@/shared/messages';

/**
 * Namespace for fan-out of prefs updates to tabs; not instantiable.
 */
export class PrefsBroadcast {
  private constructor() {}

  /**
   * Notifies all tabs that preferences changed (content scripts update
   * in-memory state).
   *
   * @param prefs The preferences to broadcast.
   * @returns A promise that resolves when broadcast attempts finish
   * (best-effort per tab).
   */
  static async sendUpdatedToAllTabs(prefs: UserPreferences): Promise<void> {
    const msg: TopSkipRuntimeMessage = {
      type: TOPSKIP_MESSAGE.PREFS_UPDATED,
      prefs,
    };
    const tabs = await browser.tabs.query({});
    await Promise.all(
      tabs.map(async (tab) => {
        if (tab.id === undefined) {
          return;
        }
        try {
          await browser.tabs.sendMessage(tab.id, msg);
        } catch {
          /* tab has no receiver (e.g. chrome://) or content script not injected */
        }
      }),
    );
  }
}
