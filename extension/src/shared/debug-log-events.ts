import * as v from 'valibot';

import {
    DEBUG_LOG_MAX_BLOCK_TIMINGS,
    DEBUG_LOG_MAX_FIELD_STRING_LENGTH,
} from '@/shared/debug-log-constants';

/**
 * Normative debug-log vocabulary. Keys are PascalCase forms of the wire
 * names; anything outside this map is not loggable.
 */
export const DEBUG_LOG_EVENT = {
    // Logger
    LoggingEnabled: 'logging-enabled',
    LoggingDisabled: 'logging-disabled',
    // Worker / extension
    WorkerStarted: 'worker-started',
    BrowserRestarted: 'browser-restarted',
    ExtensionRestarted: 'extension-restarted',
    RuntimeRestarted: 'runtime-restarted',
    StorageUnavailable: 'storage-unavailable',
    WakeupProbe: 'wakeup-probe',
    // Content lifecycle
    ContentReady: 'content-ready',
    RouteStatus: 'route-status',
    PrefsReceived: 'prefs-received',
    VideoBound: 'video-bound',
    VideoSwapped: 'video-swapped',
    Reattach: 'reattach',
    TabClosed: 'tab-closed',
    // Server flow
    RouteDecision: 'route-decision',
    AnalysisRequested: 'analysis-requested',
    CacheDecision: 'cache-decision',
    HttpStart: 'http-start',
    HttpResponse: 'http-response',
    HttpError: 'http-error',
    PollSummary: 'poll-summary',
    TerminalEvent: 'terminal-event',
    BlocksDelivered: 'blocks-delivered',
    DeliverySkipped: 'delivery-skipped',
    AnalysisInterrupted: 'analysis-interrupted',
    // Caption capture
    CaptureScheduled: 'capture-scheduled',
    CaptureActivation: 'capture-activation',
    CaptureStage: 'capture-stage',
    CaptureSucceeded: 'capture-succeeded',
    CaptureFailed: 'capture-failed',
    // Skip / seek
    BlocksReceived: 'blocks-received',
    BlocksRejected: 'blocks-rejected',
    SkipApplied: 'skip-applied',
    SkipSuppressed: 'skip-suppressed',
    FiredReset: 'fired-reset',
    SeekSummary: 'seek-summary',
    // BYOK metadata
    ByokRunStarted: 'byok-run-started',
    ByokChunk: 'byok-chunk',
    ByokRunEnded: 'byok-run-ended',
    HostAccessCheck: 'host-access-check',
    // User-action effects
    PrefsSaved: 'prefs-saved',
    ConnectionKeySaved: 'connection-key-saved',
    IssueReportOpened: 'issue-report-opened',
} as const;

/**
 * Wire name of one allow-listed event.
 */
export type DebugLogEventName =
    (typeof DEBUG_LOG_EVENT)[keyof typeof DEBUG_LOG_EVENT];

/**
 * Validates an event name received from a content context.
 */
export const debugLogEventNameSchema = v.picklist(
    Object.values(DEBUG_LOG_EVENT),
);

/**
 * Context that produced an event; the background stamps it on every line.
 */
export const DEBUG_LOG_SOURCE = {
    Background: 'background',
    Content: 'content',
    Bridge: 'bridge',
} as const;

/**
 * Source context literal.
 */
export type DebugLogSource =
    (typeof DEBUG_LOG_SOURCE)[keyof typeof DEBUG_LOG_SOURCE];

/**
 * Prefix of MAIN-world bridge stage names forwarded through the content
 * append path (`stage=page:timedtext-observed` …). The content wire carries
 * no source field, so this prefix is the only bridge marker: the background
 * stamps `bridge` as the source for such events and `content` otherwise.
 */
export const DEBUG_LOG_PAGE_STAGE_PREFIX = 'page:';

/**
 * Bounded scalar values a field may carry; nested values are never logged.
 */
export type DebugLogFields = Readonly<
    Record<string, string | number | boolean | null | undefined>
>;

/**
 * Identifier fields permitted on every event in addition to its family set.
 */
export const DEBUG_LOG_COMMON_FIELDS = [
    'tab',
    'video',
    'session',
    'job',
    'support',
] as const;

/**
 * Logger family: the switch's own enabled/disabled markers.
 */
const LOGGER_FIELDS = [
    'enabled',
    'mode',
    'provider',
    'model',
    'locale',
    'liveTabs',
] as const;

/**
 * Worker/extension family: lifecycle markers and the wake-up probe result.
 */
