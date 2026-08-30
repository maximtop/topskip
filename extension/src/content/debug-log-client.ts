import { contentLog } from '@/content/content-log';
import browser from '@/shared/browser';
import { MS_PER_SECOND } from '@/shared/constants';
import {
    DEBUG_LOG_APPEND_MAX_EVENTS,
    DEBUG_LOG_CEILING_WINDOW_MS,
    DEBUG_LOG_CLIENT_FLUSH_DELAY_MS,
    DEBUG_LOG_CLIENT_PRESTATE_QUEUE_LIMIT,
    DEBUG_LOG_CLIENT_QUEUE_LIMIT,
    DEBUG_LOG_CLIENT_UNREACHABLE_BACKOFF_MS,
    DEBUG_LOG_CONTENT_EVENTS_PER_TAB_PER_MINUTE,
    DEBUG_LOG_MAX_FIELD_KEY_LENGTH,
    DEBUG_LOG_MAX_FIELD_STRING_LENGTH,
    DEBUG_LOG_SEEK_EVENTS_PER_SECOND,
} from '@/shared/debug-log-constants';
import {
    DEBUG_LOG_EVENT,
    JOB_ID_PATTERN,
    UUID_PATTERN,
    VIDEO_ID_PATTERN,
    roundLogSeconds,
    type DebugLogEventName,
    type DebugLogFields,
} from '@/shared/debug-log-events';
import { formatLogStage } from '@/shared/log-fields';
import {
    TOPSKIP_MESSAGE,
    type DebugLogAppendPayload,
} from '@/shared/messages';

/**
 * Dev-only console mirror prefix: the worker console shows each stage once,
 * next to the existing `[TopSkip …]` lines.
 */
const DEBUG_LOG_DEV_CONSOLE_PREFIX = '[TopSkip debug-log]';

/**
 * Seek kinds accepted by the coalescer; the kind becomes the summary `reason`.
 */
export const DEBUG_LOG_SEEK_KIND = {
    Seek: 'seek',
    Jump: 'jump',
} as const;

/**
 * Seek kind literal union.
 */
export type DebugLogSeekKind =
    (typeof DEBUG_LOG_SEEK_KIND)[keyof typeof DEBUG_LOG_SEEK_KIND];

/**
 * Seek position pair (seconds) for one seek or jump.
 */
export type DebugLogSeekFields = { fromSec: number; toSec: number };

/**
 * Optional identity attached to an event; undefined values are omitted and
 * malformed ids are dropped so the append envelope always validates.
 */
export type DebugLogEventIds = {
    video?: string;
    session?: string;
    job?: string;
};

/**
 * One wire event as accepted by the background append schema.
 */
type DebugLogWireEvent = DebugLogAppendPayload['events'][number];

/**
 * Bounded scalar fields after client-side sanitisation.
 */
type DebugLogWireFields = Record<string, string | number | boolean>;

/**
 * Queued event plus the wall-clock time it was recorded, so a batched flush
 * can back-date it with `ageMs`.
 */
type QueuedDebugLogEvent = {
    event: Omit<DebugLogWireEvent, 'ageMs'>;
    recordedAtMs: number;
};

/**
 * Drop counters reported with the next accepted batch.
 */
type DebugLogClientDropCounters = {
    coalesced: number;
    ceiling: number;
    unreachable: number;
};

/**
 * Content-side collector for allow-listed diagnostic events. Every public
 * method is synchronous, never throws, and touches no DOM, storage, or
 * extension API on the caller's stack: events are queued and sent later, in
 * bounded batches, through the validated `DEBUG_LOG_APPEND` message. Static
 * API only.
 */
export class DebugLogClient {
    /**
     * `null` until the background tells this context whether logging is on.
     */
    private static enabled: boolean | null = null;

    /**
     * Events waiting for the next batched flush.
     */
    private static queue: QueuedDebugLogEvent[] = [];

    /**
     * Bootstrap events recorded before the switch state was known.
     */
    private static preStateQueue: QueuedDebugLogEvent[] = [];

    /**
     * Pending batched flush timer.
     */
    private static flushTimerId: ReturnType<typeof globalThis.setTimeout> | null =
        null;

    /**
     * Whether the pending timer already fires on the next macrotask.
     */
    private static flushTimerIsImmediate = false;

    /**
     * Counters since the last batch the background accepted.
     */
    private static dropped: DebugLogClientDropCounters = {
        coalesced: 0,
        ceiling: 0,
        unreachable: 0,
    };

    /**
     * Start of the fixed one-minute ceiling window currently counted.
     */
    private static ceilingWindowStartMs = -1;

    /**
     * Events accepted in the current ceiling window.
     */
    private static ceilingWindowCount = 0;

