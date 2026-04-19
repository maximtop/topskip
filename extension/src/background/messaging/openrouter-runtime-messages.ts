import type { Runtime } from 'webextension-polyfill/namespaces/runtime';

import { fetchOpenRouterModelList } from
  '@/background/openrouter/openrouter-models-api';
import { OpenRouterStorage } from '@/background/storage/openrouter-storage';
import { getErrorMessage } from '@/shared/error';
import {
  isOpenRouterBuiltinModelSlug,
  isValidOpenRouterModelSlug,
  OPENROUTER_DEFAULT_MODEL_SLUG,
} from '@/shared/openrouter-model-presets';
import {
  TOPSKIP_MESSAGE,
  type GetOpenRouterConfigResponse,
  type MutateOpenRouterCustomModelResponse,
  type SetOpenRouterConfigResponse,
  type ValidateOpenRouterModelResponse,
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
        | ValidateOpenRouterModelResponse
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
    if (typeRaw === TOPSKIP_MESSAGE.VALIDATE_OPENROUTER_MODEL) {
      return OpenRouterRuntimeMessages.handleValidateModelSlug(message);
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
      const apiKeyRaw: unknown = Reflect.get(message, 'apiKey');
      const modelRaw: unknown = Reflect.get(message, 'model');
      if (typeof apiKeyRaw !== 'string' || typeof modelRaw !== 'string') {
        return { ok: false, error: 'Invalid apiKey or model' };
      }
      const current = await OpenRouterStorage.load();
      const apiKey = apiKeyRaw.length > 0 ? apiKeyRaw : current.apiKey;
      await OpenRouterStorage.save({
        apiKey,
        model: modelRaw,
        customModels: current.customModels,
      });

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

  /**
   * Validates a custom OpenRouter model slug at save time.
   * 1. Format check: always enforced
   * 2. API check: only if API key is present
   * 3. Graceful degradation: network/API errors return unverified (valid: true)
   *
   * @param message - VALIDATE payload with `slug` and `apiKey`
   * @returns Validation result
   */
  private static async handleValidateModelSlug(
    message: object,
  ): Promise<ValidateOpenRouterModelResponse> {
    try {
      const slugRaw: unknown = Reflect.get(message, 'slug');
      const apiKeyRaw: unknown = Reflect.get(message, 'apiKey');
      if (typeof slugRaw !== 'string' || typeof apiKeyRaw !== 'string') {
        return { ok: false, error: 'Invalid parameters' };
      }

      const slug = slugRaw.trim();
      if (!isValidOpenRouterModelSlug(slug)) {
        return {
          ok: true,
          valid: false,
          error: 'Invalid format. Use owner/model-name.',
        };
      }

      if (apiKeyRaw.length === 0) {
        return { ok: true, valid: true, unverified: true };
      }

      const models = await fetchOpenRouterModelList(apiKeyRaw);
      if (models.length === 0) {
        /* API fetch failed or returned empty; graceful: mark as unverified */
        return { ok: true, valid: true, unverified: true };
      }

      if (!models.includes(slug)) {
        return {
          ok: true,
          valid: false,
          error: 'Model not found on OpenRouter.',
        };
      }

      return { ok: true, valid: true };
    } catch (e) {
      return { ok: false, error: getErrorMessage(e) };
    }
  }
}
