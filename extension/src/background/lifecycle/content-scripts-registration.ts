import browser from '@/shared/browser';
import { getWatchContentScriptMatches } from '@/shared/content-script-matches';
import { TOPSKIP_MESSAGE } from '@/shared/messages';

import { PrefsSyncStorage } from '@/background/storage/prefs-sync';
import { BackgroundServerAnalysisLog } from '@/background/server-analysis-log';

/**
 * Registers or unregisters the watch `content.js` bundle based on prefs.
 */
export class ContentScriptsRegistration {
    /**
     * Stable `scripting.registerContentScripts` id for the watch bundle.
     */
    private static readonly WATCH_SCRIPT_ID = 'topskip-watch';

    /**
     * MAIN-world bridge id; separate from content.js because worlds differ.
     */
    private static readonly CAPTION_PAGE_BRIDGE_SCRIPT_ID =
        'topskip-caption-page-bridge';

    /**
     * Applies `enabled`: when `true`, registers YouTube (+ dev localhost)
     * matches; when `false`, unregisters.
     *
     * @returns Promise that settles when scripting APIs finish
     */
    static async syncFromPrefs(): Promise<void> {
        await PrefsSyncStorage.ready();
        const prefs = await PrefsSyncStorage.load();
        BackgroundServerAnalysisLog.info('content-script-sync', {
            enabled: prefs.enabled,
            analysisMode: prefs.analysisMode,
        });
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
        await browser.scripting.registerContentScripts([
            {
                id: ContentScriptsRegistration.CAPTION_PAGE_BRIDGE_SCRIPT_ID,
                matches,
                js: ['caption-page-bridge.js'],
                runAt: 'document_start',
                world: 'MAIN',
            },
            {
                id: ContentScriptsRegistration.WATCH_SCRIPT_ID,
                matches,
                js: ['content.js'],
                runAt: 'document_start',
            },
        ]);
        BackgroundServerAnalysisLog.info('content-scripts-registered', {
            matchCount: matches.length,
        });
        await ContentScriptsRegistration.injectIntoExistingTabs(matches);
    }

    /**
     * Injects the bundles into tabs opened before registration —
     * `registerContentScripts` only covers pages loaded afterwards. A live
     * content bundle acknowledges the probe; an invalidated or older bundle
     * is replaced through its disposable lifecycle.
     *
     * @param matches Match patterns the watch script was registered for.
     * @returns Promise that settles when injection attempts finish
     * (best-effort per tab).
     */
    private static async injectIntoExistingTabs(
        matches: string[],
    ): Promise<void> {
        const tabs = await browser.tabs.query({ url: matches });
        const results = await Promise.all(
            tabs.map(async (tab) => {
                if (tab.id === undefined) {
                    return false;
                }
                if (
                    await ContentScriptsRegistration.isWatchScriptReady(tab.id)
                ) {
                    return false;
                }
                try {
                    await browser.scripting.executeScript({
                        target: { tabId: tab.id, frameIds: [0] },
                        world: 'MAIN',
                        files: ['caption-page-bridge.js'],
                    });
                    await browser.scripting.executeScript({
                        target: { tabId: tab.id, frameIds: [0] },
                        files: ['content.js'],
                    });
                    return true;
                } catch {
                    // Discarded tabs, closed tabs, etc.
                    return false;
                }
            }),
        );
        BackgroundServerAnalysisLog.info(
            'content-scripts-injected-existing-tabs',
            {
                matchedTabCount: tabs.length,
                injectedTabCount: results.filter(Boolean).length,
            },
        );
    }

    /**
     * Distinguishes a current watch script from an invalidated pre-update one.
     *
     * @param tabId Matching top-level tab to probe.
     * @returns Whether the current content bundle acknowledged the probe.
     */
    private static async isWatchScriptReady(tabId: number): Promise<boolean> {
        try {
            const response: unknown = await browser.tabs.sendMessage(tabId, {
                type: TOPSKIP_MESSAGE.CONTENT_SCRIPT_READY,
            });
            return (
                response !== null &&
                typeof response === 'object' &&
                Reflect.get(response, 'ok') === true
            );
        } catch {
            return false;
        }
    }

    /**
     * Removes the watch content script id so prefs-off or reload stays clean.
     *
     * @returns Promise that settles when unregister completes (errors ignored)
     */
    private static async unregisterWatchScript(): Promise<void> {
        try {
            await browser.scripting.unregisterContentScripts({
                ids: [
                    ContentScriptsRegistration.WATCH_SCRIPT_ID,
                    ContentScriptsRegistration.CAPTION_PAGE_BRIDGE_SCRIPT_ID,
                ],
            });
            BackgroundServerAnalysisLog.info('content-scripts-unregistered');
        } catch {
            // not registered
        }
    }
}
