import * as v from 'valibot';

import browser from '@/shared/browser';
import { STORAGE_KEY_OPENROUTER } from '@/shared/constants';
import {
  isOpenRouterBuiltinModelSlug,
} from '@/shared/openrouter-model-presets';

import { PrefsSyncStorage } from '@/background/storage/prefs-sync';

/**
 * Persisted OpenRouter / LLM settings (`browser.storage.local`, background
 * only).
 */
export type OpenRouterConfig = {
  enabled: boolean;
  apiKey: string;
  model: string;
  /**
   * User-added model slugs (not built-in presets); deduped, order preserved.
   */
  customModels: string[];
};

const openRouterConfigSchema = v.object({
  enabled: v.boolean(),
  apiKey: v.string(),
  model: v.string(),
  customModels: v.fallback(v.array(v.string()), []),
});

/**
 * Namespace for OpenRouter config storage; not instantiable.
 */
export class OpenRouterStorage {
  private constructor() {}

  private static readonly defaultConfig: OpenRouterConfig = {
    enabled: false,
    apiKey: '',
    model: '',
    customModels: [],
  };

  /**
   * @param raw - Untrusted value from `browser.storage.local`
   * @returns Validated config
   */
  private static parseStored(raw: unknown): OpenRouterConfig {
    return v.parse(openRouterConfigSchema, raw);
  }

  /**
   * Ensures the active custom-only `model` slug appears in `customModels` for
   * older stored rows; persists when the list changes.
   *
   * @param c - Parsed config
   * @returns Normalized config (possibly persisted)
   */
  private static async migrateCustomModelsFromModel(
    c: OpenRouterConfig,
  ): Promise<OpenRouterConfig> {
    const modelTrimmed = c.model.trim();
    if (
      modelTrimmed.length === 0 ||
      isOpenRouterBuiltinModelSlug(modelTrimmed) ||
      c.customModels.includes(modelTrimmed)
    ) {
      return c;
    }
    const next: OpenRouterConfig = {
      ...c,
      customModels: [...c.customModels, modelTrimmed],
    };
    await browser.storage.local.set({ [STORAGE_KEY_OPENROUTER]: next });
    return next;
  }

  /**
   * @returns Current OpenRouter config
   */
  static async load(): Promise<OpenRouterConfig> {
    const result = await browser.storage.local.get(STORAGE_KEY_OPENROUTER);
    const raw = result[STORAGE_KEY_OPENROUTER];
    if (raw === undefined) {
      return { ...OpenRouterStorage.defaultConfig };
    }
    try {
      const parsed = OpenRouterStorage.parseStored(raw);
      return await OpenRouterStorage.migrateCustomModelsFromModel(parsed);
    } catch {
      await browser.storage.local.set({
        [STORAGE_KEY_OPENROUTER]: { ...OpenRouterStorage.defaultConfig },
      });
      return { ...OpenRouterStorage.defaultConfig };
    }
  }

  /**
   * Persists config after validation. When `enabled` is true, `apiKey` and
   * `model` MUST be non-empty (FR-006).
   *
   * @param config - Config to save
   * @returns Promise that resolves when storage write completes
   */
  static async save(config: OpenRouterConfig): Promise<void> {
    const c = v.parse(openRouterConfigSchema, config);
    if (c.enabled && (c.apiKey.length === 0 || c.model.length === 0)) {
      throw new Error(
        [
          'OpenRouter API key and model are required when',
          'LLM detection is enabled',
        ].join(' '),
      );
    }
    await browser.storage.local.set({ [STORAGE_KEY_OPENROUTER]: c });
  }

  /**
   * @param apiKey - Raw API key from storage
   * @returns Masked key for UI (`****last4`) or `null` if empty
   */
  static maskApiKey(apiKey: string): string | null {
    if (apiKey.length === 0) {
      return null;
    }
    if (apiKey.length <= 4) {
      return '****';
    }
    return `****${apiKey.slice(-4)}`;
  }

  /**
   * @returns Whether LLM analysis may run (main prefs on + OpenRouter on +
   * key)
   */
  static async canRunPromoAnalysis(): Promise<boolean> {
    await PrefsSyncStorage.ready();
    const prefs = await PrefsSyncStorage.load();
    if (!prefs.enabled) {
      return false;
    }
    const or = await OpenRouterStorage.load();
    return or.enabled && or.apiKey.length > 0 && or.model.length > 0;
  }
}
