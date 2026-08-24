import * as v from 'valibot';

import { BackgroundStorageAccess } from '@/background/storage/background-storage-access';
import browser from '@/shared/browser';
import {
    BYTES_PER_KIB,
    MS_PER_SECOND,
    STORAGE_KEY_DEBUG_LOG_INDEX,
    STORAGE_KEY_DEBUG_LOG_SEGMENT_PREFIX,
    STORAGE_KEY_DEBUG_LOG_SWITCH,
} from '@/shared/constants';
import {
    DEBUG_LOG_CAP_BYTES,
    DEBUG_LOG_DEFAULT_ENABLED,
    DEBUG_LOG_FLUSH_DEBOUNCE_MS,
    DEBUG_LOG_FLUSH_MAX_PENDING_EVENTS,
    DEBUG_LOG_MAX_LINE_BYTES,
    DEBUG_LOG_MEMORY_TAIL_LIMIT,
    DEBUG_LOG_SEGMENT_MAX_BYTES,
    DEBUG_LOG_STORE_VERSION,
} from '@/shared/debug-log-constants';
import {
    DEBUG_LOG_DROP_REASON,
    DEBUG_LOG_EVENT,
    DEBUG_LOG_SOURCE,
    type DebugLogDropReason,
} from '@/shared/debug-log-events';
import {
    formatDebugLogLine,
    sliceDebugLogTail,
    utf8ByteLength,
} from '@/shared/debug-log-format';
import {
    DEV_DEBUG_LOG_SEED_STATE,
    type DebugLogStatusPayload,
    type DevSeedDebugLogPayload,
} from '@/shared/messages';

/**
 * Build labels are short (`version` or `version (timestamp)`); a longer value
 * is corrupt and the record is dropped.
 */
const MAX_BUILD_LABEL_LENGTH = 64;

/**
 * Worker id written into dev-seeded synthetic lines.
 */
const SEED_WORKER_ID = 'seed';

/**
 * Size of a dev-seeded log when the request names none.
 */
const SEED_DEFAULT_BYTES = 4 * BYTES_PER_KIB;

/**
 * Spacing between synthetic seeded events so the header timestamps read
 * like a real session.
 */
const SEED_EVENT_SPACING_MS = MS_PER_SECOND;

/**
 * Decision value marking a seeded synthetic line.
 */
const SEED_DECISION = 'seed';

const nonNegativeIntSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const epochMsSchema = v.pipe(
    v.number(),
    v.finite('Epoch milliseconds must be finite.'),
    v.integer(),
    v.minValue(1),
);

/**
 * Switch record: `enabled === null` means neither the user nor the profile
 * default has decided yet, so the default still applies on the next start.
 */
const debugLogSwitchSchema = v.strictObject({
    version: v.literal(DEBUG_LOG_STORE_VERSION),
    enabled: v.nullable(v.boolean()),
    lastBuildLabel: v.nullable(
        v.pipe(v.string(), v.maxLength(MAX_BUILD_LABEL_LENGTH)),
    ),
});

/**
 * One segment entry of the index; `bytes` and `count` are accounted values.
 */
const debugLogSegmentInfoSchema = v.strictObject({
    id: nonNegativeIntSchema,
    bytes: nonNegativeIntSchema,
    count: nonNegativeIntSchema,
    firstTsMs: epochMsSchema,
});

const debugLogDroppedSchema = v.strictObject({
    [DEBUG_LOG_DROP_REASON.Incognito]: nonNegativeIntSchema,
    [DEBUG_LOG_DROP_REASON.Coalesced]: nonNegativeIntSchema,
    [DEBUG_LOG_DROP_REASON.Ceiling]: nonNegativeIntSchema,
    [DEBUG_LOG_DROP_REASON.Unreachable]: nonNegativeIntSchema,
    [DEBUG_LOG_DROP_REASON.Lost]: nonNegativeIntSchema,
});

/**
 * Authoritative index: counters plus the ordered segment list; strict so a
 * foreign shape is dropped rather than merged.
 */
const debugLogIndexSchema = v.strictObject({
    version: v.literal(DEBUG_LOG_STORE_VERSION),
    enabledAtMs: v.nullable(epochMsSchema),
    disabledAtMs: v.nullable(epochMsSchema),
    eventCount: nonNegativeIntSchema,
    sizeBytes: nonNegativeIntSchema,
    evictedCount: nonNegativeIntSchema,
    oldestRetainedMs: v.nullable(epochMsSchema),
    dropped: debugLogDroppedSchema,
    revision: nonNegativeIntSchema,
    segments: v.array(debugLogSegmentInfoSchema),
    nextSegmentId: nonNegativeIntSchema,
    retiredSegmentIds: v.array(nonNegativeIntSchema),
});

/**
 * Persisted switch record.
 */
type DebugLogSwitchRecord = v.InferOutput<typeof debugLogSwitchSchema>;

/**
 * Persisted segment descriptor.
 */
type DebugLogSegmentInfo = v.InferOutput<typeof debugLogSegmentInfoSchema>;

/**
 * Persisted index.
 */
type DebugLogIndex = v.InferOutput<typeof debugLogIndexSchema>;

/**
 * In-memory lines of a segment that is open or not yet fully persisted;
 * `persistedCount` tracks how many leading lines storage already holds.
 */
type SegmentBuffer = {
    lines: string[];
    persistedCount: number;
};

