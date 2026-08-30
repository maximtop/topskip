import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { contentLogInfo, sendMessage } = vi.hoisted(() => ({
    contentLogInfo: vi.fn(),
    sendMessage: vi.fn<(message: unknown) => Promise<unknown>>(),
}));

vi.mock('@/shared/browser', () => ({
    default: { runtime: { sendMessage } },
}));

vi.mock('@/content/content-log', () => ({
    contentLog: { info: contentLogInfo, warn: vi.fn(), error: vi.fn() },
}));

import {
    DEBUG_LOG_SEEK_KIND,
    DebugLogClient,
} from '@/content/debug-log-client';
import { MS_PER_SECOND } from '@/shared/constants';
import {
    DEBUG_LOG_APPEND_MAX_EVENTS,
    DEBUG_LOG_CEILING_WINDOW_MS,
    DEBUG_LOG_CLIENT_FLUSH_DELAY_MS,
    DEBUG_LOG_CLIENT_PRESTATE_QUEUE_LIMIT,
    DEBUG_LOG_CLIENT_QUEUE_LIMIT,
    DEBUG_LOG_CLIENT_UNREACHABLE_BACKOFF_MS,
    DEBUG_LOG_CONTENT_EVENTS_PER_TAB_PER_MINUTE,
    DEBUG_LOG_MAX_FIELD_STRING_LENGTH,
    DEBUG_LOG_SEEK_EVENTS_PER_SECOND,
} from '@/shared/debug-log-constants';
import { DEBUG_LOG_EVENT, roundLogSeconds } from '@/shared/debug-log-events';
import { TOPSKIP_MESSAGE } from '@/shared/messages';

const VIDEO_ID = 'dQw4w9WgXcQ';
const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const DEV_CONSOLE_PREFIX = '[TopSkip debug-log]';
// `expect.any` is typed `any`; widening it to `unknown` keeps the expected
// payload literal free of unsafe-assignment errors.
const ANY_NUMBER: unknown = expect.any(Number);

