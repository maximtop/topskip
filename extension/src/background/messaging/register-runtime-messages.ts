import type { Runtime } from 'webextension-polyfill/namespaces/runtime';

import browser from '@/shared/browser';

import {
    ContentLogMessages,
    PromoDetectionRuntimeMessages,
} from '@/background/messaging/misc-runtime-messages';
import { FetchTimedtextPageMessages } from '@/background/messaging/fetch-timedtext-page-messages';
import { CaptionRuntimeMessages } from '@/background/messaging/caption-runtime-messages';
import { ChromePromptApiRuntimeMessages } from '@/background/messaging/chrome-prompt-api-runtime-messages';
import { OpenRouterRuntimeMessages } from '@/background/messaging/openrouter-runtime-messages';
import { PromoAnalysis } from '@/background/messaging/promo-analysis';
import { ProviderRuntimeMessages } from '@/background/messaging/provider-runtime-messages';
import type { ProviderRegistry } from '@/background/providers/provider-registry';
import { PrefsRuntimeMessages } from '@/background/messaging/runtime-messages';
import { TOPSKIP_MESSAGE, type TopSkipRuntimeMessage } from '@/shared/messages';

/**
 * Coerces an unknown runtime message to a `TopSkipRuntimeMessage` when the
 * `type` field is a non-empty string. The caller is responsible for narrowing
 * further (via `switch`) before accessing any other fields.
 *
 * @param message - Opaque value received by `runtime.onMessage`
 * @returns Narrowed message union member, or `undefined` when the value is not
 * a valid message object
 */
function toRuntimeMessage(message: unknown): TopSkipRuntimeMessage | undefined {
    if (message === null || typeof message !== 'object') return undefined;
    const t: unknown = Reflect.get(message, 'type');
    if (typeof t !== 'string') return undefined;
    return message as TopSkipRuntimeMessage;
}

/**
 * Registers a single `runtime.onMessage` listener that dispatches each
 * incoming message to the handler responsible for its `type`.
 *
 * @param registry - Provider registry shared by provider-aware handlers
 */
export function registerRuntimeMessages(registry: ProviderRegistry): void {
    PromoAnalysis.setRegistry(registry);
    ProviderRuntimeMessages.setRegistry(registry);

    browser.runtime.onMessage.addListener(
        (message: unknown, sender: Runtime.MessageSender) => {
            const msg = toRuntimeMessage(message);
            if (!msg) return undefined;

            switch (msg.type) {
                case TOPSKIP_MESSAGE.CONTENT_LOG:
                    ContentLogMessages.log(msg.level, msg.args, sender.tab?.id);
                    return;
                case TOPSKIP_MESSAGE.FETCH_TIMEDTEXT_PAGE:
                    return FetchTimedtextPageMessages.fetch(
                        msg.url,
                        sender.tab?.id,
                    );
                case TOPSKIP_MESSAGE.CAPTIONS_FROM_CONTENT:
                    return CaptionRuntimeMessages.handle(msg.payload, sender);
                case TOPSKIP_MESSAGE.GET_PREFS:
                    return PrefsRuntimeMessages.handleGet();
                case TOPSKIP_MESSAGE.SET_PREFS:
                    return PrefsRuntimeMessages.handleSet(msg.enabled);
                case TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER:
                    return ProviderRuntimeMessages.handleGetActive();
                case TOPSKIP_MESSAGE.GET_PROVIDER_LIST:
                    return ProviderRuntimeMessages.handleGetList();
                case TOPSKIP_MESSAGE.SET_ACTIVE_PROVIDER:
                    return ProviderRuntimeMessages.handleSetActive(
                        msg.providerId,
                    );
                case TOPSKIP_MESSAGE.GET_CHROME_PROMPT_API_STATUS:
                    return ChromePromptApiRuntimeMessages.handleGetStatus();
                case TOPSKIP_MESSAGE.TRIGGER_CHROME_MODEL_DOWNLOAD:
                    return ChromePromptApiRuntimeMessages.handleTriggerDownload();
                case TOPSKIP_MESSAGE.GET_OPENROUTER_CONFIG:
                    return OpenRouterRuntimeMessages.handleGet();
                case TOPSKIP_MESSAGE.SET_OPENROUTER_CONFIG:
                    return OpenRouterRuntimeMessages.handleSet(
                        msg.apiKey,
                        msg.model,
                    );
                case TOPSKIP_MESSAGE.ADD_OPENROUTER_CUSTOM_MODEL:
                    return OpenRouterRuntimeMessages.handleAddCustomModel(
                        msg.slug,
                    );
                case TOPSKIP_MESSAGE.REMOVE_OPENROUTER_CUSTOM_MODEL:
                    return OpenRouterRuntimeMessages.handleRemoveCustomModel(
                        msg.slug,
                    );
                case TOPSKIP_MESSAGE.VALIDATE_OPENROUTER_MODEL:
                    return OpenRouterRuntimeMessages.handleValidateModelSlug(
                        msg.slug,
                        msg.apiKey,
                    );
                case TOPSKIP_MESSAGE.GET_DETECTION_STATUS:
                    return PromoDetectionRuntimeMessages.handleGet();
                case TOPSKIP_MESSAGE.DEV_SET_DETECTION_STATUS:
                    return PromoDetectionRuntimeMessages.handleDevSet(
                        msg.state,
                        sender.tab?.id,
                    );
                default:
                    return undefined;
            }
        },
    );
}
