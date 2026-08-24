import * as v from 'valibot';

export {
    MIME_APPLICATION_JSON,
    MS_PER_SECOND,
    SECONDS_PER_HOUR,
} from '@topskip/common/constants';

import { DEFAULT_DETECTION_MODEL_ID } from '@/shared/detection-models';
import { PROVIDER_ID } from '@/shared/providers';

export {
    YOUTUBE_ORIGIN as YOUTUBE_BASE_URL,
    YOUTUBE_WATCH_PATH as YOUTUBE_WATCH_URL_PATH,
    YOUTUBE_WATCH_VIDEO_ID_PARAM,
} from '@/shared/watch-route';

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
 * Background-only installation credential used by the public backend.
 */
export const STORAGE_KEY_SERVER_INSTALLATION = 'topskip:server-installation';

/**
 * Background-only snapshot of public server compatibility configuration.
 */
export const STORAGE_KEY_SERVER_CONFIG = 'topskip:server-config';

/**
 * Background-only timestamp that throttles public config refresh attempts even
 * when the server is unavailable.
 */
export const STORAGE_KEY_SERVER_CONFIG_REFRESH_ATTEMPT =
    'topskip:server-config-refresh-attempt';

/**
 * Background-only index of result-cache record keys so cache cleanup reads
 * its own rows instead of scanning every key in `storage.local` (and never
 * loads debug-log segments).
 */
export const STORAGE_KEY_SERVER_RESULT_CACHE_INDEX =
    'topskip:server-result-cache:index';

/**
 * Common prefix of every debug-log key in `browser.storage.local`; disjoint
 * from the result-cache prefix so cache cleanup never loads log segments.
 */
export const STORAGE_KEY_DEBUG_LOG_PREFIX = 'topskip:debug-log:';

/**
 * Debug-log switch record: switch state plus the last-known build label.
 */
export const STORAGE_KEY_DEBUG_LOG_SWITCH = `${STORAGE_KEY_DEBUG_LOG_PREFIX}switch`;

/**
 * Debug-log index record: counters, timestamps, segment list and revision.
 */
export const STORAGE_KEY_DEBUG_LOG_INDEX = `${STORAGE_KEY_DEBUG_LOG_PREFIX}index`;

/**
 * Prefix of the per-segment debug-log keys; the numeric segment id follows.
 */
export const STORAGE_KEY_DEBUG_LOG_SEGMENT_PREFIX =
    `${STORAGE_KEY_DEBUG_LOG_PREFIX}segment:`;

/**
 * `browser.storage.session` marker proving a previous worker of this browser
 * session already ran (distinguishes a worker wake from a session-state
 * loss).
 */
export const SESSION_STORAGE_KEY_DEBUG_LOG_WORKER = 'topskipDebugLogWorker';

/**
 * `browser.storage.session` mirror of the per-tab attribution state.
 */
export const SESSION_STORAGE_KEY_DEBUG_LOG_TABS = 'topskipDebugLogTabs';

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
 * Emits safe stage-by-stage caption capture diagnostics only in development
 * builds without gating the production caption acquisition path.
 */
export const CAPTION_CAPTURE_VERBOSE_LOGS =
    typeof __TOPSKIP_CAPTION_CAPTURE_VERBOSE_LOGS__ !== 'undefined' &&
    __TOPSKIP_CAPTION_CAPTURE_VERBOSE_LOGS__;

/**
 * Well-known port name for long-lived preference-sync connections
 * between extension pages (popup, options) and the background service
 * worker.
 */
export const PREFS_PORT_NAME = 'topskip:prefs';

// ─────────────────────────────────────────── Unit conversions ─────────────

/**
 * Seconds per minute.
 */
export const SECONDS_PER_MINUTE = 60;

/**
 * Scale factor to convert a 0–1 fraction into a percentage.
 */
export const PERCENT_SCALE = 100;

/**
 * Bytes per kibibyte — the binary unit used for storage accounting and UI.
 */
export const BYTES_PER_KIB = 1024;

/**
 * Bytes per mebibyte.
 */
export const BYTES_PER_MIB = 1024 * BYTES_PER_KIB;

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
 * MIME type of the plain-text debug-log download.
 */
export const MIME_TEXT_PLAIN_UTF8 = 'text/plain;charset=utf-8';

// ────────────────────────────────────────── Messaging ─────────────────────

/**
 * `frameId` Chrome assigns to a tab's top-level document; content senders
 * from sub-frames carry positive ids and are never trusted.
 */
export const TOP_FRAME_ID = 0;

// ──────────────────────────────────────── Debug / Dev ─────────────────────

/**
 * Local debug-log server endpoint. Only consumed by `shared/debug-log.ts`.
 * Not active in production (server typically unreachable).
 */
export const DEBUG_LOG_SERVER_URL = 'http://127.0.0.1:9222/log';
