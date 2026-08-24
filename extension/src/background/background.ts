import { DebugLog } from '@/background/debug-log/debug-log';
import { DebugLogLifecycle } from '@/background/debug-log/debug-log-lifecycle';
import { DebugLogStore } from '@/background/debug-log/debug-log-store';
import { TabAttributionRegistry } from '@/background/debug-log/tab-attribution-registry';
import { ContentScriptWakeup } from '@/background/lifecycle/content-script-wakeup';
import { PrefsPortHub } from '@/background/messaging/prefs-port-hub';
import { PromoAnalysis } from '@/background/messaging/promo-analysis';
import { registerRuntimeMessages } from '@/background/messaging/register-runtime-messages';
import { PromoDetectionStore } from '@/background/promo-detection-store';
import { defaultRegistry } from '@/background/providers/default-registry';
import { BackgroundStorageAccess } from '@/background/storage/background-storage-access';
import { PrefsSyncStorage } from '@/background/storage/prefs-sync';
import browser from '@/shared/browser';
import { DEBUG_LOG_EVENT } from '@/shared/debug-log-events';
import { getExtensionBuildLabel } from '@/shared/extension-build';
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
     * `PrefsSyncStorage.ready()` before prefs work. The debug-log lifecycle
     * listeners are registered before any await so browser start and
     * install/update signals are never missed.
     */
    static init(): void {
        const storageAccess = BackgroundStorageAccess.ready();
        registerRuntimeMessages(defaultRegistry);
        PrefsPortHub.register();
        DebugLogLifecycle.register();
        console.info(
            '[TopSkip] Service worker started',
            getExtensionBuildLabel(),
        );
        void i18n.init();
        void PromoDetectionStore.ready();
        void TabAttributionRegistry.ready();
        void DebugLogStore.ready().then(() =>
            DebugLogLifecycle.markWorkerStarted(getExtensionBuildLabel()),
        );
        browser.tabs.onRemoved.addListener((tabId) => {
            void Background.handleTabRemoved(tabId);
        });
        void storageAccess
            .then(() => PrefsSyncStorage.ready())
            .catch(() => {
                console.error('[TopSkip] Background storage is unavailable.');
                DebugLog.record(DEBUG_LOG_EVENT.StorageUnavailable);
            });
        void ContentScriptWakeup.notifyExistingTabs();
    }

    /**
     * Aborts before clearing so a paid BYOK request cannot restore state after
     * the tab lifecycle has ended; logs `tab-closed` only for a tab the
     * registry knows (the facade drops incognito tabs) and releases its
     * attribution only after the marker is persisted.
     *
     * @param tabId - Removed browser tab id.
     * @returns Promise settled after its restart-safe snapshot is cleared.
     */
    private static async handleTabRemoved(tabId: number): Promise<void> {
        PromoAnalysis.abortForTab(tabId);
        await TabAttributionRegistry.ready();
        const known = TabAttributionRegistry.isIncognitoSync(tabId) !== null;
        if (known) {
            DebugLog.record(DEBUG_LOG_EVENT.TabClosed, {}, { tab: tabId });
        }
        await PromoDetectionStore.clear(tabId);
        if (!known) {
            return;
        }
        await DebugLog.drain();
        await TabAttributionRegistry.forget(tabId);
    }
}
