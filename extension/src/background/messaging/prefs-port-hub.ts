import type { Runtime } from 'webextension-polyfill/namespaces/runtime';

import browser from '@/shared/browser';
import { PREFS_PORT_NAME, type UserPreferences } from '@/shared/constants';
import { TOPSKIP_MESSAGE } from '@/shared/messages';

/**
 * Manages long-lived port connections from extension pages (popup, options)
 * for real-time preference synchronisation. Not instantiable.
 */
export class PrefsPortHub {
  private constructor() {}

  /**
   * Connected ports.
   */
  private static ports = new Set<Runtime.Port>();

  /**
   * Registers the `runtime.onConnect` listener. Must be called
   * **synchronously** during service-worker startup (MV3 requirement).
   */
  static register(): void {
    browser.runtime.onConnect.addListener((port: Runtime.Port) => {
      if (port.name !== PREFS_PORT_NAME) {
        return;
      }
      PrefsPortHub.ports.add(port);
      port.onDisconnect.addListener(() => {
        PrefsPortHub.ports.delete(port);
      });
    });
  }

  /**
   * Posts a `PREFS_UPDATED` message to every connected extension-page port.
   *
   * @param prefs Current preferences to broadcast.
   */
  static broadcastPrefsUpdate(prefs: UserPreferences): void {
    const msg = {
      type: TOPSKIP_MESSAGE.PREFS_UPDATED,
      prefs,
    };
    for (const port of PrefsPortHub.ports) {
      try {
        port.postMessage(msg);
      } catch {
        /* Port may have disconnected between iteration start and postMessage;
           onDisconnect will clean it up. */
      }
    }
  }

  /**
   * Returns the number of currently connected ports (testing/diagnostics).
   *
   * @returns Port count.
   */
  static connectedCount(): number {
    return PrefsPortHub.ports.size;
  }

  /**
   * Disconnects and removes all ports (used by tests for isolation).
   */
  static disconnectAll(): void {
    PrefsPortHub.ports.clear();
  }
}
