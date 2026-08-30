import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = await vi.hoisted(async () => {
    const { createMemoryStorageArea } = await import(
        '../../helpers/memory-storage-area',
    );
    return {
        local: createMemoryStorageArea(),
        session: createMemoryStorageArea(),
    };
});

vi.mock('@/shared/browser', () => ({
    default: {
        storage: {
            local: {
                get: storage.local.get,
                set: storage.local.set,
                remove: storage.local.remove,
                setAccessLevel: vi.fn().mockResolvedValue(undefined),
            },
            session: { get: storage.session.get, set: storage.session.set },
        },
    },
}));

import { DebugLog } from '@/background/debug-log/debug-log';
import { DebugLogStore } from '@/background/debug-log/debug-log-store';
import { TabAttributionRegistry } from '@/background/debug-log/tab-attribution-registry';
import {
    DEBUG_LOG_CONTENT_EVENTS_PER_TAB_PER_MINUTE,
    DEBUG_LOG_PREHYDRATION_QUEUE_LIMIT,
} from '@/shared/debug-log-constants';
import {
    DEBUG_LOG_EVENT,
    DEBUG_LOG_RESTART_CAUSE,
    DEBUG_LOG_SOURCE,
} from '@/shared/debug-log-events';
import { spyOnAllConsole } from '../../helpers/console-spy';
import { eventNamesOf } from '../../helpers/debug-log-lines';

const NOW_MS = 1_900_000_000_000;
const TAB = { id: 41, incognito: false, index: 0, highlighted: false,
    active: true, pinned: false, windowId: 1 };
const INCOGNITO_TAB = { ...TAB, id: 42, incognito: true };
const VIDEO_ID = 'dQw4w9WgXcQ';
const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const NO_DROPS = { coalesced: 0, ceiling: 0, unreachable: 0 };
/**
 * SC-007: the facade never touches the network.
 */
const fetchSpy = vi.fn();

/**
 * Hydrates store and registry, turns the switch on and opens the facade.
 */
async function openEnabledLogger(): Promise<void> {
    await DebugLogStore.ready(false);
    await TabAttributionRegistry.ready();
    await DebugLogStore.enable(NOW_MS);
    DebugLog.open();
}

/**
 * Flushes and returns every stored line.
 */
async function loggedLines(): Promise<string[]> {
    await DebugLog.drain();
    return (await DebugLogStore.readSnapshot()).lines;
}

/**
 * Flushes and returns the event name of every stored line.
 */
async function loggedEvents(): Promise<string[]> {
    return eventNamesOf(await loggedLines());
}

