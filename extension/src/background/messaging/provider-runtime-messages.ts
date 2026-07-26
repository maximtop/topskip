import { PrefsBroadcast } from '@/background/messaging/broadcast-prefs-updated';
import { PrefsPortHub } from '@/background/messaging/prefs-port-hub';
import { PromoAnalysis } from '@/background/messaging/promo-analysis';
import { defaultRegistry } from '@/background/providers/default-registry';
import { PROVIDER_ID } from '@/background/providers/llm-provider-adapter';
import type { ProviderRegistry } from '@/background/providers/provider-registry';
import { OpenRouterStorage } from '@/background/storage/openrouter-storage';
import { PrefsSyncStorage } from '@/background/storage/prefs-sync';
import { CHROME_PROMPT_API_MODEL_NAME } from '@/shared/chrome-prompt-api';
import { getErrorMessage } from '@/shared/error';
import {
    type GetActiveProviderResponse,
    type GetProviderListResponse,
    type SetActiveProviderResponse,
} from '@/shared/messages';

/**
 * Handles runtime provider-selection messages; not instantiable.
 */
export class ProviderRuntimeMessages {
    /**
     * Adapters backing GET/SET provider runtime messages.
     */
    private static registry: ProviderRegistry = defaultRegistry;

    /**
     * Replaces the registry backing provider list and selection handlers.
     *
     * @param registry - Provider registry used by message handlers
     */
    static setRegistry(registry: ProviderRegistry): void {
        ProviderRuntimeMessages.registry = registry;
    }

    /**
     * Builds the active provider row including optional model label.
     *
     * @returns Current provider selection and display name
     */
    static async handleGetActive(): Promise<GetActiveProviderResponse> {
        await PrefsSyncStorage.ready();
        try {
            const prefs = await PrefsSyncStorage.load();
            const adapter = ProviderRuntimeMessages.registry.get(
                prefs.providerId,
            );

            let modelName = '';
            if (prefs.providerId === PROVIDER_ID.OpenRouter) {
                const orConfig = await OpenRouterStorage.load();
                modelName = orConfig.model;
            } else if (prefs.providerId === PROVIDER_ID.ChromePromptApi) {
                modelName = CHROME_PROMPT_API_MODEL_NAME;
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
     * Enumerates adapters with an availability probe per entry.
     *
     * @returns All registered providers with live availability
     */
    static async handleGetList(): Promise<GetProviderListResponse> {
        try {
            const providers = await Promise.all(
                ProviderRuntimeMessages.registry
                    .getAll()
                    .map(async (adapter) => ({
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
     * Validates and persists the user’s chosen LLM provider id.
     *
     * @param providerId - Non-empty provider id string from the SET payload.
     * @returns Save result
     */
    static async handleSetActive(
        providerId: string,
    ): Promise<SetActiveProviderResponse> {
        await PrefsSyncStorage.ready();
        try {
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
