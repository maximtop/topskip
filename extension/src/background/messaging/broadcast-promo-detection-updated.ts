import browser from '@/shared/browser';
import {
    TOPSKIP_MESSAGE,
    type PromoDetectionStatePayload,
    type TopSkipRuntimeMessage,
} from '@/shared/messages';

/**
 * Pushes promo-detection snapshots to extension UI after
 * {@link PromoDetectionStore} mutates. The store is background-only memory; the
 * popup does not observe that Map, so it cannot react unless we signal. It
 * already polls `GET_DETECTION_STATUS` on an interval; this message lets an
 * open popup refresh as soon as analysis finishes instead of waiting for the
 * next tick. Uses `runtime.sendMessage` (not `tabs.sendMessage`) because only
 * extension pages subscribe — watch content does not render this status.
 * Static API only.
 */
export class PromoDetectionBroadcast {
    /**
     * Fire-and-forget broadcast; rejects when no receiver exists (e.g. popup
     * closed), which is normal and must not surface as an error.
     *
     * @param payload - Latest detection snapshot (no secrets)
     */
    static notify(payload: PromoDetectionStatePayload): void {
        const msg: TopSkipRuntimeMessage = {
            type: TOPSKIP_MESSAGE.PROMO_DETECTION_UPDATED,
            payload,
        };
        void browser.runtime.sendMessage(msg).catch(() => {
            // Popup/options closed: no runtime listener in an extension page.
        });
    }
}
