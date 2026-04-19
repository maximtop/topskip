import {
  ContentScriptsRegistration,
} from '@/background/lifecycle/content-scripts-registration';
import { PrefsPortHub } from '@/background/messaging/prefs-port-hub';
import {
  registerRuntimeMessages,
} from '@/background/messaging/register-runtime-messages';
import { defaultRegistry } from
  '@/background/providers/default-registry';
import { PrefsSyncStorage } from '@/background/storage/prefs-sync';
import { i18n } from '@/shared/i18n/i18n';

/**
 * Background service worker: wires lifecycle hooks and messaging (no work at
 * import time).
 */
export class Background {
  private constructor() {}

  /**
   * Registers runtime message listeners synchronously
   * (MV3: listeners must attach at top level).
   * Storage is initialized eagerly in the background; handlers await
   * `PrefsSyncStorage.ready()` before prefs work.
   */
  static init(): void {
    PrefsPortHub.register();
    console.info('[TopSkip] Service worker started');
    void i18n.init();
    void PrefsSyncStorage.ready().then(async () => {
      await ContentScriptsRegistration.syncFromPrefs();
    });
    registerRuntimeMessages(defaultRegistry);
  }
}