    /**
     * Start of the fixed one-second seek window currently counted.
     */
    private static seekWindowStartMs = -1;

    /**
     * Seek summaries emitted in the current seek window.
     */
    private static seekWindowCount = 0;

    /**
     * Seeks coalesced away since the last emitted summary.
     */
    private static seekDroppedSinceLast = 0;

    /**
     * Wall-clock time until which sends are paused after a rejected send.
     */
    private static unreachableUntilMs = 0;

    /**
     * Disposed contexts drop everything and arm no timers.
     */
    private static disposed = false;

    /**
     * Applies the background's on/off signal. Turning on releases the
     * bootstrap events kept while the flag was unknown; turning off discards
     * everything queued because the background already recorded
     * `logging-disabled` and nothing may follow that marker.
     *
     * @param enabled - Current switch state.
     */
    static applyState(enabled: boolean): void {
        const wasUnknown = DebugLogClient.enabled === null;
        DebugLogClient.enabled = enabled;
        if (!enabled) {
            DebugLogClient.queue = [];
            DebugLogClient.preStateQueue = [];
            DebugLogClient.clearFlushTimer();
            return;
        }
        if (wasUnknown && DebugLogClient.preStateQueue.length > 0) {
            DebugLogClient.queue.push(...DebugLogClient.preStateQueue);
            DebugLogClient.preStateQueue = [];
            DebugLogClient.scheduleFlush();
        }
    }

    /**
     * Last known switch state.
     *
     * @returns `true`/`false` once the background reported it, else `null`.
     */
    static isEnabled(): boolean | null {
        return DebugLogClient.enabled;
    }

    /**
     * Records one content-originated event. Constant-time: it pushes to an
     * array and arms at most one timer; a full batch is still sent from the
     * timer, never from the caller's stack.
     *
     * @param event - Allow-listed event name.
     * @param fields - Bounded scalar fields (strings are capped here).
     * @param ids - Optional video / session / job identity.
     */
    static log(
        event: DebugLogEventName,
        fields: DebugLogFields = {},
        ids: DebugLogEventIds = {},
    ): void {
        try {
            DebugLogClient.mirrorToDevConsole(event, fields, ids);
            if (DebugLogClient.disposed || DebugLogClient.enabled === false) {
                return;
            }
            const nowMs = Date.now();
            const queued: QueuedDebugLogEvent = {
                event: {
                    event,
                    ...DebugLogClient.boundIds(ids),
                    fields: DebugLogClient.boundFields(fields),
                },
                recordedAtMs: nowMs,
            };
            if (DebugLogClient.enabled === null) {
                if (
                    DebugLogClient.preStateQueue.length <
                    DEBUG_LOG_CLIENT_PRESTATE_QUEUE_LIMIT
                ) {
                    DebugLogClient.preStateQueue.push(queued);
                }
                return;
            }
            if (!DebugLogClient.admitUnderCeiling(nowMs)) {
                DebugLogClient.dropped.ceiling += 1;
                return;
            }
            if (DebugLogClient.queue.length >= DEBUG_LOG_CLIENT_QUEUE_LIMIT) {
                // The queue only fills while the background is not taking
                // batches, so the overflow is reported as unreachable.
                DebugLogClient.dropped.unreachable += 1;
                return;
            }
            DebugLogClient.queue.push(queued);
            DebugLogClient.scheduleFlush();
        } catch {
            // Diagnostics must never throw into skip logic or teardown paths.
        }
    }

    /**
     * Records a seek or jump with per-second coalescing: the first
     * `DEBUG_LOG_SEEK_EVENTS_PER_SECOND` of a fixed one-second window become
     * `seek-summary` events, the rest are counted and reported both on the
     * next emitted summary (`dropped`) and in the batch counters.
     *
     * @param kind - `seek` (seeked listener) or `jump` (timeupdate gap).
     * @param fields - From/to positions in seconds.
     * @param ids - Optional video / session identity.
     */
    static logSeek(
        kind: DebugLogSeekKind,
        fields: DebugLogSeekFields,
        ids: DebugLogEventIds = {},
    ): void {
        try {
            if (DebugLogClient.disposed || DebugLogClient.enabled !== true) {
                return;
            }
            const nowMs = Date.now();
            const windowStartMs = nowMs - (nowMs % MS_PER_SECOND);
            if (windowStartMs !== DebugLogClient.seekWindowStartMs) {
                DebugLogClient.seekWindowStartMs = windowStartMs;
                DebugLogClient.seekWindowCount = 0;
            }
            if (
                DebugLogClient.seekWindowCount >=
                DEBUG_LOG_SEEK_EVENTS_PER_SECOND
            ) {
                DebugLogClient.seekDroppedSinceLast += 1;
                DebugLogClient.dropped.coalesced += 1;
                return;
            }
            DebugLogClient.seekWindowCount += 1;
            const dropped = DebugLogClient.seekDroppedSinceLast;
            DebugLogClient.seekDroppedSinceLast = 0;
            DebugLogClient.log(
                DEBUG_LOG_EVENT.SeekSummary,
                {
                    reason: kind,
                    fromSec: roundLogSeconds(fields.fromSec),
                    toSec: roundLogSeconds(fields.toSec),
                    deltaSec: roundLogSeconds(fields.toSec - fields.fromSec),
                    dropped,
                    windowMs: MS_PER_SECOND,
                },
                ids,
            );
        } catch {
            // Never let diagnostics throw into playback listeners.
        }
    }

