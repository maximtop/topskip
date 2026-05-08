import { fetchOpenRouterModelList } from '@/background/openrouter/openrouter-models-api';
import { OpenRouterStorage } from '@/background/storage/openrouter-storage';
import { getErrorMessage } from '@/shared/error';
import {
    isOpenRouterBuiltinModelSlug,
    isValidOpenRouterModelSlug,
    OPENROUTER_DEFAULT_MODEL_SLUG,
} from '@/shared/openrouter-model-presets';
import {
    type GetOpenRouterConfigResponse,
    type MutateOpenRouterCustomModelResponse,
    type SetOpenRouterConfigResponse,
    type ValidateOpenRouterModelResponse,
} from '@/shared/messages';

/**
 * Handles OpenRouter options messaging; not instantiable.
 */
export class OpenRouterRuntimeMessages {
    /**
     * Reads OpenRouter config from storage.
     *
     * @returns Current config
     */
    static async handleGet(): Promise<GetOpenRouterConfigResponse> {
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
     * Persists api key + model from the options SET message.
     *
     * @param apiKey - Raw API key from the SET payload.
     * @param model - Model slug from the SET payload.
     * @returns Save result
     */
    static async handleSet(
        apiKey: string,
        model: string,
    ): Promise<SetOpenRouterConfigResponse> {
        try {
            const current = await OpenRouterStorage.load();
            const resolvedApiKey = apiKey.length > 0 ? apiKey : current.apiKey;
            await OpenRouterStorage.save({
                apiKey: resolvedApiKey,
                model,
                customModels: current.customModels,
            });

            return { ok: true };
        } catch (e) {
            return { ok: false, error: getErrorMessage(e) };
        }
    }

    /**
     * Appends a user custom model slug and optionally switches active model.
     *
     * @param slug - Raw slug string from the ADD payload.
     * @returns Updated `customModels` or error
     */
    static async handleAddCustomModel(
        slug: string,
    ): Promise<MutateOpenRouterCustomModelResponse> {
        try {
            const trimmed = slug.trim();
            if (trimmed.length === 0) {
                return { ok: false, error: 'Model id is required' };
            }
            if (isOpenRouterBuiltinModelSlug(trimmed)) {
                return {
                    ok: false,
                    error: 'That model is already a built-in preset',
                };
            }
            const current = await OpenRouterStorage.load();
            if (current.customModels.includes(trimmed)) {
                return {
                    ok: false,
                    error: 'That model is already in your list',
                };
            }
            const customModels = [...current.customModels, trimmed];
            await OpenRouterStorage.save({
                ...current,
                model: trimmed,
                customModels,
            });
            return { ok: true, customModels };
        } catch (e) {
            return { ok: false, error: getErrorMessage(e) };
        }
    }

    /**
     * Removes a user custom model slug and rewires default model when needed.
     *
     * @param slug - Raw slug string from the REMOVE payload.
     * @returns Updated `customModels` or error
     */
    static async handleRemoveCustomModel(
        slug: string,
    ): Promise<MutateOpenRouterCustomModelResponse> {
        try {
            const trimmed = slug.trim();
            if (trimmed.length === 0) {
                return { ok: false, error: 'Model id is required' };
            }
            const current = await OpenRouterStorage.load();
            if (!current.customModels.includes(trimmed)) {
                return { ok: false, error: 'That model is not in your list' };
            }
            const customModels = current.customModels.filter(
                (s) => s !== trimmed,
            );
            let model = current.model;
            if (model === trimmed) {
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
     * @param slug - Model slug from the VALIDATE payload.
     * @param apiKey - API key from the VALIDATE payload.
     * @returns Validation result
     */
    static async handleValidateModelSlug(
        slug: string,
        apiKey: string,
    ): Promise<ValidateOpenRouterModelResponse> {
        try {
            const trimmed = slug.trim();
            if (!isValidOpenRouterModelSlug(trimmed)) {
                return {
                    ok: true,
                    valid: false,
                    error: 'Invalid format. Use owner/model-name.',
                };
            }

            if (apiKey.length === 0) {
                return { ok: true, valid: true, unverified: true };
            }

            const models = await fetchOpenRouterModelList(apiKey);
            if (models.length === 0) {
                // API fetch failed or returned empty; graceful: mark as unverified
                return { ok: true, valid: true, unverified: true };
            }

            if (!models.includes(trimmed)) {
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