type SentBatch = {
    events: Array<Record<string, unknown>>;
    dropped: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readProperty(value: unknown, key: string): unknown {
    return isRecord(value) ? value[key] : undefined;
}

function sentBatches(): SentBatch[] {
    return sendMessage.mock.calls.map(([message]) => {
        const payload = readProperty(message, 'payload');
        const events = readProperty(payload, 'events');
        const dropped = readProperty(payload, 'dropped');
        return {
            events: Array.isArray(events) ? events.filter(isRecord) : [],
            dropped: isRecord(dropped) ? dropped : {},
        };
    });
}

function sentEvents(): Array<Record<string, unknown>> {
    return sentBatches().flatMap((batch) => batch.events);
}

function sumDropped(key: string): number {
    return sentBatches().reduce((total, batch) => {
        const value = batch.dropped[key];
        return total + (typeof value === 'number' ? value : 0);
    }, 0);
}

async function flushClient(): Promise<void> {
    await vi.advanceTimersByTimeAsync(DEBUG_LOG_CLIENT_FLUSH_DELAY_MS);
}

async function drainClient(): Promise<void> {
    for (let round = 0; round < 16; round += 1) {
        await flushClient();
    }
}

describe('DebugLogClient', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        DebugLogClient.resetForTest();
        contentLogInfo.mockReset();
        sendMessage.mockReset();
        sendMessage.mockResolvedValue({ ok: true, enabled: true });
    });

    afterEach(() => {
        DebugLogClient.resetForTest();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('keeps bootstrap events until the state is known, then flushes them once', async () => {
        DebugLogClient.log(DEBUG_LOG_EVENT.PrefsReceived, { reason: 'bootstrap' });
        DebugLogClient.log(DEBUG_LOG_EVENT.VideoBound, {}, { video: VIDEO_ID });
        await drainClient();
        expect(sendMessage).not.toHaveBeenCalled();
        expect(DebugLogClient.isEnabled()).toBeNull();

        DebugLogClient.applyState(true);
        await flushClient();

        expect(sendMessage).toHaveBeenCalledOnce();
        expect(sendMessage).toHaveBeenCalledWith({
            type: TOPSKIP_MESSAGE.DEBUG_LOG_APPEND,
            payload: {
                events: [
                    {
                        event: DEBUG_LOG_EVENT.PrefsReceived,
                        ageMs: ANY_NUMBER,
                        fields: { reason: 'bootstrap' },
                    },
                    {
                        event: DEBUG_LOG_EVENT.VideoBound,
                        ageMs: ANY_NUMBER,
                        video: VIDEO_ID,
                        fields: {},
                    },
                ],
                dropped: { coalesced: 0, ceiling: 0, unreachable: 0 },
            },
        });
        expect(DebugLogClient.isEnabled()).toBe(true);
    });

    it('discards bootstrap events when the state arrives as off', async () => {
        DebugLogClient.log(DEBUG_LOG_EVENT.PrefsReceived, { reason: 'bootstrap' });
        DebugLogClient.applyState(false);
        DebugLogClient.log(DEBUG_LOG_EVENT.VideoBound);
        await drainClient();

        expect(sendMessage).not.toHaveBeenCalled();
        expect(DebugLogClient.isEnabled()).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('bounds the pre-state queue', async () => {
        for (let i = 0; i < DEBUG_LOG_CLIENT_PRESTATE_QUEUE_LIMIT + 5; i += 1) {
            DebugLogClient.log(DEBUG_LOG_EVENT.RouteStatus, { n: i });
        }
        DebugLogClient.applyState(true);
        await drainClient();

        expect(sentEvents()).toHaveLength(DEBUG_LOG_CLIENT_PRESTATE_QUEUE_LIMIT);
    });

    it('batches a burst and never sends on the caller stack', async () => {
        DebugLogClient.applyState(true);
        for (let i = 0; i < DEBUG_LOG_APPEND_MAX_EVENTS + 6; i += 1) {
            DebugLogClient.log(DEBUG_LOG_EVENT.RouteStatus, { n: i });
        }
        expect(sendMessage).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(0);
        expect(sendMessage).toHaveBeenCalledOnce();
        expect(sentBatches()[0]?.events).toHaveLength(DEBUG_LOG_APPEND_MAX_EVENTS);

        await flushClient();
        expect(sendMessage).toHaveBeenCalledTimes(2);
        expect(sentBatches()[1]?.events).toHaveLength(6);
        expect(sentEvents().map((event) => event.ageMs)).toEqual(
            expect.arrayContaining([0, DEBUG_LOG_CLIENT_FLUSH_DELAY_MS]),
        );
    });

    it('enforces the per-context ceiling per fixed minute window', async () => {
        DebugLogClient.applyState(true);
        const overflow = DEBUG_LOG_CONTENT_EVENTS_PER_TAB_PER_MINUTE + 1;
        for (let i = 0; i < overflow; i += 1) {
            DebugLogClient.log(DEBUG_LOG_EVENT.RouteStatus, { n: i });
            // Let each full batch leave on its immediate timer without
            // moving the clock: the hard queue bound
            // (DEBUG_LOG_CLIENT_QUEUE_LIMIT) sits below the minute ceiling,
            // so one synchronous burst would hit the bound before the ceiling
            // and this test would measure the wrong limit.
            if (i % DEBUG_LOG_APPEND_MAX_EVENTS === DEBUG_LOG_APPEND_MAX_EVENTS - 1) {
                await vi.advanceTimersByTimeAsync(0);
            }
        }
        await drainClient();

        expect(sentEvents()).toHaveLength(DEBUG_LOG_CONTENT_EVENTS_PER_TAB_PER_MINUTE);
        expect(sumDropped('ceiling')).toBe(1);

        vi.setSystemTime(Date.now() + DEBUG_LOG_CEILING_WINDOW_MS);
        DebugLogClient.log(DEBUG_LOG_EVENT.RouteStatus, { n: 'next-minute' });
        await drainClient();

        expect(sentEvents()).toHaveLength(DEBUG_LOG_CONTENT_EVENTS_PER_TAB_PER_MINUTE + 1);
        expect(sumDropped('ceiling')).toBe(1);
    });

    it('coalesces seeks to DEBUG_LOG_SEEK_EVENTS_PER_SECOND summaries per second', async () => {
        DebugLogClient.applyState(true);
        for (let i = 0; i < 50; i += 1) {
            DebugLogClient.logSeek(
                DEBUG_LOG_SEEK_KIND.Seek,
                { fromSec: i, toSec: i + 1.5 },
                { video: VIDEO_ID },
            );
        }
        await drainClient();

        const summaries = sentEvents().filter(
            (event) => event.event === DEBUG_LOG_EVENT.SeekSummary,
        );
        expect(summaries).toHaveLength(DEBUG_LOG_SEEK_EVENTS_PER_SECOND);
        expect(summaries[0]).toMatchObject({
            video: VIDEO_ID,
            fields: {
                reason: DEBUG_LOG_SEEK_KIND.Seek,
                fromSec: 0,
                toSec: 1.5,
                deltaSec: 1.5,
                dropped: 0,
                windowMs: MS_PER_SECOND,
            },
        });
        expect(sumDropped('coalesced')).toBe(45);

        vi.setSystemTime(Date.now() + MS_PER_SECOND);
        DebugLogClient.logSeek(DEBUG_LOG_SEEK_KIND.Jump, { fromSec: 9, toSec: 3 });
        await drainClient();

        const next = sentEvents().filter(
            (event) => event.event === DEBUG_LOG_EVENT.SeekSummary,
        );
        expect(next).toHaveLength(DEBUG_LOG_SEEK_EVENTS_PER_SECOND + 1);
        expect(next[DEBUG_LOG_SEEK_EVENTS_PER_SECOND]?.fields).toEqual({
            reason: DEBUG_LOG_SEEK_KIND.Jump,
            fromSec: 9,
            toSec: 3,
            deltaSec: -6,
            dropped: 45,
            windowMs: MS_PER_SECOND,
        });
    });

    it('counts an unreachable background, backs off, and never latches off', async () => {
        sendMessage.mockRejectedValueOnce(new Error('message port closed'));
        DebugLogClient.applyState(true);
        DebugLogClient.log(DEBUG_LOG_EVENT.SkipApplied, { block: 0 });
        await flushClient();
        expect(sendMessage).toHaveBeenCalledOnce();

        DebugLogClient.log(DEBUG_LOG_EVENT.SkipApplied, { block: 1 });
        await flushClient();
        expect(sendMessage).toHaveBeenCalledOnce();

        await vi.advanceTimersByTimeAsync(DEBUG_LOG_CLIENT_UNREACHABLE_BACKOFF_MS);
        expect(sendMessage).toHaveBeenCalledTimes(2);
        expect(sentBatches()[1]).toEqual({
            events: [expect.objectContaining({ fields: { block: 1 } })],
            dropped: { coalesced: 0, ceiling: 0, unreachable: 1 },
        });
        expect(DebugLogClient.isEnabled()).toBe(true);
    });

    it('treats a synchronous sendMessage throw like a rejection', async () => {
        sendMessage.mockImplementationOnce(() => {
            throw new Error('Extension context invalidated.');
        });
        DebugLogClient.applyState(true);
        expect(() => {
            DebugLogClient.log(DEBUG_LOG_EVENT.SkipApplied, { block: 0 });
        }).not.toThrow();
        await flushClient();
        DebugLogClient.log(DEBUG_LOG_EVENT.SkipApplied, { block: 1 });
        await vi.advanceTimersByTimeAsync(
            DEBUG_LOG_CLIENT_UNREACHABLE_BACKOFF_MS + DEBUG_LOG_CLIENT_FLUSH_DELAY_MS,
        );

        expect(sendMessage).toHaveBeenCalledTimes(2);
        expect(sumDropped('unreachable')).toBe(1);
    });

    it('drops and counts events beyond the queue limit while unreachable', async () => {
        sendMessage.mockRejectedValue(new Error('worker stopped'));
        DebugLogClient.applyState(true);
        DebugLogClient.log(DEBUG_LOG_EVENT.RouteStatus, { n: 'lost' });
        await flushClient();
        for (let i = 0; i < DEBUG_LOG_CLIENT_QUEUE_LIMIT + 5; i += 1) {
            DebugLogClient.log(DEBUG_LOG_EVENT.RouteStatus, { n: i });
        }
        sendMessage.mockResolvedValue({ ok: true, enabled: true });
        await vi.advanceTimersByTimeAsync(DEBUG_LOG_CLIENT_UNREACHABLE_BACKOFF_MS);
        await drainClient();

        const delivered = sentBatches().slice(1);
        expect(delivered.flatMap((batch) => batch.events)).toHaveLength(
            DEBUG_LOG_CLIENT_QUEUE_LIMIT,
        );
        expect(delivered[0]?.dropped).toEqual({
            coalesced: 0,
            ceiling: 0,
            unreachable: 1 + 5,
        });
    });

    it('applies the enabled flag carried by the append acknowledgement', async () => {
        sendMessage.mockResolvedValue({ ok: true, enabled: false });
        DebugLogClient.applyState(true);
        DebugLogClient.log(DEBUG_LOG_EVENT.RouteStatus);
        await flushClient();

        expect(DebugLogClient.isEnabled()).toBe(false);
        DebugLogClient.log(DEBUG_LOG_EVENT.RouteStatus);
        await drainClient();
        expect(sendMessage).toHaveBeenCalledOnce();
    });

    it('ignores acknowledgements without a boolean flag', async () => {
        sendMessage.mockResolvedValue({ ok: true });
        DebugLogClient.applyState(true);
        DebugLogClient.log(DEBUG_LOG_EVENT.RouteStatus);
        await flushClient();
        expect(DebugLogClient.isEnabled()).toBe(true);
    });

    it('flushNow sends immediately and clears the timer', async () => {
        DebugLogClient.applyState(true);
        DebugLogClient.log(DEBUG_LOG_EVENT.RouteStatus);
        await DebugLogClient.flushNow();

        expect(sendMessage).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('dispose drops the queue, clears timers, and ignores later events', async () => {
        DebugLogClient.applyState(true);
        DebugLogClient.log(DEBUG_LOG_EVENT.RouteStatus);
        DebugLogClient.dispose();

        expect(vi.getTimerCount()).toBe(0);
        expect(() => {
            DebugLogClient.log(DEBUG_LOG_EVENT.RouteStatus);
            DebugLogClient.logSeek(DEBUG_LOG_SEEK_KIND.Seek, { fromSec: 0, toSec: 1 });
        }).not.toThrow();
        await drainClient();
        expect(sendMessage).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('caps strings, drops empty values, and validates ids', async () => {
        DebugLogClient.applyState(true);
        DebugLogClient.log(
            DEBUG_LOG_EVENT.CaptureStage,
            {
                stage: 'x'.repeat(DEBUG_LOG_MAX_FIELD_STRING_LENGTH + 50),
                missing: undefined,
                nothing: null,
                nan: Number.NaN,
                ok: true,
            },
            { video: 'not a video id', session: 'not-a-uuid', job: '' },
        );
        DebugLogClient.log(DEBUG_LOG_EVENT.PollSummary, {}, {
            video: VIDEO_ID,
            session: SESSION_ID,
            job: 'job-1',
        });
        // A job id the wire schema (JOB_ID_PATTERN) rejects is dropped, not
        // truncated — otherwise the whole batch would fail the strict parse.
        DebugLogClient.log(DEBUG_LOG_EVENT.PollSummary, {}, { job: 'job x?y=1' });
        await flushClient();

        const [first, second, third] = sentEvents();
        expect(first).toEqual({
            event: DEBUG_LOG_EVENT.CaptureStage,
            ageMs: DEBUG_LOG_CLIENT_FLUSH_DELAY_MS,
            fields: {
                stage: 'x'.repeat(DEBUG_LOG_MAX_FIELD_STRING_LENGTH),
                ok: true,
            },
        });
        expect(second).toEqual({
            event: DEBUG_LOG_EVENT.PollSummary,
            ageMs: DEBUG_LOG_CLIENT_FLUSH_DELAY_MS,
            video: VIDEO_ID,
            session: SESSION_ID,
            job: 'job-1',
            fields: {},
        });
        expect(third).toEqual({
            event: DEBUG_LOG_EVENT.PollSummary,
            ageMs: DEBUG_LOG_CLIENT_FLUSH_DELAY_MS,
            fields: {},
        });
        expect(third).not.toHaveProperty('job');
    });

    it('mirrors events to the dev console only in dev builds', () => {
        DebugLogClient.applyState(true);
        DebugLogClient.log(DEBUG_LOG_EVENT.SkipApplied, { block: 0 }, { video: VIDEO_ID });
        expect(contentLogInfo).not.toHaveBeenCalled();

        vi.stubGlobal('__TOPSKIP_INCLUDE_DEV_LOCAL__', true);
        DebugLogClient.log(DEBUG_LOG_EVENT.SkipApplied, { block: 0 }, { video: VIDEO_ID });

        expect(contentLogInfo).toHaveBeenCalledWith(
            DEV_CONSOLE_PREFIX,
            DEBUG_LOG_EVENT.SkipApplied,
            `video=${VIDEO_ID} block=0`,
        );
    });

    it('uses the shared two-decimal seconds rounding for seek fields', () => {
        // `roundLogSeconds` is Section A's helper (`@/shared/debug-log-events`);
        // the client re-uses it rather than defining its own.
        expect(roundLogSeconds(10.2 - 9)).toBe(1.2);
        expect(roundLogSeconds(20 - 10.2)).toBe(9.8);
    });
});
