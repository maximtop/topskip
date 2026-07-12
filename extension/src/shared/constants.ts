import * as v from 'valibot';

import { DEFAULT_DETECTION_MODEL_ID } from '@/shared/detection-models';
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
 * `browser.storage.local` key for OpenAI connection settings.
 */
export const STORAGE_KEY_OPENAI = 'topskip:openai';

/**
 * Prefix for background-owned local copies of ready server results.
 */
export const STORAGE_KEY_SERVER_RESULT_CACHE = 'topskip:server-result-cache';

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
 * Supported routes for promo detection.
 */
export const ANALYSIS_MODE = {
    Server: 'server',
    Byok: 'byok',
} as const;

/**
 * User-selected route for promo detection.
 */
export type AnalysisMode = (typeof ANALYSIS_MODE)[keyof typeof ANALYSIS_MODE];

/**
 * Validates the user-selected promo detection route.
 */
export const analysisModeSchema = v.picklist([
    ANALYSIS_MODE.Server,
    ANALYSIS_MODE.Byok,
] as const);

/**
 * Validates persisted preference objects from storage.
 */
export const userPreferencesSchema = v.object({
    enabled: v.boolean(),
    providerId: v.string(),
    activeModelId: v.fallback(v.string(), DEFAULT_DETECTION_MODEL_ID),
    analysisMode: v.fallback(analysisModeSchema, ANALYSIS_MODE.Server),
});

/**
 * Validated user preference shape persisted in extension storage.
 */
export type UserPreferences = v.InferOutput<typeof userPreferencesSchema>;

/**
 * Enables the production player-mediated caption capture path used before
 * promo analysis on supported watch pages.
 */
export const CAPTION_TRANSCRIPT_DEV_ENABLED = true;

/**
 * Emits safe stage-by-stage caption capture diagnostics for headed manual
 * YouTube smoke tests.
 */
export const CAPTION_CAPTURE_VERBOSE_LOGS = true;

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