/**
 * Open segment pair resolved for an append.
 */
type OpenSegment = {
    info: DebugLogSegmentInfo;
    buffer: SegmentBuffer;
};

/**
 * Lines collected for a read plus the repair performed for missing segments.
 */
type CollectedLines = {
    lines: string[];
    lostCount: number;
    lostBytes: number;
};

/**
 * Consistent point-in-time read used by export: the status describes exactly
 * the returned lines.
 */
export type DebugLogSnapshot = {
    lines: string[];
    status: DebugLogStatusPayload;
};

/**
 * Bounded tail for the Options preview.
 */
export type DebugLogPreview = {
    text: string;
    shownBytes: number;
    totalBytes: number;
    revision: number;
};

/**
 * Background-owned debug-log store: one switch record, one index and
 * newline-joined segments in `storage.local`, bounded by a 5 MiB accounted
 * ring with whole-segment eviction; appends are synchronous and persistence is
 * batched, chained and retried. Static API only.
 */
export class DebugLogStore {
    /**
     * Single-flight hydration; `null` until first use.
     */
    private static hydration: Promise<void> | null = null;

    /**
     * Chained writes keep an older batch from landing after a newer one.
     */
    private static persistence: Promise<void> = Promise.resolve();

    /**
     * Serializes enable/disable/seed so a repeated "on" cannot clear the log
     * the first "on" just started.
     */
    private static switching: Promise<unknown> = Promise.resolve();

    /**
     * Switch record; `null` until hydrated.
     */
    private static switchRecord: DebugLogSwitchRecord | null = null;

    /**
     * Bumped on every switch mutation; compared with the persisted generation
     * so a write that raced a mutation does not clear the dirty state.
     */
    private static switchGeneration = 0;

    /**
     * Generation the last successful write carried.
     */
    private static switchPersistedGeneration = 0;

    /**
     * Whether hydration found no switch decision while the profile default
     * is "on"; consumed once by the lifecycle, which then enables the log.
     */
    private static pendingDefaultEnable = false;

    /**
     * Index; `null` until hydrated.
     */
    private static index: DebugLogIndex | null = null;

    /**
     * Revision the last successful index write carried.
     */
    private static indexPersistedRevision = 0;

    /**
     * Lines of the open segment and of closed segments not yet persisted.
     */
    private static readonly buffers = new Map<number, SegmentBuffer>();

    /**
     * Id of the segment that receives appends; `null` until the first append.
     */
    private static openSegmentId: number | null = null;

    /**
     * Pending debounced flush.
     */
    private static flushTimer: ReturnType<typeof globalThis.setTimeout> | null =
        null;

    /**
     * Events accepted since the last flush was scheduled.
     */
    private static pendingEvents = 0;

    /**
     * Hydrates once (switch, index, open segment, orphan probe); never rejects.
     *
     * @param defaultEnabled - Profile default applied only while no switch
     * decision is persisted (tests pass it explicitly).
     * @returns Promise that settles once the store is usable.
     */
    static ready(defaultEnabled = DEBUG_LOG_DEFAULT_ENABLED): Promise<void> {
        DebugLogStore.hydration ??= DebugLogStore.hydrate(defaultEnabled);
        return DebugLogStore.hydration;
    }

    /**
     * Whether hydration has completed.
     *
     * @returns `true` once the switch record is in memory.
     */
    static isHydrated(): boolean {
        return DebugLogStore.switchRecord !== null;
    }

    /**
     * Whether events are currently accepted.
     *
     * @returns `true` only for a persisted or just-applied "on".
     */
    static isEnabled(): boolean {
        return DebugLogStore.switchRecord?.enabled === true;
    }

    /**
     * Hands the undecided-default signal to the lifecycle exactly once.
     *
     * @returns Whether the lifecycle must enable the log as a user "on" would.
     */
    static consumePendingDefaultEnable(): boolean {
        const pending = DebugLogStore.pendingDefaultEnable;
        DebugLogStore.pendingDefaultEnable = false;
        return pending;
    }

    /**
     * Cheap status for Options polls, the popup and the export header.
     *
     * @returns Counters, state and revision from memory (zeros before hydration).
     */
    static getStatus(): DebugLogStatusPayload {
        const enabled = DebugLogStore.isEnabled();
        const index = DebugLogStore.index;
        if (index === null) {
            return {
                enabled,
                hasLog: enabled,
                enabledAtMs: null,
                disabledAtMs: null,
                eventCount: 0,
                sizeBytes: 0,
                capBytes: DEBUG_LOG_CAP_BYTES,
                evictedCount: 0,
                oldestRetainedMs: null,
                dropped: DebugLogStore.zeroDropped(),
                revision: 0,
            };
        }
        return {
            enabled,
            hasLog: enabled || index.eventCount > 0,
            enabledAtMs: index.enabledAtMs,
            disabledAtMs: index.disabledAtMs,
            eventCount: index.eventCount,
            sizeBytes: index.sizeBytes,
            capBytes: DEBUG_LOG_CAP_BYTES,
            evictedCount: index.evictedCount,
            oldestRetainedMs: index.segments[0]?.firstTsMs ?? null,
            dropped: { ...index.dropped },
            revision: index.revision,
        };
    }

    /**
     * Whether a log exists for the issue-report hint (on, or off with events).
     *
     * @returns Promise of the hydrated `hasLog` flag.
     */
    static async hasLog(): Promise<boolean> {
        await DebugLogStore.ready();
        return DebugLogStore.getStatus().hasLog;
    }

