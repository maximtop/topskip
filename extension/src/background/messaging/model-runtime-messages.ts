import { PrefsBroadcast } from '@/background/messaging/broadcast-prefs-updated';
import { PrefsPortHub } from '@/background/messaging/prefs-port-hub';
import { PromoAnalysis } from '@/background/messaging/promo-analysis';
import { fetchOpenRouterModelList } from '@/background/openrouter/openrouter-models-api';
import { testOpenAiApiKey } from '@/background/openai/openai-client';
import {
    OpenAiStorage,
    type OpenAiConfig,
} from '@/background/storage/openai-storage';
import {
    OpenRouterStorage,
    type OpenRouterConfig,
} from '@/background/storage/openrouter-storage';
import { PrefsSyncStorage } from '@/background/storage/prefs-sync';
import { PROVIDER_AVAILABILITY } from '@/shared/chrome-prompt-api';
import {
    getDetectionModels,
    resolveDetectionModel,
} from '@/shared/detection-models';
import { getErrorMessage } from '@/shared/error';
import {
    CONNECTION_STATUS,
    type ConnectionEntryMessage,
    type ConnectionProviderId,
    type DetectionModelMessage,
    type GetModelSettingsResponse,
    type SaveConnectionKeyResponse,
    type SetActiveModelResponse,
    type TestConnectionKeyResponse,
} from '@/shared/messages';
import {
    PROVIDER_ID,
    PROVIDER_LABEL,
    type ProviderId,
} from '@/shared/providers';

const ERROR_UNKNOWN_MODEL = 'Unknown model';
const ERROR_OPENROUTER_KEY_REQUIRED = 'OpenRouter API key is required.';
const ERROR_OPENROUTER_KEY_UNVERIFIED = 'Could not verify OpenRouter API key.';
const ERROR_OPENAI_KEY_REQUIRED = 'OpenAI API key is required.';

/**
 * Raw API keys indexed by providers that have connection rows.
 */
type ConnectionApiKeys = Record<ConnectionProviderId, string>;

/**
 * Storage rows needed when persisting a provider-specific selected model.
 */
type ProviderStorageSnapshot = {
    openRouterConfig: OpenRouterConfig;
    openAiConfig: OpenAiConfig;
};

/**
 * Persists the selected provider model while preserving unrelated config.
 */
type SelectedModelSaver = (
    modelName: string,
    storage: ProviderStorageSnapshot,
) => Promise<void>;

/**
 * Provider-specific key operations used by the generic connection handler.
 */
type ConnectionProviderConfig = {
    providerId: ConnectionProviderId;
    providerLabel: string;
    missingApiKeyError: string;
    loadApiKey(): Promise<string>;
    saveApiKey(apiKey: string): Promise<void>;
    maskApiKey(apiKey: string): string | null;
    testApiKey(apiKey: string): Promise<TestConnectionKeyResponse>;
};

const resolveConnectionTestKey = (
    apiKey: string | undefined,
    savedApiKey: string,
): string => {
    const draftApiKey = apiKey?.trim() ?? '';
    return draftApiKey.length > 0 ? draftApiKey : savedApiKey;
};

const testOpenRouterApiKey = async (
    apiKey: string,
): Promise<TestConnectionKeyResponse> => {
    const models = await fetchOpenRouterModelList(apiKey);
    if (models.length === 0) {
        return {
            ok: false,
            error: ERROR_OPENROUTER_KEY_UNVERIFIED,
            retryable: true,
        };
    }
    return { ok: true, valid: true };
};

const OPENROUTER_CONNECTION_CONFIG: ConnectionProviderConfig = {
    providerId: PROVIDER_ID.OpenRouter,
    providerLabel: PROVIDER_LABEL.OpenRouter,
    missingApiKeyError: ERROR_OPENROUTER_KEY_REQUIRED,
    loadApiKey: async () => {
        const current = await OpenRouterStorage.load();
        return current.apiKey;
    },
    saveApiKey: async (apiKey: string) => {
        const current = await OpenRouterStorage.load();
        await OpenRouterStorage.save({ ...current, apiKey });
    },
    maskApiKey: (apiKey: string) => OpenRouterStorage.maskApiKey(apiKey),
    testApiKey: testOpenRouterApiKey,
};

