import {
  registerRuntimeMessages,
} from '@/background/messaging/register-runtime-messages';
import { PrefsSyncStorage } from '@/background/storage/prefs-sync';

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
    console.info('[TopSkip] Service worker started');
    void PrefsSyncStorage.ready();
    registerRuntimeMessages();
  }
}
