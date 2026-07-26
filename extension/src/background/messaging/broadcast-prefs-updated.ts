import browser from '@/shared/browser';
import type { UserPreferences } from '@/shared/constants';
import { TOPSKIP_MESSAGE, type TopSkipRuntimeMessage } from '@/shared/messages';

// FIXME why content script does not send message to background
// to check that settings were not changed before starting to work?
/**
 * Pushes prefs to every tab’s content scripts after the background has written
 * storage. Needed because only the background reads/writes prefs in
 * `browser.storage.local`; the watch script keeps a copy in memory for skip
 * logic and does not poll storage, so without this broadcast a user toggle in
 * the popup would not apply on already-open YouTube tabs until reload.
 * Extension pages get the same payload via `PrefsPortHub` instead.
 * Static API only.
 */
export class PrefsBroadcast {
    /**
     * Fan-out `PREFS_UPDATED` so each tab’s injected script can refresh cached
     * prefs (e.g. `enabled`). Uses `tabs.query({})` because any tab could host a
     * stale content script; failures are ignored per tab so one bad URL cannot
     * block the rest.
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
                    // No listener: chrome:// URLs, tabs without our content script, etc.
                }
            }),
        );
    }
}