const OPENAI_CONNECTION_CONFIG: ConnectionProviderConfig = {
    providerId: PROVIDER_ID.OpenAI,
    providerLabel: PROVIDER_LABEL.OpenAI,
    missingApiKeyError: ERROR_OPENAI_KEY_REQUIRED,
    loadApiKey: async () => {
        const current = await OpenAiStorage.load();
        return current.apiKey;
    },
    saveApiKey: async (apiKey: string) => {
        const current = await OpenAiStorage.load();
        await OpenAiStorage.save({ ...current, apiKey });
    },
    maskApiKey: (apiKey: string) => OpenAiStorage.maskApiKey(apiKey),
    testApiKey: testOpenAiApiKey,
};

const CONNECTION_PROVIDER_CONFIGS: readonly ConnectionProviderConfig[] = [
    OPENROUTER_CONNECTION_CONFIG,
    OPENAI_CONNECTION_CONFIG,
];

const CONNECTION_PROVIDER_CONFIG_BY_ID: Record<
    ConnectionProviderId,
    ConnectionProviderConfig
> = {
    [PROVIDER_ID.OpenRouter]: OPENROUTER_CONNECTION_CONFIG,
    [PROVIDER_ID.OpenAI]: OPENAI_CONNECTION_CONFIG,
};

const SELECTED_MODEL_SAVER_BY_PROVIDER: Partial<
    Record<ProviderId, SelectedModelSaver>
> = {
    [PROVIDER_ID.OpenRouter]: async (modelName, storage) => {
        await OpenRouterStorage.save({
            ...storage.openRouterConfig,
            model: modelName,
        });
    },
    [PROVIDER_ID.OpenAI]: async (modelName, storage) => {
        await OpenAiStorage.save({
            ...storage.openAiConfig,
            model: modelName,
        });
    },
};

const skipSelectedModelSave: SelectedModelSaver = () => Promise.resolve();

/**
 * Handles model-first settings and connection messages.
 */
export class ModelRuntimeMessages {
    /**
     * Builds the user-facing model list with connection-derived availability.
     *
     * @param customOpenRouterModels - Saved custom OpenRouter slugs.
     * @param connectionApiKeys - Raw keys indexed by connection provider.
     * @returns Runtime-safe model messages.
     */
    private static buildModelMessages(
        customOpenRouterModels: string[],
        connectionApiKeys: ConnectionApiKeys,
    ): DetectionModelMessage[] {
        const connectionAvailability: Partial<Record<ProviderId, boolean>> = {};
        for (const connection of CONNECTION_PROVIDER_CONFIGS) {
            connectionAvailability[connection.providerId] =
                connectionApiKeys[connection.providerId].length > 0;
        }

        return getDetectionModels(customOpenRouterModels).map((model) => {
            const availability =
                connectionAvailability[model.providerId] === false
                    ? PROVIDER_AVAILABILITY.UNAVAILABLE
                    : PROVIDER_AVAILABILITY.AVAILABLE;
            return { ...model, availability };
        });
    }

    /**
     * Builds connection rows for all API-key providers supported by settings.
     *
     * @param activeProviderId - Provider used by current active model.
     * @param connectionApiKeys - Raw keys indexed by connection provider.
     * @returns Masked connection rows.
     */
    private static buildConnectionMessages(
        activeProviderId: string,
        connectionApiKeys: ConnectionApiKeys,
    ): ConnectionEntryMessage[] {
        return CONNECTION_PROVIDER_CONFIGS.map((connection) => {
            const apiKey = connectionApiKeys[connection.providerId];
            return {
                providerId: connection.providerId,
                providerLabel: connection.providerLabel,
                requiredForActiveModel:
                    activeProviderId === connection.providerId,
                apiKeyMasked: connection.maskApiKey(apiKey),
                status:
                    apiKey.length > 0
                        ? CONNECTION_STATUS.Saved
                        : CONNECTION_STATUS.Missing,
            };
        });
    }