    /**
     * Last build label persisted by a previous worker start.
     *
     * @returns Label or `null` when none was persisted.
     */
    static getLastBuildLabel(): string | null {
        return DebugLogStore.switchRecord?.lastBuildLabel ?? null;
    }

    /**
     * Persists the current build label on every worker start without deciding
     * the switch, so a later install/update can name the previous build.
     *
     * @param label - Current build label.
     * @returns Promise settled after the write attempt.
     */
    static async setLastBuildLabel(label: string): Promise<void> {
        await DebugLogStore.ready();
        const record = DebugLogStore.switchRecord;
        if (record === null || record.lastBuildLabel === label) {
            return;
        }
        record.lastBuildLabel = label;
        DebugLogStore.switchGeneration += 1;
        await DebugLogStore.flush();
    }

    /**
     * Accepts formatted lines synchronously (exact accounting, segment fill,
     * ring eviction) and schedules a batched flush; silently ignored while the
     * switch is off or before hydration.
     *
     * @param lines - Formatted event lines in emission order.
     * @param tsMs - Receipt time used as the first timestamp of a new segment.
     */
    static append(lines: readonly string[], tsMs = Date.now()): void {
        const index = DebugLogStore.index;
        if (!DebugLogStore.isEnabled() || index === null) {
            return;
        }
        for (const line of lines) {
            DebugLogStore.appendLine(index, line, tsMs);
        }
        DebugLogStore.scheduleFlush(lines.length);
    }

    /**
     * Counts events that were not stored, by reason.
     *
     * @param reason - Drop reason bucket.
     * @param count - Number of dropped events.
     */
    static noteDropped(reason: DebugLogDropReason, count = 1): void {
        const index = DebugLogStore.index;
        if (index === null || count <= 0) {
            return;
        }
        index.dropped[reason] += count;
        DebugLogStore.touchIndex(index);
        DebugLogStore.scheduleFlush(0);
    }

    /**
     * Turns the switch on: deletes every key of a stored log first, starts a
     * fresh index and persists the switch; idempotent and single-flight.
     *
     * @param nowMs - Enable time.
     * @param onEnabled - Invoked synchronously right after the switch flips so
     * the caller can append the `logging-enabled` marker as the first line.
     * @returns Status after the change.
     */
    static enable(
        nowMs: number,
        onEnabled?: () => void,
    ): Promise<DebugLogStatusPayload> {
        return DebugLogStore.runSwitching(() =>
            DebugLogStore.applyEnable(nowMs, onEnabled),
        );
    }

    /**
     * Turns the switch off and keeps the stored log; idempotent and
     * single-flight.
     *
     * @param nowMs - Disable time.
     * @param beforeDisable - Invoked synchronously right before the switch
     * flips so the caller can append the `logging-disabled` terminal marker.
     * @returns Status after the change.
     */
    static disable(
        nowMs: number,
        beforeDisable?: () => void,
    ): Promise<DebugLogStatusPayload> {
        return DebugLogStore.runSwitching(() =>
            DebugLogStore.applyDisable(nowMs, beforeDisable),
        );
    }

    /**
     * Writes the touched segments, the index and the switch through the
     * chained queue; failures keep the dirty state for the next batch.
     *
     * @returns Promise that always resolves after this write attempt.
     */
    static flush(): Promise<void> {
        const write = DebugLogStore.persistence.then(() =>
            DebugLogStore.writeBatch(),
        );
        DebugLogStore.persistence = write;
        return write;
    }

    /**
     * Reads every retained line in order together with the status that
     * describes exactly those lines; closed segments found missing are
     * counted as lost and dropped from the index.
     *
     * @returns Immutable snapshot for export.
     */
    static async readSnapshot(): Promise<DebugLogSnapshot> {
        await DebugLogStore.ready();
        await DebugLogStore.switching;
        await DebugLogStore.flush();
        const index = DebugLogStore.index;
        const status = DebugLogStore.getStatus();
        if (index === null) {
            return { lines: [], status };
        }
        const collected = await DebugLogStore.collectLines(index, [
            ...index.segments,
        ]);
        return {
            lines: collected.lines,
            status: DebugLogStore.applyLoss(status, collected),
        };
    }

    /**
     * Reads only the newest segments that cover the requested tail.
     *
     * @param maxBytes - Tail bound in bytes.
     * @returns Tail text, its size, the total accounted size and the revision.
     */
    static async readPreview(maxBytes: number): Promise<DebugLogPreview> {
        await DebugLogStore.ready();
        await DebugLogStore.switching;
        await DebugLogStore.flush();
        const index = DebugLogStore.index;
        const status = DebugLogStore.getStatus();
        if (index === null) {
            return { text: '', shownBytes: 0, totalBytes: 0, revision: 0 };
        }
        const tail: DebugLogSegmentInfo[] = [];
        let bytes = 0;
        for (let i = index.segments.length - 1; i >= 0 && bytes < maxBytes; i -= 1) {
            const info = index.segments[i];
            tail.unshift(info);
            bytes += info.bytes;
        }
        const collected = await DebugLogStore.collectLines(index, tail);
        const adjusted = DebugLogStore.applyLoss(status, collected);
        const text =
            collected.lines.length === 0 ? '' : `${collected.lines.join('\n')}\n`;
        const slice = sliceDebugLogTail(text, maxBytes);
        return {
            text: slice.text,
            shownBytes: slice.shownBytes,
            totalBytes: adjusted.sizeBytes,
            revision: adjusted.revision,
        };
    }