describe('DebugLog', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW_MS);
        for (const area of [storage.local, storage.session]) {
            area.reset();
            area.restore();
        }
        fetchSpy.mockReset();
        vi.stubGlobal('fetch', fetchSpy);
        DebugLogStore.resetForTest();
        TabAttributionRegistry.resetForTest();
        DebugLog.resetForTest();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('queues records in emission order until opened and writes them afterwards', async () => {
        DebugLog.record(DEBUG_LOG_EVENT.WakeupProbe, { readyTabs: 1, unavailableTabs: 0 });
        DebugLog.record(DEBUG_LOG_EVENT.WorkerStarted, { build: 'dev-1', first: false });
        await DebugLogStore.ready(false);
        await TabAttributionRegistry.ready();
        await DebugLogStore.enable(NOW_MS);
        expect((await DebugLogStore.readSnapshot()).lines).toEqual([]);

        DebugLog.open();

        expect(await loggedEvents()).toEqual(['wakeup-probe', 'worker-started']);
    });

    it('bounds the pre-open queue and can discard it', async () => {
        for (let i = 0; i < DEBUG_LOG_PREHYDRATION_QUEUE_LIMIT + 10; i += 1) {
            DebugLog.record(DEBUG_LOG_EVENT.WakeupProbe, { readyTabs: i, unavailableTabs: 0 });
        }
        await DebugLogStore.ready(false);
        await TabAttributionRegistry.ready();
        await DebugLogStore.enable(NOW_MS);
        DebugLog.open();
        const stored = (await loggedLines()).length;
        expect(stored).toBe(DEBUG_LOG_PREHYDRATION_QUEUE_LIMIT);

        DebugLog.resetForTest();
        DebugLog.record(DEBUG_LOG_EVENT.WakeupProbe, { readyTabs: 9, unavailableTabs: 0 });
        DebugLog.discardQueued();
        DebugLog.open();
        expect((await loggedLines()).length).toBe(stored);
    });

    it('drops everything while the switch is off', async () => {
        await DebugLogStore.ready(false);
        await TabAttributionRegistry.ready();
        DebugLog.open();
        DebugLog.record(DEBUG_LOG_EVENT.WorkerStarted, { build: 'x', first: true });
        await DebugLog.drain();
        expect(DebugLogStore.getStatus().eventCount).toBe(0);
    });

    it('formats a line with worker id, sequence, attributed ids and sanitized fields', async () => {
        await openEnabledLogger();
        TabAttributionRegistry.noteTab(TAB);

        DebugLog.record(
            DEBUG_LOG_EVENT.RouteDecision,
            { route: 'server', reason: 'x y', nested: { a: 1 } as never },
            { tab: 41, video: VIDEO_ID, session: SESSION_ID, src: DEBUG_LOG_SOURCE.Content },
        );
        DebugLog.record(DEBUG_LOG_EVENT.RouteDecision, { route: 'byok' }, { tab: 41 });

        const lines = await loggedLines();
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain(new Date(NOW_MS).toISOString());
        expect(lines[0]).toContain(`${DebugLog.workerId()}#1`);
        expect(lines[0]).toContain('route-decision');
        expect(lines[0]).toContain('t41');
        expect(lines[0]).toContain(VIDEO_ID);
        expect(lines[0]).toContain(SESSION_ID);
        expect(lines[0]).toContain('route=server');
        expect(lines[0]).not.toContain('nested');
        expect(lines[1]).toContain(`${DebugLog.workerId()}#2`);
        expect(DebugLog.workerId()).toMatch(/^[0-9a-z]{6}$/u);
    });

    it('keeps backend job tokens (not only UUIDs) in the line head', async () => {
        await openEnabledLogger();
        TabAttributionRegistry.noteTab(TAB);

        DebugLog.record(
            DEBUG_LOG_EVENT.HttpError,
            { operation: 'poll', code: 'request-failed' },
            { tab: 41, job: 'job-1f3b9e2c-0000-4000-8000-000000000001' },
        );
        DebugLog.record(
            DEBUG_LOG_EVENT.PollSummary,
            { polls: 3, retries: 0, totalMs: 900, lastStatus: 'ready', terminal: true },
            { tab: 41, job: 'local-e2eFixture1-server-v7' },
        );
        DebugLog.record(
            DEBUG_LOG_EVENT.PollSummary,
            { polls: 1, retries: 0, totalMs: 1, lastStatus: 'ready', terminal: true },
            { tab: 41, job: 'not a token?x=1' },
        );

        const lines = await loggedLines();
        expect(lines[0]).toContain('j=job-1f3b9e2c-0000-4000-8000-000000000001');
        expect(lines[1]).toContain('j=local-e2eFixture1-server-v7');
        expect(lines[2]).not.toContain('j=');
        expect(lines[2]).not.toContain('not a token');
    });

    it('strips a video id without a tab and malformed session/support ids', async () => {
        await openEnabledLogger();
        DebugLog.record(
            DEBUG_LOG_EVENT.CacheDecision,
            { decision: 'hit' },
            { video: VIDEO_ID, session: 'not-a-uuid', support: 'support-x' },
        );
        const [first] = await loggedLines();
        expect(first).toContain('cache-decision');
        expect(first).not.toContain(VIDEO_ID);
        expect(first).not.toContain('not-a-uuid');
        expect(first).not.toContain('support-x');
    });

    it('drops per-tab events for incognito and unknown tabs, counting only incognito', async () => {
        await openEnabledLogger();
        TabAttributionRegistry.noteTab(INCOGNITO_TAB);

        DebugLog.record(DEBUG_LOG_EVENT.HttpStart, { operation: 'analysis' }, { tab: 42, video: VIDEO_ID });
        DebugLog.record(DEBUG_LOG_EVENT.HttpStart, { operation: 'analysis' }, { tab: 77 });

        expect(await loggedLines()).toEqual([]);
        expect(DebugLogStore.getStatus().dropped).toMatchObject({ incognito: 1 });
    });

    it('inserts the generic restart marker lazily, once, before the first non-lifecycle event', async () => {
        await openEnabledLogger();
        DebugLog.markSessionStateLost();
        DebugLog.record(DEBUG_LOG_EVENT.WorkerStarted, { build: 'b', first: true });
        expect(await loggedEvents()).toEqual(['worker-started']);

        DebugLog.record(DEBUG_LOG_EVENT.WakeupProbe, { readyTabs: 0, unavailableTabs: 0 });
        DebugLog.record(DEBUG_LOG_EVENT.WakeupProbe, { readyTabs: 1, unavailableTabs: 0 });

        const lines = await loggedLines();
        expect(eventNamesOf(lines)).toEqual([
            'worker-started',
            'runtime-restarted',
            'wakeup-probe',
            'wakeup-probe',
        ]);
        expect(lines[1]).toContain(`cause=${DEBUG_LOG_RESTART_CAUSE.SessionStateLost}`);
    });

    it('emits no generic marker when session state was present', async () => {
        await openEnabledLogger();
        DebugLog.record(DEBUG_LOG_EVENT.WorkerStarted, { build: 'b', first: false });
        DebugLog.record(DEBUG_LOG_EVENT.WakeupProbe, { readyTabs: 0, unavailableTabs: 0 });
        expect(await loggedEvents()).toEqual(['worker-started', 'wakeup-probe']);
    });

    it('lets a specific cause suppress the generic marker and keeps a late specific one', async () => {
        await openEnabledLogger();
        DebugLog.markSessionStateLost();
        DebugLog.record(DEBUG_LOG_EVENT.WorkerStarted, { build: 'b', first: true });
        DebugLog.record(DEBUG_LOG_EVENT.BrowserRestarted, { build: 'b' });
        DebugLog.record(DEBUG_LOG_EVENT.WakeupProbe, { readyTabs: 0, unavailableTabs: 0 });
        expect(await loggedEvents()).toEqual([
            'worker-started',
            'browser-restarted',
            'wakeup-probe',
        ]);

        DebugLog.resetForTest();
        DebugLog.open();
        DebugLog.markSessionStateLost();
        DebugLog.record(DEBUG_LOG_EVENT.WakeupProbe, { readyTabs: 0, unavailableTabs: 0 });
        DebugLog.record(DEBUG_LOG_EVENT.ExtensionRestarted, {
            previousBuild: 'a',
            newBuild: 'b',
            cause: 'update',
        });
        expect((await loggedEvents()).slice(3)).toEqual([
            'runtime-restarted',
            'wakeup-probe',
            'extension-restarted',
        ]);
    });

    it('remembers a specific cause observed while the switch was off', async () => {
        await DebugLogStore.ready(false);
        await TabAttributionRegistry.ready();
        DebugLog.open();
        DebugLog.markSessionStateLost();
        DebugLog.record(DEBUG_LOG_EVENT.ExtensionRestarted, {
            previousBuild: 'a',
            newBuild: 'b',
            cause: 'install',
        });
        await DebugLogStore.enable(NOW_MS, () => {
            DebugLog.record(DEBUG_LOG_EVENT.LoggingEnabled, { enabled: true });
        });
        DebugLog.record(DEBUG_LOG_EVENT.WakeupProbe, { readyTabs: 0, unavailableTabs: 0 });
        expect(await loggedEvents()).toEqual(['logging-enabled', 'wakeup-probe']);
    });

    it('back-dates content events by ageMs, enforces the ceiling and folds client counters', async () => {
        await openEnabledLogger();
        TabAttributionRegistry.noteTab(TAB);

        DebugLog.appendFromContent(
            41,
            {
                events: [
                    {
                        event: DEBUG_LOG_EVENT.SkipApplied,
                        ageMs: 1000,
                        video: VIDEO_ID,
                        fields: { block: 0, fromSec: 1, toSec: 2 },
                    },
                    {
                        event: DEBUG_LOG_EVENT.SeekSummary,
                        ageMs: 0,
                        video: VIDEO_ID,
                        fields: { count: 3, dropped: 2, windowMs: 1000 },
                    },
                ],
                dropped: { coalesced: 2, ceiling: 0, unreachable: 1 },
            },
            NOW_MS,
        );
        const lines = await loggedLines();
        expect(eventNamesOf(lines)).toEqual(['skip-applied', 'seek-summary']);
        expect(lines[0]).toContain(new Date(NOW_MS - 1000).toISOString());
        expect(lines[0]).toContain('t41');
        expect(lines[0]).toContain(VIDEO_ID);
        expect(DebugLogStore.getStatus().dropped).toMatchObject({
            coalesced: 2,
            unreachable: 1,
            ceiling: 0,
        });

        const limit = DEBUG_LOG_CONTENT_EVENTS_PER_TAB_PER_MINUTE;
        DebugLog.appendFromContent(
            41,
            {
                events: Array.from({ length: limit }, () => ({
                    event: DEBUG_LOG_EVENT.FiredReset,
                    ageMs: 0,
                    fields: {},
                })),
                dropped: NO_DROPS,
            },
            NOW_MS + 1,
        );
        await DebugLog.drain();
        expect(DebugLogStore.getStatus().dropped.ceiling).toBe(2);
        expect(DebugLogStore.getStatus().eventCount).toBe(limit);
    });

    it('drops a whole content batch from an incognito tab and counts it', async () => {
        await openEnabledLogger();
        TabAttributionRegistry.noteTab(INCOGNITO_TAB);
        DebugLog.appendFromContent(
            42,
            {
                events: [{ event: DEBUG_LOG_EVENT.FiredReset, ageMs: 0, fields: {} }],
                dropped: NO_DROPS,
            },
            NOW_MS,
        );
        await DebugLog.drain();
        expect(DebugLogStore.getStatus().eventCount).toBe(0);
        expect(DebugLogStore.getStatus().dropped.incognito).toBe(1);
    });

    it('ignores a content batch from an unknown tab without counting it (FR-020)', async () => {
        await openEnabledLogger();
        DebugLog.appendFromContent(
            77,
            {
                events: [{ event: DEBUG_LOG_EVENT.FiredReset, ageMs: 0, fields: {} }],
                dropped: NO_DROPS,
            },
            NOW_MS,
        );
        await DebugLog.drain();
        expect(DebugLogStore.getStatus().eventCount).toBe(0);
        expect(DebugLogStore.getStatus().dropped.incognito).toBe(0);
    });

    it('stamps bridge for forwarded page: stages and content for the rest (FR-010)', async () => {
        await openEnabledLogger();
        TabAttributionRegistry.noteTab(TAB);
        DebugLog.appendFromContent(
            41,
            {
                events: [
                    {
                        event: DEBUG_LOG_EVENT.CaptureStage,
                        ageMs: 0,
                        video: VIDEO_ID,
                        fields: { stage: 'page:timedtext-observed' },
                    },
                    { event: DEBUG_LOG_EVENT.FiredReset, ageMs: 0, fields: {} },
                ],
                dropped: NO_DROPS,
            },
            NOW_MS,
        );
        const lines = await loggedLines();
        expect(eventNamesOf(lines)).toEqual(['capture-stage', 'fired-reset']);
        expect(lines[0]).toContain(' br ');
        expect(lines[0]).toContain('stage=page:timedtext-observed');
        expect(lines[1]).toContain(' ct ');
    });

    it('prints nothing under release-like defines and mirrors to the console only when asked', async () => {
        await openEnabledLogger();
        const spies = spyOnAllConsole();

        DebugLog.record(DEBUG_LOG_EVENT.WorkerStarted, { build: 'b', first: false });
        DebugLog.appendFromContent(
            77,
            {
                events: [{ event: DEBUG_LOG_EVENT.FiredReset, ageMs: 0, fields: {} }],
                dropped: NO_DROPS,
            },
            NOW_MS,
        );
        await DebugLog.drain();
        for (const spy of Object.values(spies)) {
            expect(spy).not.toHaveBeenCalled();
        }

        DebugLog.record(DEBUG_LOG_EVENT.WorkerStarted, { build: 'b', first: false }, {}, true);
        expect(spies.info).toHaveBeenCalledWith(
            '[TopSkip debug]',
            'worker-started',
            'build=b first=false',
        );
    });

    it('never throws into the caller', async () => {
        await openEnabledLogger();
        const append = vi.spyOn(DebugLogStore, 'append').mockImplementation(() => {
            throw new Error('boom');
        });
        expect(() =>
            DebugLog.record(DEBUG_LOG_EVENT.WorkerStarted, { build: 'b', first: false }),
        ).not.toThrow();
        expect(() =>
            DebugLog.appendFromContent(
                41,
                {
                    events: [{ event: DEBUG_LOG_EVENT.FiredReset, ageMs: 0, fields: {} }],
                    dropped: NO_DROPS,
                },
                NOW_MS,
            ),
        ).not.toThrow();
        append.mockRestore();
    });
});
