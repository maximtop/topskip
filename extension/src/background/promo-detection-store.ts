import { PromoDetectionBroadcast } from
  '@/background/messaging/broadcast-promo-detection-updated';
import type { PromoDetectionStatePayload } from '@/shared/messages';

/**
 * In-memory promo detection snapshots keyed by browser tab id (background
 * only).
 */
export class PromoDetectionStore {
  private constructor() {}

  private static readonly tabState = new Map<
    number,
    PromoDetectionStatePayload
  >();

  /**
   * @param tabId - Browser tab id
   * @returns Last known detection snapshot for the tab, or `null`
   */
  static get(tabId: number): PromoDetectionStatePayload | null {
    return PromoDetectionStore.tabState.get(tabId) ?? null;
  }

  /**
   * @param tabId - Browser tab id
   * @param state - Snapshot to store
   */
  static set(tabId: number, state: PromoDetectionStatePayload): void {
    PromoDetectionStore.tabState.set(tabId, state);
    PromoDetectionBroadcast.notify(state);
  }

  /**
   * @param tabId - Browser tab id
   */
  static clear(tabId: number): void {
    PromoDetectionStore.tabState.delete(tabId);
  }
}
