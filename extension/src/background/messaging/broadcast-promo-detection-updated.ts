import browser from '@/shared/browser';
import {
    TOPSKIP_MESSAGE,
    type PromoDetectionStatePayload,
    type PromoDetectionUpdatedMessage,
} from '@/shared/messages';

/**
 * Pushes promo-detection snapshots to extension UI after
 * {@link PromoDetectionStore} mutates. The store is background-only memory; the
 * popup does not observe that Map, so it cannot react unless we signal. It
 * periodically reconciles `GET_DETECTION_STATUS`; this message lets an open
 * popup update as soon as analysis finishes. The runtime channel is global, so
 * every payload carries its originating tab id. Uses `runtime.sendMessage`
 * because only extension pages subscribe — watch content does not render it.
 * Static API only.
 */
export class PromoDetectionBroadcast {
    /**
     * Fire-and-forget broadcast; rejects when no receiver exists (e.g. popup
     * closed), which is normal and must not surface as an error.
     *
     * @param tabId - Originating browser tab whose state changed.
     * @param payload - Latest detection snapshot or an explicit reset.
     */
    static notify(
        tabId: number,
        payload: PromoDetectionStatePayload | null,
    ): void {
        const msg: PromoDetectionUpdatedMessage = {
            type: TOPSKIP_MESSAGE.PROMO_DETECTION_UPDATED,
            tabId,
            payload,
        };
        void browser.runtime.sendMessage(msg).catch(() => {
            // Popup/options closed: no runtime listener in an extension page.
        });
    }
}
