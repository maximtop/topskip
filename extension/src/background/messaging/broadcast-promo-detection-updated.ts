import browser from '@/shared/browser';
import {
  TOPSKIP_MESSAGE,
  type PromoDetectionStatePayload,
  type TopSkipRuntimeMessage,
} from '@/shared/messages';

/**
 * Notifies extension pages (e.g. popup) that detection state changed for a tab.
 */
export class PromoDetectionBroadcast {
  private constructor() {}

  /**
   * Best-effort fan-out to listeners of
   * {@link TOPSKIP_MESSAGE.PROMO_DETECTION_UPDATED}.
   *
   * @param payload - Latest detection snapshot (no secrets)
   */
  static notify(payload: PromoDetectionStatePayload): void {
    const msg: TopSkipRuntimeMessage = {
      type: TOPSKIP_MESSAGE.PROMO_DETECTION_UPDATED,
      payload,
    };
    void browser.runtime.sendMessage(msg).catch(() => {
      /* no extension page listening */
    });
  }
}
