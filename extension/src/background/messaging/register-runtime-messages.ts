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
  OpenRouterRuntimeMessages,
} from '@/background/messaging/openrouter-runtime-messages';
import {
  PromoDetectionRuntimeMessages,
} from '@/background/messaging/promo-detection-runtime-messages';
import { PrefsRuntimeMessages } from '@/background/messaging/runtime-messages';

/**
 * Registers a single `runtime.onMessage` listener: content
 * log, timedtext fetch, captions, then preferences.
 */
export function registerRuntimeMessages(): void {
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
