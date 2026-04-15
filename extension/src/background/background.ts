import {
  ContentScriptsRegistration,
} from '@/background/lifecycle/content-scripts-registration';
import { PrefsPortHub } from '@/background/messaging/prefs-port-hub';
import {
  registerRuntimeMessages,
} from '@/background/messaging/register-runtime-messages';
import { OpenRouterStorage } from '@/background/storage/openrouter-storage';
import { PrefsSyncStorage } from '@/background/storage/prefs-sync';

/**
 * On startup, if the two `enabled` flags (`topskip:prefs` vs
 * `topskip:openrouter`) disagree, resolve to `true` (opt-in wins) and
 * write the unified value to both storage keys (FR-016).
 *
 * @returns Promise that settles after reconciliation (or no-op)
 */
export async function reconcileDivergentEnabled(): Promise<void> {
  await PrefsSyncStorage.ready();
  const prefs = await PrefsSyncStorage.load();
  const orConfig = await OpenRouterStorage.load();

  if (prefs.enabled === orConfig.enabled) {
    return; // already in sync
  }

  const unified = true; // opt-in wins per FR-016

  if (!prefs.enabled) {
    await PrefsSyncStorage.save({ enabled: unified });
  }
  if (!orConfig.enabled) {
    try {
      await OpenRouterStorage.save({ ...orConfig, enabled: unified });
    } catch {
      /* OpenRouter may reject if key/model empty; prefs is authoritative */
    }
  }
}

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
    void PrefsSyncStorage.ready().then(async () => {
      await reconcileDivergentEnabled();
      await ContentScriptsRegistration.syncFromPrefs();
    });
    registerRuntimeMessages();
  }
}