    /**
     * Sends whatever is queued right now (replacement dispose and tests).
     *
     * @returns Promise settled after the send attempt.
     */
    static flushNow(): Promise<void> {
        DebugLogClient.clearFlushTimer();
        return DebugLogClient.flush();
    }

    /**
     * Drops queued events and timers. Called from the replacement dispose and
     * from the orphan teardown path, where the runtime may already be gone.
     */
    static dispose(): void {
        DebugLogClient.disposed = true;
        DebugLogClient.clearFlushTimer();
        DebugLogClient.queue = [];
        DebugLogClient.preStateQueue = [];
    }

    /**
     * Resets every static field for isolated unit tests.
     */
    static resetForTest(): void {
        DebugLogClient.dispose();
        DebugLogClient.disposed = false;
        DebugLogClient.enabled = null;
        DebugLogClient.dropped = { coalesced: 0, ceiling: 0, unreachable: 0 };
        DebugLogClient.ceilingWindowStartMs = -1;
        DebugLogClient.ceilingWindowCount = 0;
        DebugLogClient.seekWindowStartMs = -1;
        DebugLogClient.seekWindowCount = 0;
        DebugLogClient.seekDroppedSinceLast = 0;
        DebugLogClient.unreachableUntilMs = 0;
    }

    /**
     * Prints the stage to the dev console (worker relay) so a stage is
     * emitted once and reaches both sinks; the define is read at call time so
     * tests can flip it, and release builds tree-shake the branch.
     *
     * @param event - Event name.
     * @param fields - Raw fields.
     * @param ids - Raw ids.
     */
    private static mirrorToDevConsole(
        event: DebugLogEventName,
        fields: DebugLogFields,
        ids: DebugLogEventIds,
    ): void {
        if (!__TOPSKIP_INCLUDE_DEV_LOCAL__) {
            return;
        }
        contentLog.info(
            DEBUG_LOG_DEV_CONSOLE_PREFIX,
            ...formatLogStage(event, { ...ids, ...fields }),
        );
    }

    /**
     * Fixed-window admission for the per-context ceiling (the background
     * enforces the same ceiling per tab; this keeps a runaway tab from even
     * sending the excess).
     *
     * @param nowMs - Wall-clock time of the event.
     * @returns Whether the event may be queued.
     */
    private static admitUnderCeiling(nowMs: number): boolean {
        const windowStartMs = nowMs - (nowMs % DEBUG_LOG_CEILING_WINDOW_MS);
        if (windowStartMs !== DebugLogClient.ceilingWindowStartMs) {
            DebugLogClient.ceilingWindowStartMs = windowStartMs;
            DebugLogClient.ceilingWindowCount = 0;
        }
        if (
            DebugLogClient.ceilingWindowCount >=
            DEBUG_LOG_CONTENT_EVENTS_PER_TAB_PER_MINUTE
        ) {
            return false;
        }
        DebugLogClient.ceilingWindowCount += 1;
        return true;
    }

    /**
     * Keeps only ids the background schema accepts (`VIDEO_ID_PATTERN`,
     * `UUID_PATTERN`, `JOB_ID_PATTERN` — the same patterns the content event
     * wire schema enforces). A malformed id is dropped rather than truncated:
     * one rejected id would otherwise fail the whole batch's strict parse in
     * the background and lose every other event.
     *
     * @param ids - Caller-provided ids.
     * @returns Ids with malformed or empty values removed.
     */
    private static boundIds(ids: DebugLogEventIds): DebugLogEventIds {
        const bounded: DebugLogEventIds = {};
        if (ids.video !== undefined && VIDEO_ID_PATTERN.test(ids.video)) {
            bounded.video = ids.video;
        }
        if (ids.session !== undefined && UUID_PATTERN.test(ids.session)) {
            bounded.session = ids.session;
        }
        if (ids.job !== undefined && JOB_ID_PATTERN.test(ids.job)) {
            bounded.job = ids.job;
        }
        return bounded;
    }

