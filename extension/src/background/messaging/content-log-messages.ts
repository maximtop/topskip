import type { Runtime } from 'webextension-polyfill/namespaces/runtime';
import { safeParse } from 'valibot';

import { contentLogMessageSchema } from '@/shared/messages';
import { LOG_PREFIX_CONTENT } from '@/shared/constants';

/**
 * Handles `TOPSKIP_CONTENT_LOG` messages from the content
 * script and replays them to the service worker console.
 */
export class ContentLogMessages {
    /**
     * If `message` is a valid content-log message, prints it and returns
     * `undefined` (no response needed).  Otherwise returns `undefined` so the
     * next handler in the chain can try.
     *
     * @param message - Opaque runtime message.
     * @param sender - Extension message sender metadata.
     * @returns `undefined` always (fire-and-forget).
     */
    static handle(message: unknown, sender: Runtime.MessageSender): undefined {
        const parsed = safeParse(contentLogMessageSchema, message);
        if (!parsed.success) {
            return undefined;
        }

        const { level, args } = parsed.output;
        const tabId = sender.tab?.id;
        const tag =
            tabId !== undefined
                ? `[TopSkip content t${tabId}]`
                : LOG_PREFIX_CONTENT;

        console[level](tag, ...args);

        return undefined;
    }
}
