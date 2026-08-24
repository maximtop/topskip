import { DebugLogStore } from '@/background/debug-log/debug-log-store';
import { TabAttributionRegistry } from '@/background/debug-log/tab-attribution-registry';
import { DEBUG_LOG_PREHYDRATION_QUEUE_LIMIT } from '@/shared/debug-log-constants';
import {
    DEBUG_LOG_DROP_REASON,
    DEBUG_LOG_EVENT,
    DEBUG_LOG_PAGE_STAGE_PREFIX,
    DEBUG_LOG_RESTART_CAUSE,
    DEBUG_LOG_SOURCE,
    JOB_ID_PATTERN,
    SUPPORT_ID_PATTERN,
    UUID_PATTERN,
    VIDEO_ID_PATTERN,
    sanitizeDebugLogFields,
    type DebugLogEventName,
    type DebugLogFields,
    type DebugLogSource,
} from '@/shared/debug-log-events';
import {
    formatDebugLogLine,
    type DebugLogLineRecord,
} from '@/shared/debug-log-format';
import { formatLogStage } from '@/shared/log-fields';
import type { DebugLogAppendPayload } from '@/shared/messages';

/**
 * Console prefix of the dev-build mirror.
 */
const DEBUG_LOG_CONSOLE_PREFIX = '[TopSkip debug]';

/**
 * Worker ids are short random base-36 strings; they only need to tell
 * lifetimes apart inside one bundle.
 */
const WORKER_ID_RADIX = 36;

/**
 * Length of the worker id.
 */
const WORKER_ID_LENGTH = 6;

/**
 * Markers that describe the lifetime or the logger itself; they never trigger
 * the generic restart marker, so a fresh log always begins with its
 * `logging-enabled` line.
 */
const MARKER_EVENTS: ReadonlySet<DebugLogEventName> = new Set([
    DEBUG_LOG_EVENT.WorkerStarted,
    DEBUG_LOG_EVENT.BrowserRestarted,
    DEBUG_LOG_EVENT.ExtensionRestarted,
    DEBUG_LOG_EVENT.RuntimeRestarted,
    DEBUG_LOG_EVENT.LoggingEnabled,
    DEBUG_LOG_EVENT.LoggingDisabled,
]);

/**
 * Cause markers; once one was observed (logged or not) the generic marker
 * is no longer due, because the cause is known.
 */
const RESTART_CAUSE_EVENTS: ReadonlySet<DebugLogEventName> = new Set([
    DEBUG_LOG_EVENT.BrowserRestarted,
    DEBUG_LOG_EVENT.ExtensionRestarted,
    DEBUG_LOG_EVENT.RuntimeRestarted,
]);

/**
 * Attribution resolved by the background, never by the sender; `tsMs`
 * back-dates batched content events.
 */
export type DebugLogContext = {
    src?: DebugLogSource;
    tab?: number;
    video?: string;
    session?: string;
    job?: string;
    support?: string;
    tsMs?: number;
};

/**
 * One record held until the facade opens or committed right away.
 */
type PendingRecord = {
    event: DebugLogEventName;
    fields: DebugLogFields;
    ctx: DebugLogContext;
    tsMs: number;
};

/**
 * Single diagnostics entry point for the background: stamps, gates,
 * sanitizes and formats one event and hands the line to the store; never
 * throws and never awaits in the caller's path. Static API only.
 */
export class DebugLog {
    /**
     * Distinguishes worker lifetimes in the bundle.
     */
    private static readonly worker = DebugLog.createWorkerId();

    /**
     * Per-lifetime sequence of stored lines.
     */
    private static seq = 0;

    /**
     * Closed until the lifecycle has placed the worker-started marker.
     */
    private static opened = false;

    /**
     * Records emitted before the facade opened, in emission order.
     */
    private static readonly queue: PendingRecord[] = [];

    /**
     * Whether session-scoped state was absent at this worker's start.
     */
    private static sessionStateLost = false;

    /**
     * Whether a restart cause was observed (specific signal, logged or not)
     * or the generic marker was already written.
     */
    private static restartMarkerLogged = false;

    /**
     * Worker lifetime identifier written into every line.
     *
     * @returns Short random id.
     */
    static workerId(): string {
        return DebugLog.worker;
    }

