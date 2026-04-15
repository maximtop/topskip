import * as v from 'valibot';

import type { Runtime } from 'webextension-polyfill/namespaces/runtime';
import { userPreferencesSchema } from '@/shared/constants';
import { getErrorMessage } from '@/shared/error';
import {
  TOPSKIP_MESSAGE,
  type GetPrefsResponse,
  type SetPrefsResponse,
} from '@/shared/messages';

import {
  ContentScriptsRegistration,
} from '@/background/lifecycle/content-scripts-registration';
import { PrefsBroadcast } from '@/background/messaging/broadcast-prefs-updated';
import { OpenRouterStorage } from '@/background/storage/openrouter-storage';
import { PrefsSyncStorage } from '@/background/storage/prefs-sync';

/**
 * Namespace for `runtime.onMessage` prefs handling; not instantiable.
 */
export class PrefsRuntimeMessages {
  private constructor() {}

  /**
   * Handles `runtime` messages from the popup or content scripts (preferences
   * read/write). Uses the Promise return form so the channel stays open until
   * the async work finishes.
   *
   * @param message Opaque message from `runtime.sendMessage`.
   * @param _sender Extension message sender (required by the API; unused here).
   * @returns Response payload for known types, or `undefined` when the message
   * is ignored (synchronously).
   */
  static handle(
    message: unknown,
    _sender: Runtime.MessageSender,
  ): Promise<GetPrefsResponse | SetPrefsResponse> | undefined {
    if (!message || typeof message !== 'object') {
      return undefined;
    }

    const typeRaw: unknown = Reflect.get(message, 'type');
    if (typeof typeRaw !== 'string') {
      return undefined;
    }
    const type = typeRaw;

    if (type === TOPSKIP_MESSAGE.GET_PREFS) {
      return PrefsRuntimeMessages.handleGet();
    }

    if (type === TOPSKIP_MESSAGE.SET_PREFS) {
      return PrefsRuntimeMessages.handleSet(message);
    }

    return undefined;
  }

  /**
   * @returns Current preferences
   */
  private static async handleGet(): Promise<GetPrefsResponse> {
    await PrefsSyncStorage.ready();
    try {
      const prefs = await PrefsSyncStorage.load();
      return { ok: true, prefs };
    } catch (e) {
      return { ok: false, error: getErrorMessage(e) };
    }
  }

  /**
   * @param message - SET payload
   * @returns Save result
   */
  private static async handleSet(
    message: object,
  ): Promise<SetPrefsResponse> {
    await PrefsSyncStorage.ready();
    try {
      const enabledRaw: unknown = Reflect.get(message, 'enabled');
      const prefs = v.parse(userPreferencesSchema, {
        enabled: enabledRaw,
      });
      await PrefsSyncStorage.save(prefs);

      // FR-014: propagate enabled to OpenRouter storage
      try {
        const orConfig = await OpenRouterStorage.load();
        if (orConfig.enabled !== prefs.enabled) {
          await OpenRouterStorage.save({
            ...orConfig,
            enabled: prefs.enabled,
          });
        }
      } catch {
        /* OpenRouter storage may reject if key/model empty + enabled=true;
           that is fine — the prefs save already succeeded. */
      }

      await ContentScriptsRegistration.syncFromPrefs();
      await PrefsBroadcast.sendUpdatedToAllTabs(prefs);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: getErrorMessage(e) };
    }
  }
}
