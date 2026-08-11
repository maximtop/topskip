import { ContentScriptsRegistration } from '@/background/lifecycle/content-scripts-registration';
import { PrefsPortHub } from '@/background/messaging/prefs-port-hub';
import { PromoAnalysis } from '@/background/messaging/promo-analysis';
import { registerRuntimeMessages } from '@/background/messaging/register-runtime-messages';
import { PromoDetectionStore } from '@/background/promo-detection-store';
import { defaultRegistry } from '@/background/providers/default-registry';
import { BackgroundStorageAccess } from '@/background/storage/background-storage-access';
import { PrefsSyncStorage } from '@/background/storage/prefs-sync';
import browser from '@/shared/browser';
import { i18n } from '@/shared/i18n/i18n';

/**
 * Background service worker: wires lifecycle hooks and messaging (no work at
 * import time).
 */
export class Background {
    /**
     * Registers runtime message listeners synchronously
     * (MV3: listeners must attach at top level).
     * Storage is initialized eagerly in the background; handlers await
     * `PrefsSyncStorage.ready()` before prefs work.
     */
    static init(): void {
        const storageAccess = BackgroundStorageAccess.ready();
        PrefsPortHub.register();
        console.info('[TopSkip] Service worker started');
        void i18n.init();
        void PromoDetectionStore.ready();
        browser.tabs.onRemoved.addListener((tabId) => {
            void Background.handleTabRemoved(tabId);
        });
        void storageAccess
            .then(() => PrefsSyncStorage.ready())
            .then(() => ContentScriptsRegistration.syncFromPrefs())
            .catch(() => {
                console.error('[TopSkip] Background storage is unavailable.');
            });
        registerRuntimeMessages(defaultRegistry);
    }

    /**
     * Aborts before clearing so a paid BYOK request cannot restore state after
     * the tab lifecycle has ended.
     *
     * @param tabId - Removed browser tab id.
     * @returns Promise settled after its restart-safe snapshot is cleared.
     */
    private static async handleTabRemoved(tabId: number): Promise<void> {
        PromoAnalysis.abortForTab(tabId);
        await PromoDetectionStore.clear(tabId);
    }
}
