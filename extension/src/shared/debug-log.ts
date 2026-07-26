import { DEBUG_LOG_SERVER_URL, MIME_APPLICATION_JSON } from './constants';

/**
 * Fire-and-forget POST to the local debug log server.
 *
 * @param source - Tag identifying the caller (e.g. "bg", "popup", "options")
 * @param message - Free-form log line
 */
export function debugLog(source: string, message: string): void {
    try {
        void fetch(DEBUG_LOG_SERVER_URL, {
            method: 'POST',
            headers: { 'Content-Type': MIME_APPLICATION_JSON },
            body: JSON.stringify({ source, message }),
        }).catch(() => {
            // server offline — ignore
        });
    } catch {
        // fetch may throw in restricted contexts
    }
}
