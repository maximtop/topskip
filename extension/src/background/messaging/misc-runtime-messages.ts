import { DebugLogStore } from '@/background/debug-log/debug-log-store';
import { PromoDetectionStore } from '@/background/promo-detection-store';
import browser from '@/shared/browser';
import { getErrorMessage } from '@/shared/error';
import {
    type ContentLogLevel,
    type GetDetectionStatusResponse,
    type PromoDetectionStatePayload,
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
     * Reads `PromoDetectionStore` for the frontmost tab in the current window
     * and the debug-log switch state for the popup indicator; this poll is
     * never logged as an event.
     *
     * @returns Detection snapshot for the active tab plus the switch state
     */
    static async handleGet(): Promise<GetDetectionStatusResponse> {
        try {
            await PromoDetectionStore.ready();
            await DebugLogStore.ready();
            const debugLoggingEnabled = DebugLogStore.isEnabled();
            const tabs = await browser.tabs.query({
                active: true,
                currentWindow: true,
            });
            const tabId = tabs[0]?.id;
            if (tabId === undefined) {
                return { ok: true, tabId: null, state: null, debugLoggingEnabled };
            }
            const state = PromoDetectionStore.get(tabId);
            return { ok: true, tabId, state, debugLoggingEnabled };
        } catch (e) {
            return { ok: false, error: getErrorMessage(e) };
        }
    }

    /**
     * Seeds popup detection state for dev/e2e visual checks only.
     *
     * @param state - Detection state to store, or `null` to clear it.
     * @param tabId - Sender tab id whose popup state should be seeded.
     * @returns Ack response for the dev-only mutation.
     */
    static async handleDevSet(
        state: PromoDetectionStatePayload | null,
        tabId: number | undefined,
    ): Promise<{ ok: true } | { ok: false; error: string }> {
        if (!__TOPSKIP_INCLUDE_DEV_LOCAL__) {
            return {
                ok: false,
                error: 'Dev detection seeding is disabled.',
            };
        }

        if (tabId === undefined) {
            return {
                ok: false,
                error: 'Missing sender tab id.',
            };
        }

        if (state === null) {
            await PromoDetectionStore.clear(tabId);
            return { ok: true };
        }

        await PromoDetectionStore.set(tabId, state);
        return { ok: true };
    }
}