    /**
     * Caps strings, skips over-long keys and drops `undefined`, `null`, and
     * non-finite numbers so the append envelope always validates against the
     * content event wire schema.
     *
     * @param fields - Caller-provided scalar fields.
     * @returns Bounded copy.
     */
    private static boundFields(fields: DebugLogFields): DebugLogWireFields {
        const bounded: DebugLogWireFields = {};
        for (const [key, value] of Object.entries(fields)) {
            if (key.length > DEBUG_LOG_MAX_FIELD_KEY_LENGTH) {
                continue;
            }
            if (value === undefined || value === null) {
                continue;
            }
            if (typeof value === 'number' && !Number.isFinite(value)) {
                continue;
            }
            bounded[key] =
                typeof value === 'string'
                    ? value.slice(0, DEBUG_LOG_MAX_FIELD_STRING_LENGTH)
                    : value;
        }
        return bounded;
    }

    /**
     * Arms one debounced flush; a full batch moves the timer to the next
     * macrotask instead of sending synchronously, so playback hooks never
     * reach the runtime on their own stack. Sends respect the backoff.
     */
    private static scheduleFlush(): void {
        if (DebugLogClient.disposed) {
            return;
        }
        const full = DebugLogClient.queue.length >= DEBUG_LOG_APPEND_MAX_EVENTS;
        if (DebugLogClient.flushTimerId !== null) {
            if (!full || DebugLogClient.flushTimerIsImmediate) {
                return;
            }
            DebugLogClient.clearFlushTimer();
        }
        const backoffMs = Math.max(
            0,
            DebugLogClient.unreachableUntilMs - Date.now(),
        );
        const delayMs = Math.max(
            backoffMs,
            full ? 0 : DEBUG_LOG_CLIENT_FLUSH_DELAY_MS,
        );
        DebugLogClient.flushTimerIsImmediate = delayMs === 0;
        DebugLogClient.flushTimerId = globalThis.setTimeout(() => {
            DebugLogClient.flushTimerId = null;
            DebugLogClient.flushTimerIsImmediate = false;
            void DebugLogClient.flush();
        }, delayMs);
    }

    /**
     * Clears the pending flush timer.
     */
    private static clearFlushTimer(): void {
        if (DebugLogClient.flushTimerId !== null) {
            globalThis.clearTimeout(DebugLogClient.flushTimerId);
        }
        DebugLogClient.flushTimerId = null;
        DebugLogClient.flushTimerIsImmediate = false;
    }

    /**
     * Sends one bounded batch. A rejected or throwing send drops the batch,
     * counts it as `unreachable`, carries all counters into the next attempt,
     * and arms a backoff — the channel is never latched off, so a restarted
     * worker receives the next batch.
     *
     * @returns Promise settled after the send attempt.
     */
    private static async flush(): Promise<void> {
        if (
            DebugLogClient.disposed ||
            DebugLogClient.enabled !== true ||
            DebugLogClient.queue.length === 0
        ) {
            return;
        }
        const nowMs = Date.now();
        const batch = DebugLogClient.queue.splice(0, DEBUG_LOG_APPEND_MAX_EVENTS);
        const dropped = DebugLogClient.dropped;
        DebugLogClient.dropped = { coalesced: 0, ceiling: 0, unreachable: 0 };
        const payload: DebugLogAppendPayload = {
            events: batch.map((queued) => ({
                ...queued.event,
                ageMs: Math.max(0, nowMs - queued.recordedAtMs),
            })),
            dropped,
        };
        let response: unknown = null;
        try {
            response = await browser.runtime.sendMessage({
                type: TOPSKIP_MESSAGE.DEBUG_LOG_APPEND,
                payload,
            });
        } catch {
            DebugLogClient.dropped.coalesced += dropped.coalesced;
            DebugLogClient.dropped.ceiling += dropped.ceiling;
            DebugLogClient.dropped.unreachable +=
                dropped.unreachable + batch.length;
            DebugLogClient.unreachableUntilMs =
                Date.now() + DEBUG_LOG_CLIENT_UNREACHABLE_BACKOFF_MS;
        }
        DebugLogClient.applyAck(response);
        if (DebugLogClient.queue.length > 0) {
            DebugLogClient.scheduleFlush();
        }
    }

    /**
     * The append acknowledgement carries the current switch state so a
     * context that missed the push resynchronises on its next batch.
     *
     * @param response - Opaque runtime reply.
     */
    private static applyAck(response: unknown): void {
        if (
            response === null ||
            typeof response !== 'object' ||
            Reflect.get(response, 'ok') !== true
        ) {
            return;
        }
        const enabled: unknown = Reflect.get(response, 'enabled');
        if (typeof enabled === 'boolean' && enabled !== DebugLogClient.enabled) {
            DebugLogClient.applyState(enabled);
        }
    }
}
