import * as v from 'valibot';

import browser from '@/shared/browser';
import { STORAGE_KEY_OPENAI } from '@/shared/constants';

/**
 * Persisted OpenAI connection settings; background-owned because it contains
 * provider credentials.
 */
export type OpenAiConfig = {
    apiKey: string;
    model: string;
};

const openAiConfigSchema = v.object({
    apiKey: v.string(),
    model: v.string(),
});

/**
 * Namespace for OpenAI config storage.
 */
export class OpenAiStorage {
    /**
     * Defaults used when storage is missing or corrupt.
     */
    private static readonly defaultConfig: OpenAiConfig = {
        apiKey: '',
        model: '',
    };

    /**
     * Parses untrusted storage values into the OpenAI config shape.
     *
     * @param raw - Untrusted value from `browser.storage.local`.
     * @returns Validated OpenAI config.
     */
    private static parseStored(raw: unknown): OpenAiConfig {
        return v.parse(openAiConfigSchema, raw);
    }

    /**
     * Reads OpenAI config from extension-local storage.
     *
     * @returns Current config or defaults after repair.
     */
    static async load(): Promise<OpenAiConfig> {
        const result = await browser.storage.local.get(STORAGE_KEY_OPENAI);
        const raw = result[STORAGE_KEY_OPENAI];
        if (raw === undefined) {
            return { ...OpenAiStorage.defaultConfig };
        }
        try {
            return OpenAiStorage.parseStored(raw);
        } catch {
            await browser.storage.local.set({
                [STORAGE_KEY_OPENAI]: { ...OpenAiStorage.defaultConfig },
            });
            return { ...OpenAiStorage.defaultConfig };
        }
    }

    /**
     * Persists OpenAI config after validating the storage boundary.
     *
     * @param config - Config to store.
     * @returns Promise that resolves after write.
     */
    static async save(config: OpenAiConfig): Promise<void> {
        const validated = v.parse(openAiConfigSchema, config);
        await browser.storage.local.set({ [STORAGE_KEY_OPENAI]: validated });
    }

    /**
     * Masks API keys for display while preserving enough suffix for recognition.
     *
     * @param apiKey - Raw API key.
     * @returns Masked key or `null` when empty.
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
}
