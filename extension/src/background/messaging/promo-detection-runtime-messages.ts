import type { Runtime } from 'webextension-polyfill/namespaces/runtime';

import { PromoDetectionStore } from '@/background/promo-detection-store';
import { getErrorMessage } from '@/shared/error';
import browser from '@/shared/browser';
import {
  TOPSKIP_MESSAGE,
  type GetDetectionStatusResponse,
} from '@/shared/messages';

/**
 * Handles promo detection status queries from the popup; not instantiable.
 */
export class PromoDetectionRuntimeMessages {
  private constructor() {}

  /**
   * @param message - Opaque runtime message
   * @param _sender - Extension sender (unused)
   * @returns Response promise, or `undefined` when ignored (synchronously)
   */
  static handle(
    message: unknown,
    _sender: Runtime.MessageSender,
  ): Promise<GetDetectionStatusResponse> | undefined {
    if (!message || typeof message !== 'object') {
      return undefined;
    }
    const typeRaw: unknown = Reflect.get(message, 'type');
    if (typeRaw !== TOPSKIP_MESSAGE.GET_DETECTION_STATUS) {
      return undefined;
    }
    return PromoDetectionRuntimeMessages.handleGet();
  }

  /**
   * @returns Detection snapshot for the active tab
   */
  private static async handleGet(): Promise<GetDetectionStatusResponse> {
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
