import type { Runtime } from 'webextension-polyfill/namespaces/runtime';

import {
  ContentScriptsRegistration,
} from '@/background/lifecycle/content-scripts-registration';
import { PrefsBroadcast } from
  '@/background/messaging/broadcast-prefs-updated';
import { OpenRouterStorage } from '@/background/storage/openrouter-storage';
import { PrefsSyncStorage } from '@/background/storage/prefs-sync';
import { getErrorMessage } from '@/shared/error';
import {
  isOpenRouterBuiltinModelSlug,
  OPENROUTER_DEFAULT_MODEL_SLUG,
} from '@/shared/openrouter-model-presets';
import {
  TOPSKIP_MESSAGE,
  type GetOpenRouterConfigResponse,
  type MutateOpenRouterCustomModelResponse,
  type SetOpenRouterConfigResponse,
} from '@/shared/messages';

/**
 * Handles OpenRouter options messaging; not instantiable.
 */
export class OpenRouterRuntimeMessages {
  private constructor() {}

  /**
   * @param message - Opaque runtime message
   * @param _sender - Extension sender (unused)
   * @returns Response promise, or `undefined` when ignored (synchronously)
   */
  static handle(
    message: unknown,
    _sender: Runtime.MessageSender,
  ):
    | Promise<
        | GetOpenRouterConfigResponse
        | SetOpenRouterConfigResponse
        | MutateOpenRouterCustomModelResponse
      >
    | undefined {
    if (!message || typeof message !== 'object') {
      return undefined;
    }
    const typeRaw: unknown = Reflect.get(message, 'type');
    if (typeRaw === TOPSKIP_MESSAGE.GET_OPENROUTER_CONFIG) {
      return OpenRouterRuntimeMessages.handleGet();
    }
    if (typeRaw === TOPSKIP_MESSAGE.SET_OPENROUTER_CONFIG) {
      return OpenRouterRuntimeMessages.handleSet(message);
    }
    if (typeRaw === TOPSKIP_MESSAGE.ADD_OPENROUTER_CUSTOM_MODEL) {
      return OpenRouterRuntimeMessages.handleAddCustomModel(message);
    }
    if (typeRaw === TOPSKIP_MESSAGE.REMOVE_OPENROUTER_CUSTOM_MODEL) {
      return OpenRouterRuntimeMessages.handleRemoveCustomModel(message);
    }
    return undefined;
  }

  /**
   * @returns Loaded config for options UI
   */
  private static async handleGet(): Promise<GetOpenRouterConfigResponse> {
    try {
      const c = await OpenRouterStorage.load();
      return {
        ok: true,
        enabled: c.enabled,
        model: c.model,
        apiKeyMasked: OpenRouterStorage.maskApiKey(c.apiKey),
        customModels: c.customModels,
      };
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
  ): Promise<SetOpenRouterConfigResponse> {
    try {
      const enabledRaw: unknown = Reflect.get(message, 'enabled');
      const apiKeyRaw: unknown = Reflect.get(message, 'apiKey');
      const modelRaw: unknown = Reflect.get(message, 'model');
      if (typeof enabledRaw !== 'boolean') {
        return { ok: false, error: 'Invalid enabled' };
      }
      if (typeof apiKeyRaw !== 'string' || typeof modelRaw !== 'string') {
        return { ok: false, error: 'Invalid apiKey or model' };
      }
      const current = await OpenRouterStorage.load();
      const apiKey = apiKeyRaw.length > 0 ? apiKeyRaw : current.apiKey;
      await OpenRouterStorage.save({
        enabled: enabledRaw,
        apiKey,
        model: modelRaw,
        customModels: current.customModels,
      });

      // FR-015: propagate enabled to prefs storage + broadcast
      try {
        await PrefsSyncStorage.ready();
        const prefs = await PrefsSyncStorage.load();
        if (prefs.enabled !== enabledRaw) {
          const newPrefs = { enabled: enabledRaw };
          await PrefsSyncStorage.save(newPrefs);
          await ContentScriptsRegistration.syncFromPrefs();
          await PrefsBroadcast.sendUpdatedToAllTabs(newPrefs);
        }
      } catch {
        /* prefs sync is best-effort; OpenRouter save already succeeded */
      }

      return { ok: true };
    } catch (e) {
      return { ok: false, error: getErrorMessage(e) };
    }
  }

  /**
   * @param message - ADD payload with `slug`
   * @returns Updated `customModels` or error
   */
  private static async handleAddCustomModel(
    message: object,
  ): Promise<MutateOpenRouterCustomModelResponse> {
    try {
      const slugRaw: unknown = Reflect.get(message, 'slug');
      if (typeof slugRaw !== 'string') {
        return { ok: false, error: 'Invalid slug' };
      }
      const slug = slugRaw.trim();
      if (slug.length === 0) {
        return { ok: false, error: 'Model id is required' };
      }
      if (isOpenRouterBuiltinModelSlug(slug)) {
        return { ok: false, error: 'That model is already a built-in preset' };
      }
      const current = await OpenRouterStorage.load();
      if (current.customModels.includes(slug)) {
        return { ok: false, error: 'That model is already in your list' };
      }
      const customModels = [...current.customModels, slug];
      await OpenRouterStorage.save({
        ...current,
        model: slug,
        customModels,
      });
      return { ok: true, customModels };
    } catch (e) {
      return { ok: false, error: getErrorMessage(e) };
    }
  }

  /**
   * @param message - REMOVE payload with `slug`
   * @returns Updated `customModels` or error
   */
  private static async handleRemoveCustomModel(
    message: object,
  ): Promise<MutateOpenRouterCustomModelResponse> {
    try {
      const slugRaw: unknown = Reflect.get(message, 'slug');
      if (typeof slugRaw !== 'string') {
        return { ok: false, error: 'Invalid slug' };
      }
      const slug = slugRaw.trim();
      if (slug.length === 0) {
        return { ok: false, error: 'Model id is required' };
      }
      const current = await OpenRouterStorage.load();
      if (!current.customModels.includes(slug)) {
        return { ok: false, error: 'That model is not in your list' };
      }
      const customModels = current.customModels.filter((s) => s !== slug);
      let model = current.model;
      if (model === slug) {
        model = OPENROUTER_DEFAULT_MODEL_SLUG;
      }
      await OpenRouterStorage.save({
        ...current,
        model,
        customModels,
      });
      return { ok: true, customModels };
    } catch (e) {
      return { ok: false, error: getErrorMessage(e) };
    }
  }
}
