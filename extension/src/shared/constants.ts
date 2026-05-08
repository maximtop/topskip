import * as v from 'valibot';

import { PROVIDER_ID } from '@/shared/providers';

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
export const DEFAULT_PROVIDER_ID = PROVIDER_ID.OpenRouter;

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

// ───────────────────────────────────────────── YouTube URLs ──────────────

/**
 * Canonical YouTube origin (no trailing slash).
 * Derived patterns (e.g. match patterns) should build from this value to keep
 * it single-source-of-truth.
 */
export const YOUTUBE_BASE_URL = 'https://www.youtube.com';

/**
 * Prefix for YouTube timedtext caption API responses.
 * Content-script `fetch` to this endpoint can return HTTP 200 with empty
 * bodies; the page-world fetch is the reliable path.
 */
export const YOUTUBE_TIMEDTEXT_URL = `${YOUTUBE_BASE_URL}/api/timedtext`;

/**
 * Path segment for standard YouTube watch pages (not Shorts).
 */
export const YOUTUBE_WATCH_URL_PATH = '/watch';

// ─────────────────────────────────────────── Unit conversions ─────────────

/**
 * Milliseconds per second — avoids inline `1000` whenever converting between
 * playback time (seconds) and JavaScript timers (ms).
 */
export const MS_PER_SECOND = 1000;

/**
 * Seconds per minute.
 */
export const SECONDS_PER_MINUTE = 60;

/**
 * Seconds per hour.
 */
export const SECONDS_PER_HOUR = 3600;

/**
 * Scale factor to convert a 0–1 fraction into a percentage.
 */
export const PERCENT_SCALE = 100;

// ──────────────────────────────────────────── Logging ─────────────────────

/**
 * Log-prefix tag prepended to console messages in the runtime.
 */
export const LOG_PREFIX_TOPSKIP = '[TopSkip]';

/**
 * Log-prefix used by caption-fetch paths in both the content and background
 * bundles — cross-bundle, so kept here in shared.
 */
export const LOG_PREFIX_CAPTIONS = '[TopSkip captions]';

/**
 * Log-prefix used by content-script relay handlers in the background.
 */
export const LOG_PREFIX_CONTENT = '[TopSkip content]';

// ──────────────────────────────────────────── HTTP ────────────────────────

/**
 * MIME type for JSON request/response bodies, used in `Content-Type` and
 * `Accept` headers across all extension bundles.
 */
export const MIME_APPLICATION_JSON = 'application/json';

// ──────────────────────────────────────────── YouTube ─────────────────────

/**
 * Query parameter name for the YouTube watch video ID.
 */
export const YOUTUBE_WATCH_VIDEO_ID_PARAM = 'v';

// ──────────────────────────────────────── Debug / Dev ─────────────────────

/**
 * Local debug-log server endpoint. Only consumed by `shared/debug-log.ts`.
 * Not active in production (server typically unreachable).
 */
export const DEBUG_LOG_SERVER_URL = 'http://127.0.0.1:9222/log';
