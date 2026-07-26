import type { Runtime } from 'webextension-polyfill/namespaces/runtime';

import { PromoDetectionStore } from '@/background/promo-detection-store';
import { defaultRegistry } from '@/background/providers/default-registry';
import type { ProviderRegistry } from '@/background/providers/provider-registry';
import { PrefsSyncStorage } from '@/background/storage/prefs-sync';
import { PROVIDER_AVAILABILITY } from '@/shared/chrome-prompt-api';
import { ANALYSIS_MODE } from '@/shared/constants';
import { getErrorMessage } from '@/shared/error';
import type {
    PreflightByokSetupPayload,
    PreflightByokSetupResponse,
} from '@/shared/messages';

/**
 * Resolves Private BYOK readiness before caption acquisition can finish.
 */
export class ByokSetupRuntimeMessages {
    /**
     * Registry shared with the provider analysis pipeline.
     */
    private static registry: ProviderRegistry = defaultRegistry;

    /**
     * Injects the production or test provider registry.
     *
     * @param registry - Provider adapters available to BYOK analysis.
     */
    static setRegistry(registry: ProviderRegistry): void {
        ByokSetupRuntimeMessages.registry = registry;
    }

    /**
     * Publishes setup-required without waiting for captions or using the server.
     *
     * @param payload - Video whose locked BYOK route is opening.
     * @param sender - Content-script sender containing the source tab id.
     * @returns Provider readiness without any fallback analysis source.
     */
    static async handle(
        payload: PreflightByokSetupPayload,
        sender: Runtime.MessageSender,
    ): Promise<PreflightByokSetupResponse> {
        const tabId = sender.tab?.id;
        if (tabId === undefined) {
            return { ok: false, error: 'Missing sender tab id.' };
        }
        if (payload.videoId.trim().length === 0) {
            return { ok: false, error: 'Missing video id.' };
        }

        try {
            await PrefsSyncStorage.ready();
            const prefs = await PrefsSyncStorage.load();
            if (!prefs.enabled || prefs.analysisMode !== ANALYSIS_MODE.Byok) {
                return { ok: true, status: 'inactive' };
            }

            const adapter = ByokSetupRuntimeMessages.registry.get(
                prefs.providerId,
            );
            if (
                adapter !== undefined &&
                (await adapter.availability()) !==
                    PROVIDER_AVAILABILITY.UNAVAILABLE
            ) {
                return { ok: true, status: 'ready' };
            }

            PromoDetectionStore.set(tabId, {
                videoId: payload.videoId,
                status: 'not_configured',
                source: 'local_provider',
            });
            return { ok: true, status: 'setup_required' };
        } catch (e) {
            return { ok: false, error: getErrorMessage(e) };
        }
    }
}
