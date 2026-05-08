import browser from '@/shared/browser';
import { getWatchContentScriptMatches } from '@/shared/content-script-matches';

import { PrefsSyncStorage } from '@/background/storage/prefs-sync';

/**
 * Registers or unregisters the watch `content.js` bundle based on prefs.
 */
export class ContentScriptsRegistration {
    /**
     * Stable `scripting.registerContentScripts` id for the watch bundle.
     */
    private static readonly WATCH_SCRIPT_ID = 'topskip-watch';

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
     * Registers `content.js` for YouTube (+ dev) matches after best-effort
     * unregister.
     *
     * @returns Promise that settles when the script is registered
     */
    private static async registerWatchScript(): Promise<void> {
        await ContentScriptsRegistration.unregisterWatchScript();
        const matches = getWatchContentScriptMatches();
        const js = ['content.js'];
        await browser.scripting.registerContentScripts([
            {
                id: ContentScriptsRegistration.WATCH_SCRIPT_ID,
                matches,
                js,
                runAt: 'document_idle',
            },
        ]);
    }

    /**
     * Removes the watch content script id so prefs-off or reload stays clean.
     *
     * @returns Promise that settles when unregister completes (errors ignored)
     */
    private static async unregisterWatchScript(): Promise<void> {
        try {
            await browser.scripting.unregisterContentScripts({
                ids: [ContentScriptsRegistration.WATCH_SCRIPT_ID],
            });
        } catch {
            // not registered
        }
    }
}
