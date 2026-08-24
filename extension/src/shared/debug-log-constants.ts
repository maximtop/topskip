import { BYTES_PER_KIB, BYTES_PER_MIB } from '@/shared/constants';

/**
 * Accounted-size ceiling of the ring buffer (sum of UTF-8 line bytes plus one
 * terminator per line); the UI copy and the export header read this value.
 */
export const DEBUG_LOG_CAP_BYTES = 5 * BYTES_PER_MIB;

/**
 * Allowance for index and segment framing on top of the accounted cap; the
 * persisted bytes of all debug-log keys stay within cap + overhead.
 */
export const DEBUG_LOG_PERSISTED_OVERHEAD_BYTES = 256 * BYTES_PER_KIB;

/**
 * Upper bound of newline-joined lines held by one storage segment so a flush
 * rewrites at most one open segment instead of the whole store.
 */
export const DEBUG_LOG_SEGMENT_MAX_BYTES = 64 * BYTES_PER_KIB;

/**
 * Most recent part of the bundle the Options preview shows.
 */
export const DEBUG_LOG_PREVIEW_TAIL_BYTES = 256 * BYTES_PER_KIB;

/**
 * Debounce before pending appends are written, batching bursts into one write.
 */
export const DEBUG_LOG_FLUSH_DEBOUNCE_MS = 250;

/**
 * Pending-event count that forces a flush before the debounce elapses.
 */
export const DEBUG_LOG_FLUSH_MAX_PENDING_EVENTS = 200;

/**
 * Events held in emission order before hydration completes; later ones drop.
 */
export const DEBUG_LOG_PREHYDRATION_QUEUE_LIMIT = 256;

/**
 * Unflushed lines kept in memory across failed writes; overflow counts as lost.
 */
export const DEBUG_LOG_MEMORY_TAIL_LIMIT = 1_000;

/**
 * Hard ceiling for one serialized line so a single event cannot dominate.
 */
export const DEBUG_LOG_MAX_LINE_BYTES = 2_048;

/**
 * Per-field cap for string values (UTF-16 units) applied before formatting.
 */
export const DEBUG_LOG_MAX_FIELD_STRING_LENGTH = 128;

/**
 * Per-field cap for field keys on the content append wire.
 */
export const DEBUG_LOG_MAX_FIELD_KEY_LENGTH = 32;

/**
 * Promo blocks rendered in a `blocks` field before the `;+N` suffix.
 */
export const DEBUG_LOG_MAX_BLOCK_TIMINGS = 20;

/**
 * Events accepted in one content → background append batch.
 */
export const DEBUG_LOG_APPEND_MAX_EVENTS = 64;

/**
 * Content-sourced events accepted per tab per fixed one-minute window.
 */
export const DEBUG_LOG_CONTENT_EVENTS_PER_TAB_PER_MINUTE = 600;

/**
 * Length of the fixed per-tab ceiling window.
 */
export const DEBUG_LOG_CEILING_WINDOW_MS = 60_000;

/**
 * Seek/jump summaries a tab may log per second; the rest are coalesced.
 */
export const DEBUG_LOG_SEEK_EVENTS_PER_SECOND = 5;

/**
 * Interim `poll-summary` cadence (every N polls) emitted by the content
 * session.
 */
export const DEBUG_LOG_POLL_SUMMARY_EVERY_POLLS = 10;

/**
 * MAIN-world bridge diagnostics accepted per capture session.
 */
export const DEBUG_LOG_BRIDGE_DIAGNOSTICS_PER_SESSION = 64;

/**
 * Content client delay before a queued batch is sent.
 */
export const DEBUG_LOG_CLIENT_FLUSH_DELAY_MS = 500;

/**
 * Content client queue bound; overflow is dropped and counted.
 */
export const DEBUG_LOG_CLIENT_QUEUE_LIMIT = 256;

/**
 * Events the content client holds before it learns the switch state.
 */
export const DEBUG_LOG_CLIENT_PRESTATE_QUEUE_LIMIT = 64;

/**
 * Pause after a failed append before the content client retries sending.
 */
export const DEBUG_LOG_CLIENT_UNREACHABLE_BACKOFF_MS = 5_000;

/**
 * File-name prefix of the exported bundle.
 */
export const DEBUG_LOG_FILE_NAME_PREFIX = 'topskip-debug-log-';

/**
 * File-name extension of the exported bundle.
 */
export const DEBUG_LOG_FILE_EXTENSION = '.txt';

/**
 * Character budget for the popup indicator text in every locale.
 */
export const DEBUG_LOG_POPUP_INDICATOR_MAX_CHARS = 24;

/**
 * Persisted store layout version; a mismatch discards the stored log.
 */
export const DEBUG_LOG_STORE_VERSION = 1;

/**
 * Switch default while no persisted state exists: on in dev builds, off in
 * beta/release. The only define-dependent value in the logger; tests pass
 * explicit overrides instead of relying on it. Guarded with `typeof` so the
 * module also loads where the define is absent (Playwright imports it in
 * Node).
 */
export const DEBUG_LOG_DEFAULT_ENABLED =
    typeof __TOPSKIP_INCLUDE_DEV_LOCAL__ !== 'undefined' &&
    __TOPSKIP_INCLUDE_DEV_LOCAL__;