    /**
     * Records one allow-listed event; queued while closed, dropped while the
     * switch is off or the tab is incognito/unknown.
     *
     * @param event - Event name from the normative vocabulary.
     * @param fields - Bounded scalar fields (unknown keys are dropped).
     * @param ctx - Background-resolved attribution.
     * @param mirrorToConsole - Dev-only console mirror (test override).
     */
    static record(
        event: DebugLogEventName,
        fields: DebugLogFields = {},
        ctx: DebugLogContext = {},
        mirrorToConsole = __TOPSKIP_INCLUDE_DEV_LOCAL__,
    ): void {
        try {
            if (mirrorToConsole) {
                console.info(DEBUG_LOG_CONSOLE_PREFIX, ...formatLogStage(event, fields));
            }
            const entry: PendingRecord = {
                event,
                fields,
                ctx,
                tsMs: ctx.tsMs ?? Date.now(),
            };
            if (!DebugLog.opened) {
                DebugLog.enqueue(entry);
                return;
            }
            DebugLog.commit(entry);
        } catch {
            // Diagnostics must never break the caller.
        }
    }

    /**
     * Accepts a validated content batch for a trusted tab: folds the client's
     * drop counters, drops incognito tabs as a whole, applies the per-tab
     * ceiling and back-dates each event by its age. Content events are not
     * mirrored here because the content client already mirrors them in dev.
     *
     * @param tabId - Trusted sender tab id.
     * @param payload - Schema-validated append payload.
     * @param nowMs - Background receipt time.
     */
    static appendFromContent(
        tabId: number,
        payload: DebugLogAppendPayload,
        nowMs = Date.now(),
    ): void {
        try {
            const dropped = payload.dropped;
            if (dropped !== undefined) {
                DebugLogStore.noteDropped(DEBUG_LOG_DROP_REASON.Coalesced, dropped.coalesced);
                DebugLogStore.noteDropped(DEBUG_LOG_DROP_REASON.Ceiling, dropped.ceiling);
                DebugLogStore.noteDropped(
                    DEBUG_LOG_DROP_REASON.Unreachable,
                    dropped.unreachable,
                );
            }
            const incognito = TabAttributionRegistry.isIncognitoSync(tabId);
            if (incognito === null) {
                // Unknown tab: no event, no counter — same rule as `commit()`;
                // the batch is never counted as incognito.
                return;
            }
            if (incognito) {
                DebugLogStore.noteDropped(
                    DEBUG_LOG_DROP_REASON.Incognito,
                    payload.events.length,
                );
                return;
            }
            for (const event of payload.events) {
                if (!TabAttributionRegistry.allowContentEvent(tabId, nowMs)) {
                    DebugLogStore.noteDropped(DEBUG_LOG_DROP_REASON.Ceiling);
                    continue;
                }
                DebugLog.record(
                    event.event,
                    event.fields,
                    {
                        src: DebugLog.contentSource(event.fields),
                        tab: tabId,
                        video: event.video,
                        session: event.session,
                        job: event.job,
                        tsMs: Math.max(0, nowMs - event.ageMs),
                    },
                    false,
                );
            }
        } catch {
            // Diagnostics must never break the message handler.
        }
    }

    /**
     * MAIN-world bridge stages travel through the content append path; the
     * `page:` stage prefix is the only bridge marker on the wire, so it alone
     * decides the `bridge` source stamp.
     *
     * @param fields - Validated wire fields of one content event.
     * @returns `bridge` for forwarded page stages, `content` otherwise.
     */
    private static contentSource(fields: DebugLogFields): DebugLogSource {
        const stage = fields.stage;
        return typeof stage === 'string' &&
            stage.startsWith(DEBUG_LOG_PAGE_STAGE_PREFIX)
            ? DEBUG_LOG_SOURCE.Bridge
            : DEBUG_LOG_SOURCE.Content;
    }

    /**
     * Opens the facade and commits the queued records in emission order.
     */
    static open(): void {
        if (DebugLog.opened) {
            return;
        }
        DebugLog.opened = true;
        for (const entry of DebugLog.queue.splice(0)) {
            DebugLog.commit(entry);
        }
    }

    /**
     * Drops everything queued so far (events emitted before a log existed).
     */
    static discardQueued(): void {
        DebugLog.queue.length = 0;
    }

    /**
     * Tells the facade that no session-scoped state survived from a previous
     * worker, so the generic restart marker is due before the first
     * non-lifecycle event unless a specific cause marker arrives first.
     */
    static markSessionStateLost(): void {
        DebugLog.sessionStateLost = true;
    }