    /**
     * Loads model catalog, active model, custom models, and connection state.
     *
     * @returns Model-first settings snapshot.
     */
    static async handleGetSettings(): Promise<GetModelSettingsResponse> {
        await PrefsSyncStorage.ready();
        try {
            const [prefs, openRouterConfig, openAiConfig] = await Promise.all([
                PrefsSyncStorage.load(),
                OpenRouterStorage.load(),
                OpenAiStorage.load(),
            ]);
            const activeModel = resolveDetectionModel(
                prefs.activeModelId,
                openRouterConfig.customModels,
            );
            const activeModelId = activeModel?.id ?? prefs.activeModelId;
            const activeProviderId =
                activeModel?.providerId ?? prefs.providerId;
            const connectionApiKeys = {
                [PROVIDER_ID.OpenRouter]: openRouterConfig.apiKey,
                [PROVIDER_ID.OpenAI]: openAiConfig.apiKey,
            };
            return {
                ok: true,
                activeModelId,
                models: ModelRuntimeMessages.buildModelMessages(
                    openRouterConfig.customModels,
                    connectionApiKeys,
                ),
                connections: ModelRuntimeMessages.buildConnectionMessages(
                    activeProviderId,
                    connectionApiKeys,
                ),
                customOpenRouterModels: openRouterConfig.customModels,
            };
        } catch (e) {
            return { ok: false, error: getErrorMessage(e) };
        }
    }

    /**
     * Persists active model and updates provider-specific selected model.
     *
     * @param modelId - Incoming active model id.
     * @returns Save result.
     */
    static async handleSetActiveModel(
        modelId: string,
    ): Promise<SetActiveModelResponse> {
        await PrefsSyncStorage.ready();
        try {
            const [prefs, openRouterConfig, openAiConfig] = await Promise.all([
                PrefsSyncStorage.load(),
                OpenRouterStorage.load(),
                OpenAiStorage.load(),
            ]);
            const model = resolveDetectionModel(
                modelId,
                openRouterConfig.customModels,
            );
            if (model === null) {
                return { ok: false, error: ERROR_UNKNOWN_MODEL };
            }

            const saveSelectedModel =
                SELECTED_MODEL_SAVER_BY_PROVIDER[model.providerId] ??
                skipSelectedModelSave;
            await saveSelectedModel(model.modelName, {
                openRouterConfig,
                openAiConfig,
            });

            const nextPrefs = {
                ...prefs,
                providerId: model.providerId,
                activeModelId: model.id,
            };
            await PrefsSyncStorage.save(nextPrefs);
            PromoAnalysis.abortForProviderChange(model.providerId);
            await PrefsBroadcast.sendUpdatedToAllTabs(nextPrefs);
            PrefsPortHub.broadcastPrefsUpdate(nextPrefs);
            return { ok: true };
        } catch (e) {
            return { ok: false, error: getErrorMessage(e) };
        }
    }

    /**
     * Saves a provider key without changing the selected model.
     *
     * @param providerId - Connection provider id.
     * @param apiKey - Raw key draft.
     * @returns Masked saved key or error.
     */
    static async handleSaveConnectionKey(
        providerId: ConnectionProviderId,
        apiKey: string,
    ): Promise<SaveConnectionKeyResponse> {
        try {
            const trimmed = apiKey.trim();
            const connection = CONNECTION_PROVIDER_CONFIG_BY_ID[providerId];
            await connection.saveApiKey(trimmed);
            return {
                ok: true,
                apiKeyMasked: connection.maskApiKey(trimmed),
            };
        } catch (e) {
            return { ok: false, error: getErrorMessage(e) };
        }
    }

    /**
     * Tests a draft key or saved key for the requested provider.
     *
     * @param providerId - Connection provider id.
     * @param apiKey - Optional draft key; saved key is used when omitted.
     * @returns Validation result.
     */
    static async handleTestConnectionKey(
        providerId: ConnectionProviderId,
        apiKey: string | undefined,
    ): Promise<TestConnectionKeyResponse> {
        try {
            const connection = CONNECTION_PROVIDER_CONFIG_BY_ID[providerId];
            const savedApiKey = await connection.loadApiKey();
            const key = resolveConnectionTestKey(apiKey, savedApiKey);
            if (key.length === 0) {
                return {
                    ok: true,
                    valid: false,
                    error: connection.missingApiKeyError,
                };
            }
            return await connection.testApiKey(key);
        } catch (e) {
            return { ok: false, error: getErrorMessage(e), retryable: true };
        }
    }
}