const WORKER_FIELDS = [
    'build',
    'first',
    'previousBuild',
    'newBuild',
    'cause',
    'readyTabs',
    'unavailableTabs',
] as const;

/**
 * Content lifecycle family.
 */
const CONTENT_LIFECYCLE_FIELDS = [
    'protocol',
    'extensionVersion',
    'route',
    'reason',
    'outcome',
] as const;

/**
 * Server-mode flow family.
 */
const SERVER_FLOW_FIELDS = [
    'route',
    'reason',
    'decision',
    'operation',
    'status',
    'code',
    'elapsedMs',
    'attempt',
    'polls',
    'retries',
    'totalMs',
    'lastStatus',
    'terminal',
    'failureCode',
    'count',
    'blocks',
] as const;

/**
 * Caption-capture family (ISOLATED and MAIN-world stages).
 */
const CAPTION_CAPTURE_FIELDS = [
    'trigger',
    'ok',
    'wasOn',
    'userIntervened',
    'hasTracks',
    'actions',
    'stage',
    'transport',
    'status',
    'bodyLength',
    'contentType',
    'lang',
    'urlPath',
    'urlParams',
    'fmt',
    'hasPot',
    'segments',
    'reason',
] as const;

/**
 * Skip/seek decision family.
 */
const SKIP_SEEK_FIELDS = [
    'count',
    'blocks',
    'cause',
    'block',
    'fromSec',
    'toSec',
    'deltaSec',
    'reason',
    'dropped',
    'windowMs',
] as const;

/**
 * Private BYOK metadata family (never prompt/response text or keys).
 */
const BYOK_FIELDS = [
    'provider',
    'model',
    'chunks',
    'chunk',
    'startSec',
    'endSec',
    'chars',
    'latencyMs',
    'outcome',
    'status',
    'parsedBlocks',
    'coverage',
    'uncovered',
    'blocks',
    'totalLatencyMs',
] as const;

/**
 * Background-side effects of user actions.
 */
const USER_ACTION_FIELDS = [
    'enabled',
    'mode',
    'provider',
    'model',
    'failureCode',
] as const;

/**
 * Permitted fields per event (the family set from the spec table). Common
 * identifier fields are handled separately by {@link isAllowedDebugLogField}.
 */
export const DEBUG_LOG_EVENT_FIELDS: Readonly<
    Record<DebugLogEventName, readonly string[]>
