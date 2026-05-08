import { PromoDetectionStore } from '@/background/promo-detection-store';
import browser from '@/shared/browser';
import { getErrorMessage } from '@/shared/error';
import {
    type ContentLogLevel,
    type GetDetectionStatusResponse,
} from '@/shared/messages';
import { LOG_PREFIX_CONTENT } from '@/shared/constants';

/**
 * Handles `TOPSKIP_CONTENT_LOG` messages from the content
 * script and replays them to the service worker console.
 */
export class ContentLogMessages {
    /**
     * Prints a content-script log line in the service-worker console,
     * prefixed with the originating tab id when available.
     *
     * @param level - Console method to call (`info`, `warn`, or `error`).
     * @param args - Arguments to forward verbatim to the console method.
     * @param tabId - Tab id from the sender, or `undefined` when not present.
     */
    static log(
        level: ContentLogLevel,
        args: unknown[],
        tabId: number | undefined,
    ): void {
        const tag =
            tabId !== undefined
                ? `[TopSkip content t${tabId}]`
                : LOG_PREFIX_CONTENT;

        console[level](tag, ...args);
    }
}

/**
 * Handles promo detection status queries from the popup; not instantiable.
 */
export class PromoDetectionRuntimeMessages {
    /**
     * Reads `PromoDetectionStore` for the frontmost tab in the current window.
     *
     * @returns Detection snapshot for the active tab
     */
    static async handleGet(): Promise<GetDetectionStatusResponse> {
        try {
            const tabs = await browser.tabs.query({
                active: true,
                currentWindow: true,
            });
            const tabId = tabs[0]?.id;
            if (tabId === undefined) {
                return { ok: true, state: null };
            }
            const state = PromoDetectionStore.get(tabId);
            return { ok: true, state };
        } catch (e) {
            return { ok: false, error: getErrorMessage(e) };
        }
    }
}
