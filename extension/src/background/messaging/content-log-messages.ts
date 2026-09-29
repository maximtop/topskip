/**
 * @file Relays `TOPSKIP_CONTENT_LOG` messages from the content script to the
 * service worker console.
 */

import { LOG_PREFIX_CONTENT } from '@/shared/constants';
import { type ContentLogLevel } from '@/shared/messages';

/**
 * Handles `TOPSKIP_CONTENT_LOG` messages from the content
 * script and replays them to the service worker console.
 */
export class ContentLogMessages {
    /**
     * Prints a content-script log line in the service-worker console,
     * prefixed with the originating tab id when available.
     *
     * @param level - Content log level; `info` lines go to `console.debug`.
     * @param args - Arguments to forward verbatim to the console method.
     * @param tabId - Tab id from the sender, or `undefined` when not present.
     */
    static log(
        level: ContentLogLevel,
        args: unknown[],
        tabId: number | undefined,
    ): void {
        const tag = tabId !== undefined
            ? `[TopSkip content t${tabId}]`
            : LOG_PREFIX_CONTENT;

        switch (level) {
            case 'warn':
                console.warn(tag, ...args);
                break;
            case 'error':
                console.error(tag, ...args);
                break;
            default:
                console.debug(tag, ...args);
        }
    }
}
