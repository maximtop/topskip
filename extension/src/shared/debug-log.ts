const LOG_URL = 'http://127.0.0.1:9222/log';

/**
 * Fire-and-forget POST to the local debug log server.
 *
 * @param source - Tag identifying the caller (e.g. "bg", "popup", "options")
 * @param message - Free-form log line
 */
export function debugLog(source: string, message: string): void {
  try {
    void fetch(LOG_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, message }),
    }).catch(() => {/* server offline — ignore */});
  } catch {
    /* fetch may throw in restricted contexts */
  }
}
