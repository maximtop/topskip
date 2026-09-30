/**
 * @file Small runtime handler that doesn't warrant its own module:
 * promo-detection status queries for the popup.
 */

import { DebugLogStore } from '@/background/debug-log/debug-log-store';
import { PromoDetectionStore } from '@/background/promo-detection-store';
import browser from '@/shared/browser';
import { getErrorMessage } from '@/shared/error';
import {
    type GetDetectionStatusResponse,
    type PromoDetectionStatePayload,
} from '@/shared/messages';

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
                return {

                    ok: true,
                    tabId: null,
                    state: null,
                    debugLoggingEnabled,
                };
            }
            const state = PromoDetectionStore.get(tabId);
            return {

                ok: true,
                tabId,
                state,
                debugLoggingEnabled,
            };
        } catch (e) {
            return { ok: false, error: getErrorMessage(e) };
        }
    }

    /**
     * Seeds popup detection state for dev/e2e visual checks only.
     *
     * @param state - Detection state to store, or `null` to clear it.
     * @param tabId - Sender tab id whose popup state should be seeded.
     *
     * @returns Ack response for the dev-only mutation.
     */
    static async handleDevSet(
        state: PromoDetectionStatePayload | null,
        tabId: number | undefined,
    ): Promise<{ ok: true } | { ok: false; error: string }> {
        if (!TOPSKIP_INCLUDE_DEV_LOCAL) {
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