> = {
    [DEBUG_LOG_EVENT.LoggingEnabled]: LOGGER_FIELDS,
    [DEBUG_LOG_EVENT.LoggingDisabled]: LOGGER_FIELDS,
    [DEBUG_LOG_EVENT.WorkerStarted]: WORKER_FIELDS,
    [DEBUG_LOG_EVENT.BrowserRestarted]: WORKER_FIELDS,
    [DEBUG_LOG_EVENT.ExtensionRestarted]: WORKER_FIELDS,
    [DEBUG_LOG_EVENT.RuntimeRestarted]: WORKER_FIELDS,
    [DEBUG_LOG_EVENT.StorageUnavailable]: WORKER_FIELDS,
    [DEBUG_LOG_EVENT.WakeupProbe]: WORKER_FIELDS,
    [DEBUG_LOG_EVENT.ContentReady]: CONTENT_LIFECYCLE_FIELDS,
    [DEBUG_LOG_EVENT.RouteStatus]: CONTENT_LIFECYCLE_FIELDS,
    [DEBUG_LOG_EVENT.PrefsReceived]: CONTENT_LIFECYCLE_FIELDS,
    [DEBUG_LOG_EVENT.VideoBound]: CONTENT_LIFECYCLE_FIELDS,
    [DEBUG_LOG_EVENT.VideoSwapped]: CONTENT_LIFECYCLE_FIELDS,
    [DEBUG_LOG_EVENT.Reattach]: CONTENT_LIFECYCLE_FIELDS,
    [DEBUG_LOG_EVENT.TabClosed]: CONTENT_LIFECYCLE_FIELDS,
    [DEBUG_LOG_EVENT.RouteDecision]: SERVER_FLOW_FIELDS,
    [DEBUG_LOG_EVENT.AnalysisRequested]: SERVER_FLOW_FIELDS,
    [DEBUG_LOG_EVENT.CacheDecision]: SERVER_FLOW_FIELDS,
    [DEBUG_LOG_EVENT.HttpStart]: SERVER_FLOW_FIELDS,
    [DEBUG_LOG_EVENT.HttpResponse]: SERVER_FLOW_FIELDS,
    [DEBUG_LOG_EVENT.HttpError]: SERVER_FLOW_FIELDS,
    [DEBUG_LOG_EVENT.PollSummary]: SERVER_FLOW_FIELDS,
    [DEBUG_LOG_EVENT.TerminalEvent]: SERVER_FLOW_FIELDS,
    [DEBUG_LOG_EVENT.BlocksDelivered]: SERVER_FLOW_FIELDS,
    [DEBUG_LOG_EVENT.DeliverySkipped]: SERVER_FLOW_FIELDS,
    [DEBUG_LOG_EVENT.AnalysisInterrupted]: SERVER_FLOW_FIELDS,
    [DEBUG_LOG_EVENT.CaptureScheduled]: CAPTION_CAPTURE_FIELDS,
    [DEBUG_LOG_EVENT.CaptureActivation]: CAPTION_CAPTURE_FIELDS,
    [DEBUG_LOG_EVENT.CaptureStage]: CAPTION_CAPTURE_FIELDS,
    [DEBUG_LOG_EVENT.CaptureSucceeded]: CAPTION_CAPTURE_FIELDS,
    [DEBUG_LOG_EVENT.CaptureFailed]: CAPTION_CAPTURE_FIELDS,
    [DEBUG_LOG_EVENT.BlocksReceived]: SKIP_SEEK_FIELDS,
    [DEBUG_LOG_EVENT.BlocksRejected]: SKIP_SEEK_FIELDS,
    [DEBUG_LOG_EVENT.SkipApplied]: SKIP_SEEK_FIELDS,
    [DEBUG_LOG_EVENT.SkipSuppressed]: SKIP_SEEK_FIELDS,
    [DEBUG_LOG_EVENT.FiredReset]: SKIP_SEEK_FIELDS,
    [DEBUG_LOG_EVENT.SeekSummary]: SKIP_SEEK_FIELDS,
    [DEBUG_LOG_EVENT.ByokRunStarted]: BYOK_FIELDS,
    [DEBUG_LOG_EVENT.ByokChunk]: BYOK_FIELDS,
    [DEBUG_LOG_EVENT.ByokRunEnded]: BYOK_FIELDS,
    [DEBUG_LOG_EVENT.HostAccessCheck]: BYOK_FIELDS,
    [DEBUG_LOG_EVENT.PrefsSaved]: USER_ACTION_FIELDS,
    [DEBUG_LOG_EVENT.ConnectionKeySaved]: USER_ACTION_FIELDS,
    [DEBUG_LOG_EVENT.IssueReportOpened]: USER_ACTION_FIELDS,
};

/**
 * Reasons an event was dropped instead of logged; each has a counter.
 */
export const DEBUG_LOG_DROP_REASON = {
    Incognito: 'incognito',
    Coalesced: 'coalesced',
    Ceiling: 'ceiling',
    Unreachable: 'unreachable',
    Lost: 'lost',
} as const;

/**
 * Drop-reason literal.
 */
export type DebugLogDropReason =
    (typeof DEBUG_LOG_DROP_REASON)[keyof typeof DEBUG_LOG_DROP_REASON];

/**
 * Cause recorded by the generic `runtime-restarted` marker.
 */
export const DEBUG_LOG_RESTART_CAUSE = {
    SessionStateLost: 'session-state-lost',
} as const;

/**
 * YouTube video identifier shape; anything else is dropped before logging.
 */
export const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/u;

/**
 * RFC 4122 textual UUID (any version, either case) — the analysis session id.
 */
export const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Backend job identifier. The contract treats it as an opaque token of at
 * most 160 characters (the backend issues `job-<uuid>`, fixtures use other
 * tokens), so the fixed pattern is "URL-safe token characters only": no
 * spaces, quotes, slashes, dots, `=`, `?` or `&` can ever reach a line.
 */
export const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,160}$/u;

/**
 * Support identifier issued by the backend for failure follow-up.
 */
export const SUPPORT_ID_PATTERN =
    /^support-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * Validators for the identifier fields; a mismatch drops the field rather
 * than leaking an arbitrary string into the log.
 */
const ID_FIELD_PATTERNS: Readonly<Record<string, RegExp>> = {
    video: VIDEO_ID_PATTERN,
    session: UUID_PATTERN,
    job: JOB_ID_PATTERN,
    support: SUPPORT_ID_PATTERN,
};

/**
 * Field name that carries the attributed tab id (a non-negative integer).
 */
const TAB_FIELD = 'tab';

/**
 * Separator between block timings and before the truncation suffix.
 */
const BLOCK_TIMINGS_SEPARATOR = ';';

