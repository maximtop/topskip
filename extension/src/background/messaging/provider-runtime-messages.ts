import type { Runtime } from 'webextension-polyfill/namespaces/runtime';

import { PrefsBroadcast } from
  '@/background/messaging/broadcast-prefs-updated';
import { PrefsPortHub } from '@/background/messaging/prefs-port-hub';
import { PromoAnalysis } from '@/background/messaging/promo-analysis';
import { defaultRegistry } from
  '@/background/providers/default-registry';
import {
  PROVIDER_ID,
} from '@/background/providers/llm-provider-adapter';
import type { ProviderRegistry } from
  '@/background/providers/provider-registry';
import { OpenRouterStorage } from '@/background/storage/openrouter-storage';
import { PrefsSyncStorage } from '@/background/storage/prefs-sync';
import { getErrorMessage } from '@/shared/error';
import {
  TOPSKIP_MESSAGE,
  type GetActiveProviderResponse,
  type GetProviderListResponse,
  type SetActiveProviderResponse,
} from '@/shared/messages';

/**
 * Handles runtime provider-selection messages; not instantiable.
 */
export class ProviderRuntimeMessages {
  private constructor() {}

  private static registry: ProviderRegistry = defaultRegistry;

  /**
   * @param registry - Provider registry used by message handlers
   */
  static setRegistry(registry: ProviderRegistry): void {
    ProviderRuntimeMessages.registry = registry;
  }

  /**
   * @param message - Opaque runtime message
   * @param _sender - Extension sender (unused)
   * @returns Provider response promise, or `undefined` when ignored
   */
  static handle(
    message: unknown,
    _sender: Runtime.MessageSender,
  ):
    | Promise<GetActiveProviderResponse>
    | Promise<GetProviderListResponse>
    | Promise<SetActiveProviderResponse>
    | undefined {
    if (!message || typeof message !== 'object') {
      return undefined;
    }
    const typeRaw: unknown = Reflect.get(message, 'type');
    if (typeof typeRaw !== 'string') {
      return undefined;
    }

    if (typeRaw === TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER) {
      return ProviderRuntimeMessages.handleGetActive();
    }
    if (typeRaw === TOPSKIP_MESSAGE.GET_PROVIDER_LIST) {
      return ProviderRuntimeMessages.handleGetList();
    }
    if (typeRaw === TOPSKIP_MESSAGE.SET_ACTIVE_PROVIDER) {
      return ProviderRuntimeMessages.handleSetActive(message);
    }
    return undefined;
  }

  /**
   * @returns Current provider selection and display name
   */
  private static async handleGetActive(): Promise<GetActiveProviderResponse> {
    await PrefsSyncStorage.ready();
    try {
      const prefs = await PrefsSyncStorage.load();
      const adapter = ProviderRuntimeMessages.registry.get(prefs.providerId);

      let modelName = '';
      if (prefs.providerId === PROVIDER_ID.OpenRouter) {
        const orConfig = await OpenRouterStorage.load();
        modelName = orConfig.model;
      } else if (prefs.providerId === PROVIDER_ID.ChromePromptApi) {
        modelName = 'Gemini Nano';
      }

      return {
        ok: true,
        providerId: prefs.providerId,
        displayName: adapter?.displayName ?? prefs.providerId,
        modelName,
      };
    } catch (e) {
      return { ok: false, error: getErrorMessage(e) };
    }
  }

  /**
   * @returns All registered providers with live availability
   */
  private static async handleGetList(): Promise<GetProviderListResponse> {
    try {
      const providers = await Promise.all(
        ProviderRuntimeMessages.registry.getAll().map(async (adapter) => ({
          id: adapter.id,
          displayName: adapter.displayName,
          availability: await adapter.availability(),
        })),
      );
      return { ok: true, providers };
    } catch (e) {
      return { ok: false, error: getErrorMessage(e) };
    }
  }

  /**
   * @param message - Candidate SET_ACTIVE_PROVIDER message
   * @returns Save result
   */
  private static async handleSetActive(
    message: object,
  ): Promise<SetActiveProviderResponse> {
    await PrefsSyncStorage.ready();
    try {
      const providerIdRaw: unknown = Reflect.get(message, 'providerId');
      if (typeof providerIdRaw !== 'string' || providerIdRaw.length === 0) {
        return { ok: false, error: 'Invalid providerId' };
      }
      const providerId = providerIdRaw;
      const adapter = ProviderRuntimeMessages.registry.get(providerId);
      if (!adapter) {
        return { ok: false, error: `Unknown provider: ${providerId}` };
      }

      const current = await PrefsSyncStorage.load();
      if (current.providerId === providerId) {
        return { ok: true };
      }

      const next = { ...current, providerId };
      await PrefsSyncStorage.save(next);
      PromoAnalysis.abortForProviderChange(providerId);
      await PrefsBroadcast.sendUpdatedToAllTabs(next);
      PrefsPortHub.broadcastPrefsUpdate(next);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: getErrorMessage(e) };
    }
  }
}