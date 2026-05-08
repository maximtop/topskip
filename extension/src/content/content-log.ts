import browser from '@/shared/browser';
import { TOPSKIP_MESSAGE, type ContentLogLevel } from '@/shared/messages';

/**
 * Forwards `[TopSkip]` log lines from the content script to
 * the background service worker console via
 * `runtime.sendMessage`.  Fire-and-forget — failures are
 * silently ignored so logging never breaks skip logic.
 *
 * Usage mirrors `console.info` / `.warn` / `.error`:
 * ```ts
 * contentLog.info('blocks received', 3, 'for', videoId);
 * ```
 */
export const contentLog = {
    /**
     * Forwards an info-level log to the background.
     *
     * @param args - Values to log (same style as
     *   `console.info`).
     */
    info(...args: unknown[]): void {
        send('info', args);
    },

    /**
     * Forwards a warn-level log to the background.
     *
     * @param args - Values to log.
     */
    warn(...args: unknown[]): void {
        send('warn', args);
    },

    /**
     * Forwards an error-level log to the background.
     *
     * @param args - Values to log.
     */
    error(...args: unknown[]): void {
        send('error', args);
    },
};

/**
 * Sends a log message to the background.
 * Fire-and-forget; errors are swallowed.
 *
 * @param level - Console method name.
 * @param args - Serialisable values.
 */
function send(level: ContentLogLevel, args: unknown[]): void {
    void browser.runtime
        .sendMessage({
            type: TOPSKIP_MESSAGE.CONTENT_LOG,
            level,
            args,
        })
        .catch(() => {
            // swallow — logging must never throw
        });
}