/**
 * Decimal places kept for block timing seconds.
 */
const BLOCK_TIMING_DECIMALS = 1;

/**
 * Rendered end of a block whose end time is unknown.
 */
const OPEN_BLOCK_END = 'end';

/**
 * Scale that keeps two decimals of playback seconds in log fields.
 */
const LOG_SECONDS_PRECISION_SCALE = 100;

/**
 * Whether `key` may appear on `event`: common identifier fields are allowed
 * everywhere; everything else must be in the event family's permitted set.
 *
 * @param event - Allow-listed event name.
 * @param key - Candidate field name.
 * @returns True when the field may be logged for this event.
 */
export function isAllowedDebugLogField(
    event: DebugLogEventName,
    key: string,
): boolean {
    if (DEBUG_LOG_COMMON_FIELDS.some((common) => common === key)) {
        return true;
    }
    return DEBUG_LOG_EVENT_FIELDS[event].includes(key);
}

/**
 * Serializes promo blocks as one bounded scalar (`12.0-45.5;300.2-330.0`)
 * so a block list never becomes a nested value; past the cap only a `;+N`
 * count of the hidden blocks is appended.
 *
 * @param blocks - Promo blocks in delivery order.
 * @returns Bounded scalar string, empty for no blocks.
 */
export function formatPromoBlockTimings(
    blocks: ReadonlyArray<{ startSec: number; endSec?: number }>,
): string {
    const shown = blocks.slice(0, DEBUG_LOG_MAX_BLOCK_TIMINGS).map((block) => {
        const start = block.startSec.toFixed(BLOCK_TIMING_DECIMALS);
        const end = block.endSec === undefined
            ? OPEN_BLOCK_END
            : block.endSec.toFixed(BLOCK_TIMING_DECIMALS);
        return `${start}-${end}`;
    });
    const hidden = blocks.length - shown.length;
    const joined = shown.join(BLOCK_TIMINGS_SEPARATOR);
    return hidden > 0
        ? `${joined}${BLOCK_TIMINGS_SEPARATOR}+${hidden}`
        : joined;
}

/**
 * Rounds playback seconds to two decimals so `fromSec`/`toSec`/`deltaSec`
 * fields stay short and stable across emitters.
 *
 * @param value - Seconds (any finite number).
 * @returns Seconds rounded to two decimals.
 */
export function roundLogSeconds(value: number): number {
    return (
        Math.round(value * LOG_SECONDS_PRECISION_SCALE) /
        LOG_SECONDS_PRECISION_SCALE
    );
}

/**
 * Keeps one candidate value only when it is a bounded scalar the allow-list
 * permits; identifier fields must match their fixed patterns.
 *
 * @param key - Field name (already allow-listed for the event).
 * @param value - Candidate value of any shape.
 * @returns Sanitized scalar, or `undefined` to drop the field.
 */
function sanitizeDebugLogValue(
    key: string,
    value: unknown,
): string | number | boolean | null | undefined {
    if (key === TAB_FIELD) {
        return typeof value === 'number' &&
            Number.isInteger(value) &&
            value >= 0
            ? value
            : undefined;
    }
    const idPattern = ID_FIELD_PATTERNS[key];
    if (idPattern !== undefined) {
        return typeof value === 'string' && idPattern.test(value)
            ? value
            : undefined;
    }
    if (typeof value === 'string') {
        return value.length > DEBUG_LOG_MAX_FIELD_STRING_LENGTH
            ? value.slice(0, DEBUG_LOG_MAX_FIELD_STRING_LENGTH)
            : value;
    }
    if (typeof value === 'number') {
        return Number.isFinite(value) ? value : undefined;
    }
    if (typeof value === 'boolean' || value === null) {
        return value;
    }
    return undefined;
}

/**
 * Applies the structural allow-list to raw fields: unknown keys are dropped,
 * strings are capped, nested values, arrays and non-finite numbers are
 * dropped, and identifier fields must match their patterns.
 *
 * @param event - Allow-listed event the fields belong to.
 * @param fields - Raw fields from any emitter (background or content).
 * @returns Fields safe to format into a log line, in input order.
 */
export function sanitizeDebugLogFields(
    event: DebugLogEventName,
    fields: Readonly<Record<string, unknown>>,
): DebugLogFields {
    const sanitized: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(fields)) {
        if (!isAllowedDebugLogField(event, key)) {
            continue;
        }
        const safe = sanitizeDebugLogValue(key, value);
        if (safe !== undefined) {
            sanitized[key] = safe;
        }
    }
    return sanitized;
}
