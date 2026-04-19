import * as v from 'valibot';

/**
 * Start of auto-skip window (seconds).
 */
export const SKIP_START_SEC = 30;

/**
 * End of auto-skip window (seconds).
 */
export const SKIP_END_SEC = 60;

/**
 * Single key in `browser.storage.local` for preferences (read/written only in
 * the background service worker).
 */
export const STORAGE_KEY_PREFS = 'topskip:prefs';

/**
 * `browser.storage.local` key for OpenRouter / LLM promo settings (background
 * only).
 */
export const STORAGE_KEY_OPENROUTER = 'topskip:openrouter';

/**
 * Max characters for merged caption transcript sent to OpenRouter (tail
 * truncated deterministically).
 */
export const MAX_CAPTION_TRANSCRIPT_CHARS = 120_000;

/**
 * Default provider ID for new installs.
 */
export const DEFAULT_PROVIDER_ID = 'openrouter';

/**
 * Validates persisted preference objects from storage.
 */
export const userPreferencesSchema = v.object({
  enabled: v.boolean(),
  providerId: v.string(),
});

export type UserPreferences = v.InferOutput<typeof userPreferencesSchema>;

/**
 * When `false` (default), the extension does **not** request captions or call
 * timedtext URLs — core skip behavior is unchanged.
 */
export const CAPTION_TRANSCRIPT_DEV_ENABLED = true;

/**
 * When {@link CAPTION_TRANSCRIPT_DEV_ENABLED} is `true`: if in-page
 * `ytInitialPlayerResponse` is unavailable, allow the legacy path (watch HTML
 * + InnerTube `player` POST). Default `false` — safer, fewer bot-style calls.
 */
export const CAPTION_TRANSCRIPT_ALLOW_INNERTUBE_FALLBACK = false;

/**
 * Well-known port name for long-lived preference-sync connections
 * between extension pages (popup, options) and the background service
 * worker.
 */
export const PREFS_PORT_NAME = 'topskip:prefs';
