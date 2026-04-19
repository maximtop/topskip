import type { Runtime } from 'webextension-polyfill/namespaces/runtime';

import browser from '@/shared/browser';

import {
  ContentLogMessages,
} from '@/background/messaging/content-log-messages';
import {
  FetchTimedtextPageMessages,
} from '@/background/messaging/fetch-timedtext-page-messages';
import {
  CaptionRuntimeMessages,
} from '@/background/messaging/caption-runtime-messages';
import {
  ChromePromptApiRuntimeMessages,
} from '@/background/messaging/chrome-prompt-api-runtime-messages';
import {
  OpenRouterRuntimeMessages,
} from '@/background/messaging/openrouter-runtime-messages';
import {
  PromoDetectionRuntimeMessages,
} from '@/background/messaging/promo-detection-runtime-messages';
import { PromoAnalysis } from '@/background/messaging/promo-analysis';
import { ProviderRuntimeMessages } from
  '@/background/messaging/provider-runtime-messages';
import type { ProviderRegistry } from
  '@/background/providers/provider-registry';
import { PrefsRuntimeMessages } from '@/background/messaging/runtime-messages';

/**
 * Registers a single `runtime.onMessage` listener: content
 * log, timedtext fetch, captions, then preferences.
 *
 * @param registry - Provider registry shared by provider-aware handlers
 */
export function registerRuntimeMessages(registry: ProviderRegistry): void {
  PromoAnalysis.setRegistry(registry);
  ProviderRuntimeMessages.setRegistry(registry);

  browser.runtime.onMessage.addListener(
    (message: unknown, sender: Runtime.MessageSender) => {
      ContentLogMessages.handle(message, sender);
      const timedtextAck = FetchTimedtextPageMessages.handle(message, sender);
      if (timedtextAck !== undefined) {
        return timedtextAck;
      }
      const fromContent = CaptionRuntimeMessages.handleCaptionsFromContent(
        message,
        sender,
      );
      if (fromContent !== undefined) {
        return fromContent;
      }
      const provider = ProviderRuntimeMessages.handle(message, sender);
      if (provider !== undefined) {
        return provider;
      }
      const chromeApi = ChromePromptApiRuntimeMessages.handle(message, sender);
      if (chromeApi !== undefined) {
        return chromeApi;
      }
      const openRouter = OpenRouterRuntimeMessages.handle(message, sender);
      if (openRouter !== undefined) {
        return openRouter;
      }
      const detection = PromoDetectionRuntimeMessages.handle(message, sender);
      if (detection !== undefined) {
        return detection;
      }
      return PrefsRuntimeMessages.handle(message, sender);
    },
  );
}