    /**
     * Dev-only replacement of the whole store with a chosen state or size; the
     * dev gate lives in the runtime-message handler.
     *
     * @param input - Desired state and approximate accounted size.
     * @param nowMs - Seed time.
     * @returns Promise settled after the seed is persisted.
     */
    static seed(input: DevSeedDebugLogPayload, nowMs: number): Promise<void> {
        return DebugLogStore.runSwitching(() =>
            DebugLogStore.applySeed(input, nowMs),
        );
    }

    /**
     * Clears all static state between tests.
     */
    static resetForTest(): void {
        DebugLogStore.clearFlushTimer();
        DebugLogStore.hydration = null;
        DebugLogStore.persistence = Promise.resolve();
        DebugLogStore.switching = Promise.resolve();
        DebugLogStore.switchRecord = null;
        DebugLogStore.switchGeneration = 0;
        DebugLogStore.switchPersistedGeneration = 0;
        DebugLogStore.pendingDefaultEnable = false;
        DebugLogStore.index = null;
        DebugLogStore.indexPersistedRevision = 0;
        DebugLogStore.buffers.clear();
        DebugLogStore.openSegmentId = null;
        DebugLogStore.pendingEvents = 0;
    }

    /**
     * Runs one switch mutation after every earlier one has settled.
     *
     * @param task - Mutation to serialize.
     * @returns The mutation's own result.
     */
    private static runSwitching<T>(task: () => Promise<T>): Promise<T> {
        const run = DebugLogStore.switching.then(task, task);
        DebugLogStore.switching = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    /**
     * Deletes the stored log's keys before the fresh log's first write, then
     * flips the switch and lets the caller place the first marker.
     *
     * @param nowMs - Enable time.
     * @param onEnabled - Marker hook invoked right after the flip.
     * @returns Status after the change.
     */
    private static async applyEnable(
        nowMs: number,
        onEnabled: (() => void) | undefined,
    ): Promise<DebugLogStatusPayload> {
        await DebugLogStore.ready();
        const record = DebugLogStore.switchRecord;
        const current = DebugLogStore.index;
        if (record === null || current === null || record.enabled === true) {
            return DebugLogStore.getStatus();
        }
        DebugLogStore.clearFlushTimer();
        DebugLogStore.pendingEvents = 0;
        await DebugLogStore.persistence;
        const staleIds = [
            ...current.segments.map((segment) => segment.id),
            ...current.retiredSegmentIds,
        ];
        DebugLogStore.buffers.clear();
        DebugLogStore.openSegmentId = null;
        const retired = await DebugLogStore.removeSegments(staleIds);
        DebugLogStore.index = DebugLogStore.freshIndex(
            nowMs,
            current.revision + 1,
            current.nextSegmentId,
            retired,
        );
        record.enabled = true;
        DebugLogStore.switchGeneration += 1;
        onEnabled?.();
        await DebugLogStore.flush();
        return DebugLogStore.getStatus();
    }

    /**
     * Flips the switch off right after the caller's terminal marker and
     * persists everything that is pending.
     *
     * @param nowMs - Disable time.
     * @param beforeDisable - Marker hook invoked right before the flip.
     * @returns Status after the change.
     */
    private static async applyDisable(
        nowMs: number,
        beforeDisable: (() => void) | undefined,
    ): Promise<DebugLogStatusPayload> {
        await DebugLogStore.ready();
        const record = DebugLogStore.switchRecord;
        const current = DebugLogStore.index;
        if (record === null || current === null || record.enabled !== true) {
            return DebugLogStore.getStatus();
        }
        beforeDisable?.();
        record.enabled = false;
        DebugLogStore.switchGeneration += 1;
        current.disabledAtMs = nowMs;
        DebugLogStore.touchIndex(current);
        DebugLogStore.clearFlushTimer();
        await DebugLogStore.flush();
        return DebugLogStore.getStatus();
    }

    /**
     * Replaces the store for dev/E2E: removes old segments, builds synthetic
     * segments of the requested size and persists the chosen switch state.
     *
     * @param input - Desired state and approximate size.
     * @param nowMs - Seed time.
     * @returns Promise settled after persistence.
     */
    private static async applySeed(
        input: DevSeedDebugLogPayload,
        nowMs: number,
    ): Promise<void> {
        await DebugLogStore.ready();
        const record = DebugLogStore.switchRecord;
        const current = DebugLogStore.index;
        if (record === null || current === null) {
            return;
        }
        DebugLogStore.clearFlushTimer();
        DebugLogStore.pendingEvents = 0;
        await DebugLogStore.persistence;
        const staleIds = [
            ...current.segments.map((segment) => segment.id),
            ...current.retiredSegmentIds,
        ];
        DebugLogStore.buffers.clear();
        DebugLogStore.openSegmentId = null;
        const retired = await DebugLogStore.removeSegments(staleIds);
        const revision = current.revision + 1;
        DebugLogStore.switchGeneration += 1;

        if (input.state === DEV_DEBUG_LOG_SEED_STATE.OffEmpty) {
            record.enabled = false;
            const empty = DebugLogStore.freshIndex(
                null,
                revision,
                current.nextSegmentId,
                retired,
            );
            DebugLogStore.index = empty;
            // "No log" means no index key at all; the in-memory index only
            // carries the retired ids until they are removed.
            DebugLogStore.indexPersistedRevision = revision;
            try {
                await browser.storage.local.remove(STORAGE_KEY_DEBUG_LOG_INDEX);
            } catch {
                // Best effort; hydration treats a stale index like any other.
            }
            await DebugLogStore.flush();
            return;
        }

        const target = Math.min(
            input.approxBytes ?? SEED_DEFAULT_BYTES,
            DEBUG_LOG_CAP_BYTES,
        );
        const count = DebugLogStore.seedLineCount(nowMs, target);
        const firstTsMs = nowMs - count * SEED_EVENT_SPACING_MS;
        const seeded = DebugLogStore.freshIndex(
            firstTsMs,
            revision,
            current.nextSegmentId,
            retired,
        );
        DebugLogStore.index = seeded;
        for (let seq = 1; seq <= count; seq += 1) {
            const tsMs = firstTsMs + seq * SEED_EVENT_SPACING_MS;
            const line = DebugLogStore.seedLine(tsMs, seq);
            DebugLogStore.placeLine(seeded, line, utf8ByteLength(line) + 1, tsMs);
        }
        if (input.state === DEV_DEBUG_LOG_SEED_STATE.OffStored) {
            record.enabled = false;
            seeded.disabledAtMs = nowMs;
        } else {
            record.enabled = true;
        }
        DebugLogStore.touchIndex(seeded);
        await DebugLogStore.flush();
    }

    /**
     * Counts how many synthetic lines reach the requested size. Timestamps
     * have a fixed width, so the count measured with `nowMs` holds for the
     * back-dated lines placed afterwards.
     *
     * @param nowMs - Seed time.
     * @param targetBytes - Requested accounted size.
     * @returns Number of lines whose accounted size first reaches the target.
     */
    private static seedLineCount(nowMs: number, targetBytes: number): number {
        let bytes = 0;
        let count = 0;
        while (bytes < targetBytes) {
            count += 1;
            bytes += utf8ByteLength(DebugLogStore.seedLine(nowMs, count)) + 1;
        }
        return count;
    }

    /**
     * One synthetic line for seeding; a real event name keeps the allow-list
     * true even for synthetic data.
     *
     * @param tsMs - Line timestamp.
     * @param seq - Sequence number.
     * @returns Formatted line.
     */
    private static seedLine(tsMs: number, seq: number): string {
        return formatDebugLogLine({
            tsMs,
            worker: SEED_WORKER_ID,
            seq,
            src: DEBUG_LOG_SOURCE.Background,
            event: DEBUG_LOG_EVENT.CacheDecision,
            fields: { decision: SEED_DECISION, count: seq },
        });
    }

    /**
     * Applies the memory-tail and line-size bounds before placing a line.
     *
     * @param index - Live index.
     * @param line - Formatted line.
     * @param tsMs - Receipt time.
     */
    private static appendLine(
        index: DebugLogIndex,
        line: string,
        tsMs: number,
    ): void {
        const bytes = utf8ByteLength(line) + 1;
        const tailFull =
            DebugLogStore.unflushedLineCount() >= DEBUG_LOG_MEMORY_TAIL_LIMIT;
        if (bytes > DEBUG_LOG_MAX_LINE_BYTES || tailFull) {
            index.dropped[DEBUG_LOG_DROP_REASON.Lost] += 1;
            DebugLogStore.touchIndex(index);
            return;
        }
        DebugLogStore.placeLine(index, line, bytes, tsMs);
    }

    /**
     * Puts one line into the open segment (rolling at the segment bound),
     * updates the exact accounting and evicts whole oldest segments until the
     * cap holds again.
     *
     * @param index - Live index.
     * @param line - Formatted line.
     * @param bytes - Accounted size of the line (UTF-8 + newline).
     * @param tsMs - Receipt time.
     */
    private static placeLine(
        index: DebugLogIndex,
        line: string,
        bytes: number,
        tsMs: number,
    ): void {
        let open = DebugLogStore.currentOpenSegment(index);
        if (open === null || open.info.bytes + bytes > DEBUG_LOG_SEGMENT_MAX_BYTES) {
            open = DebugLogStore.openSegment(index, tsMs);
        }
        open.buffer.lines.push(line);
        open.info.bytes += bytes;
        open.info.count += 1;
        index.sizeBytes += bytes;
        index.eventCount += 1;
        DebugLogStore.evictToFit(index);
        DebugLogStore.touchIndex(index);
    }

    /**
     * Resolves the open segment, or `null` when a new one must be started.
     *
     * @param index - Live index.
     * @returns Open segment info and buffer.
     */
    private static currentOpenSegment(index: DebugLogIndex): OpenSegment | null {
        const id = DebugLogStore.openSegmentId;
        if (id === null) {
            return null;
        }
        const info = index.segments[index.segments.length - 1];
        const buffer = DebugLogStore.buffers.get(id);
        if (info === undefined || info.id !== id || buffer === undefined) {
            return null;
        }
        return { info, buffer };
    }

    /**
     * Starts a new open segment with the next id.
     *
     * @param index - Live index.
     * @param tsMs - Timestamp of the first line.
     * @returns The new open segment.
     */
    private static openSegment(index: DebugLogIndex, tsMs: number): OpenSegment {
        const id = index.nextSegmentId;
        index.nextSegmentId += 1;
        const info: DebugLogSegmentInfo = { id, bytes: 0, count: 0, firstTsMs: tsMs };
        const buffer: SegmentBuffer = { lines: [], persistedCount: 0 };
        index.segments.push(info);
        DebugLogStore.buffers.set(id, buffer);
        DebugLogStore.openSegmentId = id;
        return { info, buffer };
    }

    /**
     * Whole-segment eviction: the open segment is never evicted, and segment
     * size stays far below the cap, so the loop always terminates.
     *
     * @param index - Live index.
     */
    private static evictToFit(index: DebugLogIndex): void {
        while (index.sizeBytes > DEBUG_LOG_CAP_BYTES && index.segments.length > 1) {
            const oldest = index.segments.shift();
            if (oldest === undefined) {
                return;
            }
            index.sizeBytes -= oldest.bytes;
            index.eventCount -= oldest.count;
            index.evictedCount += oldest.count;
            DebugLogStore.buffers.delete(oldest.id);
            index.retiredSegmentIds.push(oldest.id);
        }
    }

    /**
     * Lines accepted but not yet confirmed by storage.
     *
     * @returns Count across all buffered segments.
     */
    private static unflushedLineCount(): number {
        let count = 0;
        for (const buffer of DebugLogStore.buffers.values()) {
            count += buffer.lines.length - buffer.persistedCount;
        }
        return count;
    }

    /**
     * Marks an index change: the revision drives persistence and the Options
     * preview refresh, and the oldest retained timestamp follows eviction.
     *
     * @param index - Live index.
     */
    private static touchIndex(index: DebugLogIndex): void {
        index.revision += 1;
        index.oldestRetainedMs = index.segments[0]?.firstTsMs ?? null;
    }

    /**
     * Debounces writes, flushing early when a burst is large.
     *
     * @param count - Events accepted by the caller.
     */
    private static scheduleFlush(count: number): void {
        DebugLogStore.pendingEvents += count;
        if (DebugLogStore.pendingEvents >= DEBUG_LOG_FLUSH_MAX_PENDING_EVENTS) {
            DebugLogStore.pendingEvents = 0;
            DebugLogStore.clearFlushTimer();
            void DebugLogStore.flush();
            return;
        }
        if (DebugLogStore.flushTimer !== null) {
            return;
        }
        DebugLogStore.flushTimer = globalThis.setTimeout(() => {
            DebugLogStore.flushTimer = null;
            void DebugLogStore.flush();
        }, DEBUG_LOG_FLUSH_DEBOUNCE_MS);
    }

    /**
     * Cancels a pending debounced flush.
     */
    private static clearFlushTimer(): void {
        if (DebugLogStore.flushTimer !== null) {
            globalThis.clearTimeout(DebugLogStore.flushTimer);
            DebugLogStore.flushTimer = null;
        }
    }

    /**
     * One batched write: touched segments + index (+ switch) in a single `set`,
     * then removal of retired keys. A failed `set` leaves everything dirty for
     * the next batch and never prints to the console.
     *
     * @returns Promise that always resolves.
     */
    private static async writeBatch(): Promise<void> {
        DebugLogStore.clearFlushTimer();
        DebugLogStore.pendingEvents = 0;
        const index = DebugLogStore.index;
        const record = DebugLogStore.switchRecord;
        if (index === null || record === null) {
            return;
        }
        const items: Record<string, unknown> = {};
        const planned: { id: number; count: number }[] = [];
        for (const [id, buffer] of DebugLogStore.buffers) {
            if (buffer.lines.length > buffer.persistedCount) {
                items[DebugLogStore.segmentKey(id)] = buffer.lines.join('\n');
                planned.push({ id, count: buffer.lines.length });
            }
        }
        const revision = index.revision;
        const writeIndex =
            planned.length > 0 || revision !== DebugLogStore.indexPersistedRevision;
        if (writeIndex) {
            items[STORAGE_KEY_DEBUG_LOG_INDEX] = structuredClone(index);
        }
        const generation = DebugLogStore.switchGeneration;
        const writeSwitch = generation !== DebugLogStore.switchPersistedGeneration;
        if (writeSwitch) {
            items[STORAGE_KEY_DEBUG_LOG_SWITCH] = structuredClone(record);
        }
        if (Object.keys(items).length > 0) {
            try {
                await browser.storage.local.set(items);
            } catch {
                return;
            }
            for (const { id, count } of planned) {
                const buffer = DebugLogStore.buffers.get(id);
                if (buffer !== undefined) {
                    buffer.persistedCount = Math.max(buffer.persistedCount, count);
                }
            }
            if (writeIndex) {
                DebugLogStore.indexPersistedRevision = revision;
            }
            if (writeSwitch) {
                DebugLogStore.switchPersistedGeneration = generation;
            }
        }
        DebugLogStore.releasePersistedClosedBuffers();
        const retired = [...index.retiredSegmentIds];
        if (retired.length === 0) {
            return;
        }
        const remaining = await DebugLogStore.removeSegments(retired);
        if (remaining.length !== retired.length) {
            const keep = new Set(remaining);
            index.retiredSegmentIds = index.retiredSegmentIds.filter((id) =>
                keep.has(id),
            );
        }
    }

    /**
     * Drops closed segments from memory once storage holds every line: a
     * segment that filled up while open is otherwise never re-planned, so it
     * would stay buffered for the life of the worker and an export would read
     * it from memory instead of verifying the stored copy.
     */
    private static releasePersistedClosedBuffers(): void {
        for (const [id, buffer] of DebugLogStore.buffers) {
            const closed = id !== DebugLogStore.openSegmentId;
            if (closed && buffer.persistedCount >= buffer.lines.length) {
                DebugLogStore.buffers.delete(id);
            }
        }
    }

    /**
     * Removes segment keys; ids that could not be removed are returned so the
     * caller keeps them retired for a later retry.
     *
     * @param ids - Segment ids to delete.
     * @returns Ids still awaiting removal.
     */
    private static async removeSegments(ids: readonly number[]): Promise<number[]> {
        if (ids.length === 0) {
            return [];
        }
        try {
            await browser.storage.local.remove(
                ids.map((id) => DebugLogStore.segmentKey(id)),
            );
            return [];
        } catch {
            return [...ids];
        }
    }

    /**
     * Reads segments in order: buffered ones from memory (captured before any
     * await), the rest from storage; a referenced segment that is missing or
     * invalid is dropped from the index and counted as lost.
     *
     * @param index - Live index.
     * @param infos - Segments to read, oldest first.
     * @returns Lines plus the loss applied to the index.
     */
    private static async collectLines(
        index: DebugLogIndex,
        infos: readonly DebugLogSegmentInfo[],
    ): Promise<CollectedLines> {
        const buffered = infos.map((info) => {
            const buffer = DebugLogStore.buffers.get(info.id);
            return buffer === undefined ? null : [...buffer.lines];
        });
        const keys = infos
            .filter((_info, position) => buffered[position] === null)
            .map((info) => DebugLogStore.segmentKey(info.id));
        const stored: Record<string, unknown> =
            keys.length === 0 ? {} : await browser.storage.local.get(keys);
        const result: CollectedLines = { lines: [], lostCount: 0, lostBytes: 0 };
        infos.forEach((info, position) => {
            const part = buffered[position];
            if (part !== null) {
                result.lines.push(...part);
                return;
            }
            const raw = Reflect.get(stored, DebugLogStore.segmentKey(info.id));
            if (typeof raw === 'string' && raw.length > 0) {
                result.lines.push(...raw.split('\n'));
                return;
            }
            DebugLogStore.dropMissingSegment(index, info);
            result.lostCount += info.count;
            result.lostBytes += info.bytes;
        });
        return result;
    }

    /**
     * Repairs the index after a referenced segment turned out to be missing.
     *
     * @param index - Live index.
     * @param info - Missing segment.
     */
    private static dropMissingSegment(
        index: DebugLogIndex,
        info: DebugLogSegmentInfo,
    ): void {
        const position = index.segments.findIndex((s) => s.id === info.id);
        if (position === -1) {
            return;
        }
        index.segments.splice(position, 1);
        index.sizeBytes -= info.bytes;
        index.eventCount -= info.count;
        index.dropped[DEBUG_LOG_DROP_REASON.Lost] += info.count;
        index.retiredSegmentIds.push(info.id);
        if (DebugLogStore.openSegmentId === info.id) {
            DebugLogStore.openSegmentId = null;
            DebugLogStore.buffers.delete(info.id);
        }
        DebugLogStore.touchIndex(index);
        DebugLogStore.scheduleFlush(0);
    }

    /**
     * Rewrites a status captured before a read so it describes the lines that
     * were actually returned.
     *
     * @param status - Status captured synchronously with the lines.
     * @param collected - Read result including the repair.
     * @returns Adjusted status.
     */
    private static applyLoss(
        status: DebugLogStatusPayload,
        collected: CollectedLines,
    ): DebugLogStatusPayload {
        if (collected.lostCount === 0) {
            return status;
        }
        const index = DebugLogStore.index;
        return {
            ...status,
            eventCount: status.eventCount - collected.lostCount,
            sizeBytes: status.sizeBytes - collected.lostBytes,
            oldestRetainedMs: index?.segments[0]?.firstTsMs ?? null,
            dropped: {
                ...status.dropped,
                [DEBUG_LOG_DROP_REASON.Lost]:
                    status.dropped[DEBUG_LOG_DROP_REASON.Lost] + collected.lostCount,
            },
            revision: index?.revision ?? status.revision,
        };
    }

    /**
     * Reads the switch and index, continues the open segment when logging is
     * on, and repairs the one possible orphan plus retired keys; every failure
     * degrades to memory-only defaults without a console line.
     *
     * @param defaultEnabled - Profile default for an undecided switch.
     * @returns Promise that always resolves.
     */
    private static async hydrate(defaultEnabled: boolean): Promise<void> {
        let stored: Record<string, unknown>;
        try {
            await BackgroundStorageAccess.ready();
            stored = await browser.storage.local.get([
                STORAGE_KEY_DEBUG_LOG_SWITCH,
                STORAGE_KEY_DEBUG_LOG_INDEX,
            ]);
        } catch {
            stored = {};
        }
        const switchParsed = v.safeParse(
            debugLogSwitchSchema,
            Reflect.get(stored, STORAGE_KEY_DEBUG_LOG_SWITCH),
        );
        const record: DebugLogSwitchRecord = switchParsed.success
            ? switchParsed.output
            : { version: DEBUG_LOG_STORE_VERSION, enabled: null, lastBuildLabel: null };
        DebugLogStore.pendingDefaultEnable = record.enabled === null && defaultEnabled;
        const indexParsed = v.safeParse(
            debugLogIndexSchema,
            Reflect.get(stored, STORAGE_KEY_DEBUG_LOG_INDEX),
        );
        const index = indexParsed.success
            ? indexParsed.output
            : DebugLogStore.freshIndex(
                    record.enabled === true ? Date.now() : null,
                    0,
                    0,
                    [],
                );
        DebugLogStore.indexPersistedRevision = index.revision;
        DebugLogStore.switchGeneration = 0;
        DebugLogStore.switchPersistedGeneration = 0;
        DebugLogStore.switchRecord = record;
        DebugLogStore.index = index;
        if (record.enabled === true) {
            await DebugLogStore.loadTail(index);
        }
        await DebugLogStore.repairOrphans(index);
    }

    /**
     * Continues the open segment of an enabled log; a missing or invalid tail
     * is counted as lost, a size mismatch is corrected from the stored text.
     *
     * @param index - Hydrated index.
     * @returns Promise that always resolves.
     */
    private static async loadTail(index: DebugLogIndex): Promise<void> {
        const last = index.segments[index.segments.length - 1];
        if (last === undefined) {
            return;
        }
        const key = DebugLogStore.segmentKey(last.id);
        let raw: unknown;
        try {
            const result = await browser.storage.local.get(key);
            raw = Reflect.get(result, key);
        } catch {
            return;
        }
        if (typeof raw !== 'string' || raw.length === 0) {
            DebugLogStore.dropMissingSegment(index, last);
            return;
        }
        const lines = raw.split('\n');
        const bytes = lines.reduce((sum, line) => sum + utf8ByteLength(line) + 1, 0);
        if (bytes !== last.bytes || lines.length !== last.count) {
            index.sizeBytes += bytes - last.bytes;
            index.eventCount += lines.length - last.count;
            last.bytes = bytes;
            last.count = lines.length;
            DebugLogStore.touchIndex(index);
        }
        DebugLogStore.buffers.set(last.id, { lines, persistedCount: lines.length });
        DebugLogStore.openSegmentId = last.id;
    }

    /**
     * A worker that died between writing a new segment and its index leaves
     * exactly the key `segment:<nextSegmentId>`; it is retired (and the id
     * skipped so a new segment can never be clobbered by the retry). Retired
     * keys from earlier evictions are removed now.
     *
     * @param index - Hydrated index.
     * @returns Promise that always resolves.
     */
    private static async repairOrphans(index: DebugLogIndex): Promise<void> {
        const orphanId = index.nextSegmentId;
        const orphanKey = DebugLogStore.segmentKey(orphanId);
        try {
            const result = await browser.storage.local.get(orphanKey);
            if (Reflect.get(result, orphanKey) !== undefined) {
                index.retiredSegmentIds.push(orphanId);
                index.nextSegmentId += 1;
                DebugLogStore.touchIndex(index);
            }
        } catch {
            // Probe failed: nothing to repair now.
        }
        if (index.retiredSegmentIds.length === 0) {
            return;
        }
        const retired = [...index.retiredSegmentIds];
        const remaining = await DebugLogStore.removeSegments(retired);
        if (remaining.length !== retired.length) {
            const keep = new Set(remaining);
            index.retiredSegmentIds = index.retiredSegmentIds.filter((id) =>
                keep.has(id),
            );
            DebugLogStore.touchIndex(index);
        }
    }

    /**
     * Empty index for a fresh log.
     *
     * @param enabledAtMs - Enable time, or `null` while off with no log.
     * @param revision - Revision to start from (monotonic across clears).
     * @param nextSegmentId - Continues ids so retired keys are never reused.
     * @param retiredSegmentIds - Keys still awaiting removal.
     * @returns New index.
     */
    private static freshIndex(
        enabledAtMs: number | null,
        revision: number,
        nextSegmentId: number,
        retiredSegmentIds: number[],
    ): DebugLogIndex {
        return {
            version: DEBUG_LOG_STORE_VERSION,
            enabledAtMs,
            disabledAtMs: null,
            eventCount: 0,
            sizeBytes: 0,
            evictedCount: 0,
            oldestRetainedMs: null,
            dropped: DebugLogStore.zeroDropped(),
            revision,
            segments: [],
            nextSegmentId,
            retiredSegmentIds,
        };
    }

    /**
     * All drop counters at zero.
     *
     * @returns Fresh counters object.
     */
    private static zeroDropped(): DebugLogIndex['dropped'] {
        return {
            [DEBUG_LOG_DROP_REASON.Incognito]: 0,
            [DEBUG_LOG_DROP_REASON.Coalesced]: 0,
            [DEBUG_LOG_DROP_REASON.Ceiling]: 0,
            [DEBUG_LOG_DROP_REASON.Unreachable]: 0,
            [DEBUG_LOG_DROP_REASON.Lost]: 0,
        };
    }

    /**
     * Storage key of one segment.
     *
     * @param id - Segment id.
     * @returns Key under the debug-log prefix.
     */
    private static segmentKey(id: number): string {
        return `${STORAGE_KEY_DEBUG_LOG_SEGMENT_PREFIX}${id}`;
    }
}
