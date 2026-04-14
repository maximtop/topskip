import type { Runtime } from 'webextension-polyfill/namespaces/runtime';

import browser from '@/shared/browser';

import {
  FetchTimedtextPageMessages,
} from '@/background/messaging/fetch-timedtext-page-messages';
import {
  CaptionRuntimeMessages,
} from '@/background/messaging/caption-runtime-messages';
import { PrefsRuntimeMessages } from '@/background/messaging/runtime-messages';

/**
 * Registers a single `runtime.onMessage` listener: timedtext fetch, captions,
 * then preferences.
 */
export function registerRuntimeMessages(): void {
  browser.runtime.onMessage.addListener(
    (message: unknown, sender: Runtime.MessageSender) => {
      const timedtextAck = FetchTimedtextPageMessages.handle(message, sender);
      if (timedtextAck !== undefined) {
        return timedtextAck;
      }
      const fromContent = CaptionRuntimeMessages.handleCaptionsFromContent(
        message,
      );
      if (fromContent !== undefined) {
        return fromContent;
      }
      return PrefsRuntimeMessages.handle(message, sender);
    },
  );
}
