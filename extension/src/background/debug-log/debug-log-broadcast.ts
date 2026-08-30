import browser from '@/shared/browser';
import {
    TOPSKIP_MESSAGE,
    type DebugLogStateUpdatedMessage,
} from '@/shared/messages';

/**
 * Pushes the switch state to every live content context and to open
 * extension pages after it changes; mirrors `PrefsBroadcast` for tabs and
 * `PromoDetectionBroadcast` for pages. Static API only.
 */
export class DebugLogBroadcast {
    /**
     * Best-effort fan-out: one bad tab or a closed popup never blocks the
     * rest, and no failure surfaces as a console line.
     *
     * @param enabled - New switch state.
     * @returns Promise settled after every delivery attempt.
     */
    static async notifyStateChanged(enabled: boolean): Promise<void> {
        const msg: DebugLogStateUpdatedMessage = {
            type: TOPSKIP_MESSAGE.DEBUG_LOG_STATE_UPDATED,
            enabled,
        };
        let tabs: Awaited<ReturnType<typeof browser.tabs.query>>;
        try {
            tabs = await browser.tabs.query({});
        } catch {
            tabs = [];
        }
        await Promise.all(
            tabs.map(async (tab) => {
                if (tab.id === undefined) {
                    return;
                }
                try {
                    await browser.tabs.sendMessage(tab.id, msg);
                } catch {
                    // No listener: chrome:// URLs, tabs without our content script.
                }
            }),
        );
        try {
            await browser.runtime.sendMessage(msg);
        } catch {
            // Popup/options closed: no runtime listener in an extension page.
        }
    }
}