    /**
     * Waits for the store to persist what has been committed (tests and the
     * tab-removal path).
     *
     * @returns Promise settled after the pending batch was written.
     */
    static async drain(): Promise<void> {
        await DebugLogStore.flush();
    }

    /**
     * Clears all static state between tests (the worker id is kept).
     */
    static resetForTest(): void {
        DebugLog.seq = 0;
        DebugLog.opened = false;
        DebugLog.queue.length = 0;
        DebugLog.sessionStateLost = false;
        DebugLog.restartMarkerLogged = false;
    }

    /**
     * Holds a record until the facade opens; overflow is dropped because no
     * store exists yet to count it.
     *
     * @param entry - Record to hold.
     */
    private static enqueue(entry: PendingRecord): void {
        if (DebugLog.queue.length >= DEBUG_LOG_PREHYDRATION_QUEUE_LIMIT) {
            return;
        }
        DebugLog.queue.push(entry);
    }

    /**
     * Applies the switch, incognito and restart-marker rules, then writes.
     *
     * @param entry - Record to commit.
     */
    private static commit(entry: PendingRecord): void {
        if (RESTART_CAUSE_EVENTS.has(entry.event)) {
            DebugLog.restartMarkerLogged = true;
        }
        if (!DebugLogStore.isEnabled()) {
            return;
        }
        const { tab } = entry.ctx;
        if (tab !== undefined) {
            const incognito = TabAttributionRegistry.isIncognitoSync(tab);
            if (incognito === null) {
                // An unknown tab is never assumed to be a normal window.
                return;
            }
            if (incognito) {
                DebugLogStore.noteDropped(DEBUG_LOG_DROP_REASON.Incognito);
                return;
            }
        }
        const isMarker = MARKER_EVENTS.has(entry.event);
        if (!isMarker && DebugLog.sessionStateLost && !DebugLog.restartMarkerLogged) {
            DebugLog.restartMarkerLogged = true;
            DebugLog.writeLine({
                event: DEBUG_LOG_EVENT.RuntimeRestarted,
                fields: { cause: DEBUG_LOG_RESTART_CAUSE.SessionStateLost },
                ctx: {},
                tsMs: entry.tsMs,
            });
        }
        DebugLog.writeLine(entry);
    }

    /**
     * Sanitizes, stamps and formats one record and appends it to the store.
     *
     * @param entry - Record that passed every gate.
     */
    private static writeLine(entry: PendingRecord): void {
        const fields = sanitizeDebugLogFields(entry.event, entry.fields);
        DebugLog.seq += 1;
        const record: DebugLogLineRecord = {
            tsMs: entry.tsMs,
            worker: DebugLog.worker,
            seq: DebugLog.seq,
            src: entry.ctx.src ?? DEBUG_LOG_SOURCE.Background,
            ...DebugLog.attributedIds(entry.ctx),
            event: entry.event,
            fields,
        };
        DebugLogStore.append([formatDebugLogLine(record)], entry.tsMs);
    }

    /**
     * Keeps only ids that match their fixed patterns; a video id without a
     * tab is stripped because an unattributed stage must not name a video.
     *
     * @param ctx - Caller context.
     * @returns Id fields for the line record.
     */
    private static attributedIds(
        ctx: DebugLogContext,
    ): Pick<DebugLogLineRecord, 'tab' | 'video' | 'session' | 'job' | 'support'> {
        const hasTab = ctx.tab !== undefined;
        return {
            tab: ctx.tab,
            video: hasTab ? DebugLog.matching(VIDEO_ID_PATTERN, ctx.video) : undefined,
            session: DebugLog.matching(UUID_PATTERN, ctx.session),
            job: DebugLog.matching(JOB_ID_PATTERN, ctx.job),
            support: DebugLog.matching(SUPPORT_ID_PATTERN, ctx.support),
        };
    }

    /**
     * Returns the value only when it matches the pattern.
     *
     * @param pattern - Fixed id pattern.
     * @param value - Candidate id.
     * @returns The id or `undefined`.
     */
    private static matching(pattern: RegExp, value: string | undefined): string | undefined {
        return value !== undefined && pattern.test(value) ? value : undefined;
    }

    /**
     * Short random id; collisions between lifetimes are harmless for reading.
     *
     * @returns Base-36 id of fixed length.
     */
    private static createWorkerId(): string {
        return Math.random()
            .toString(WORKER_ID_RADIX)
            .slice(2, 2 + WORKER_ID_LENGTH)
            .padEnd(WORKER_ID_LENGTH, '0');
    }
}
