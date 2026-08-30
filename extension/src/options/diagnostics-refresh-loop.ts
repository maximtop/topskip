import { OPTIONS_DIAGNOSTICS_REFRESH_MS } from '@/options/constants';
import {
    requestDebugLogPreview,
    requestDebugLogStatus,
    type DebugLogPreviewResult,
} from '@/options/diagnostics-request';
import { shouldRefetchPreview } from '@/options/diagnostics-state';
import type { DebugLogStatusPayload } from '@/shared/messages';

/**
 * Receives loop outcomes; the React container maps them onto state.
 * `onPreview(null)` means no log is stored, so any shown tail must go.
 */
export type DiagnosticsRefreshSink = {
    onStatus(status: DebugLogStatusPayload): void;
    onPreview(preview: DebugLogPreviewResult | null): void;
    onUnavailable(): void;
};

/**
 * Background reads the loop performs; injected by tests so the cadence can be
 * driven with fake timers and scripted replies.
 */
export type DiagnosticsRefreshReads = {
    requestStatus(): Promise<DebugLogStatusPayload>;
    requestPreview(): Promise<DebugLogPreviewResult>;
};

const DEFAULT_READS: DiagnosticsRefreshReads = {
    requestStatus: requestDebugLogStatus,
    requestPreview: requestDebugLogPreview,
};

/**
 * Polls the cheap debug-log status at the bounded cadence while the
 * Diagnostics section is visible, re-reads the preview tail only when the
 * store revision moved, and coalesces an explicit refresh (state push, retry,
 * toggle) with a read already in flight. Reads are never logged as events
 * and never carry the bundle.
 */
export class DiagnosticsRefreshLoop {
    /**
     * Loop outcomes are delivered here; the container maps them onto state.
     */
    private readonly sink: DiagnosticsRefreshSink;

    /**
     * Status and preview reads; the defaults talk to the worker.
     */
    private readonly reads: DiagnosticsRefreshReads;

    /**
     * `stop()` makes every later completion a no-op (the section left view).
     */
    private stopped = false;

    /**
     * One read at a time; an explicit refresh during a read is coalesced.
     */
    private inFlight = false;

    /**
     * A refresh requested while a read was in flight runs right after it.
     */
    private followUpQueued = false;

    /**
     * Pending cadence timer; cleared on stop and on an explicit refresh.
     */
    private timerId: ReturnType<typeof globalThis.setTimeout> | null = null;

    /**
     * Revision of the last preview handed to the sink; `null` before the
     * first (or after the log was cleared).
     */
    private previewRevision: number | null = null;

    /**
     * Creates an idle loop; nothing runs until `refreshNow()`.
     *
     * @param sink - Outcome receiver.
     * @param reads - Worker reads (tests inject fakes).
     */
    constructor(
        sink: DiagnosticsRefreshSink,
        reads: DiagnosticsRefreshReads = DEFAULT_READS,
    ) {
        this.sink = sink;
        this.reads = reads;
    }

    /**
     * Runs one read now (coalesced if one is in flight) and keeps the cadence
     * going afterwards.
     */
    refreshNow(): void {
        if (this.stopped) {
            return;
        }
        this.clearTimer();
        if (this.inFlight) {
            this.followUpQueued = true;
            return;
        }
        void this.runRead();
    }

    /**
     * Ends the cadence; in-flight completions are dropped.
     */
    stop(): void {
        this.stopped = true;
        this.clearTimer();
    }

    /**
     * One status read followed, when the revision moved, by one preview read.
     *
     * @returns Resolves when the read and its scheduling are done.
     */
    private async runRead(): Promise<void> {
        this.inFlight = true;
        try {
            const status = await this.reads.requestStatus();
            if (this.stopped) {
                return;
            }
            this.sink.onStatus(status);
            if (!status.hasLog) {
                this.previewRevision = null;
                this.sink.onPreview(null);
            } else if (
                shouldRefetchPreview(this.previewRevision, status.revision)
            ) {
                const preview = await this.reads.requestPreview();
                if (this.stopped) {
                    return;
                }
                this.previewRevision = preview.revision;
                this.sink.onPreview(preview);
            }
        } catch {
            if (!this.stopped) {
                this.sink.onUnavailable();
            }
        } finally {
            this.inFlight = false;
            this.scheduleNext();
        }
    }

    /**
     * Runs the queued follow-up immediately, otherwise waits one cadence.
     */
    private scheduleNext(): void {
        if (this.stopped) {
            return;
        }
        if (this.followUpQueued) {
            this.followUpQueued = false;
            void this.runRead();
            return;
        }
        this.timerId = globalThis.setTimeout(() => {
            this.timerId = null;
            void this.runRead();
        }, OPTIONS_DIAGNOSTICS_REFRESH_MS);
    }

    /**
     * Drops the pending cadence timer, if any.
     */
    private clearTimer(): void {
        if (this.timerId !== null) {
            globalThis.clearTimeout(this.timerId);
            this.timerId = null;
        }
    }
}
