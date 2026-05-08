import { PromoDetectionBroadcast } from '@/background/messaging/broadcast-promo-detection-updated';
import type { PromoDetectionStatePayload } from '@/shared/messages';

/**
 * In-memory promo detection snapshots keyed by browser tab id (background
 * only).
 */
export class PromoDetectionStore {
    /**
     * Latest promo detection payload keyed by tab id (memory-only).
     */
    private static readonly tabState = new Map<
        number,
        PromoDetectionStatePayload
    >();

    /**
     * Returns the last promo detection payload published for a tab.
     *
     * @param tabId - Browser tab id
     * @returns Last known detection snapshot for the tab, or `null`
     */
    static get(tabId: number): PromoDetectionStatePayload | null {
        return PromoDetectionStore.tabState.get(tabId) ?? null;
    }

    /**
     * Stores a snapshot and notifies subscribers (e.g. popup).
     *
     * @param tabId - Browser tab id
     * @param state - Snapshot to store
     */
    static set(tabId: number, state: PromoDetectionStatePayload): void {
        PromoDetectionStore.tabState.set(tabId, state);
        PromoDetectionBroadcast.notify(state);
    }

    /**
     * Drops state when the tab can no longer receive updates.
     *
     * @param tabId - Browser tab id
     */
    static clear(tabId: number): void {
        PromoDetectionStore.tabState.delete(tabId);
    }
}
