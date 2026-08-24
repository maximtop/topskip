import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = await vi.hoisted(async () => {
    const { createMemoryStorageArea } = await import(
        '../../helpers/memory-storage-area',
    );
    const { EXTENSION_ID } = await import('../../helpers/runtime-senders');
    return {
        extensionId: EXTENSION_ID,
        local: createMemoryStorageArea(),
        session: createMemoryStorageArea(),
        tabsQuery: vi.fn(),
        tabsSendMessage: vi.fn(),
        runtimeSendMessage: vi.fn(),
        collect: vi.fn(),
        notifyStateChanged: vi.fn(),
    };
});

vi.mock('@/shared/browser', () => ({
    default: {
        runtime: {
            id: hoisted.extensionId,
            getURL: (path: string) => `chrome-extension://${hoisted.extensionId}/${path}`,
            sendMessage: hoisted.runtimeSendMessage,
            getManifest: () => ({ version: '0.1.0' }),
        },
        storage: {
            local: {
                get: hoisted.local.get,
                set: hoisted.local.set,
                remove: hoisted.local.remove,
                setAccessLevel: vi.fn().mockResolvedValue(undefined),
            },
            session: { get: hoisted.session.get, set: hoisted.session.set },
        },
        tabs: { query: hoisted.tabsQuery, sendMessage: hoisted.tabsSendMessage },
    },
}));

vi.mock('@/background/debug-log/debug-log-export', async (importOriginal) => {
    const original = await importOriginal<
        typeof import('@/background/debug-log/debug-log-export')
    >();
    return { ...original, EnvironmentProbe: { collect: hoisted.collect } };
});

vi.mock('@/background/debug-log/debug-log-broadcast', () => ({
    DebugLogBroadcast: { notifyStateChanged: hoisted.notifyStateChanged },
}));

import { DebugLog } from '@/background/debug-log/debug-log';
import { DebugLogLifecycle } from '@/background/debug-log/debug-log-lifecycle';
import { DebugLogStore } from '@/background/debug-log/debug-log-store';
import { TabAttributionRegistry } from '@/background/debug-log/tab-attribution-registry';
import { DebugLogRuntimeMessages } from '@/background/messaging/debug-log-runtime-messages';
import { DEBUG_LOG_EVENT } from '@/shared/debug-log-events';
import {
    DEV_DEBUG_LOG_SEED_STATE,
    DEV_SEED_DISABLED_ERROR,
    UNTRUSTED_SENDER_ERROR,
} from '@/shared/messages';
import { eventNamesOf } from '../../helpers/debug-log-lines';
import {
    EXTENSION_ID,
    makeContentSender,
    makeForeignExtensionSender,
    makeOptionsSender,
    makePopupSender,
} from '../../helpers/runtime-senders';

const NOW_MS = 1_900_000_000_000;
const VIDEO_ID = 'dQw4w9WgXcQ';
const ENV = {
    extensionBuild: 'dev-2',
    browserMajor: 140,
    osFamily: 'mac',
    locale: 'en-US',
    analysisMode: 'server',
    providerId: 'openrouter',
    modelId: 'openrouter:preset',
};
const CONTENT = makeContentSender({ tabId: 41, videoId: VIDEO_ID });
const INCOGNITO_CONTENT = makeContentSender({ tabId: 42, videoId: VIDEO_ID, incognito: true });
const OPTIONS = makeOptionsSender({ tabId: 7 });
const POPUP = makePopupSender();
const UNTRUSTED = { ok: false, error: UNTRUSTED_SENDER_ERROR };
const APPEND = {
    events: [
        { event: DEBUG_LOG_EVENT.FiredReset, ageMs: 0, video: VIDEO_ID, fields: {} },
    ],
    dropped: { coalesced: 0, ceiling: 0, unreachable: 0 },
};

/**
 * Flushes and returns the event names of every stored line.
 */
async function loggedEvents(): Promise<string[]> {
    await DebugLog.drain();
    return eventNamesOf((await DebugLogStore.readSnapshot()).lines);
}

/**
 * Hydrates store and registry and opens the facade like a completed worker
 * start with the release default.
 */
async function startWorker(): Promise<void> {
    await DebugLogStore.ready(false);
    await TabAttributionRegistry.ready();
    DebugLog.open();
}

describe('DebugLogRuntimeMessages', () => {
    const fetchSpy = vi.fn();

    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW_MS);
        for (const area of [hoisted.local, hoisted.session]) {
            area.reset();
            area.restore();
        }
        hoisted.tabsQuery.mockReset().mockResolvedValue([]);
        hoisted.tabsSendMessage.mockReset().mockResolvedValue(undefined);
        hoisted.runtimeSendMessage.mockReset().mockResolvedValue(undefined);
        hoisted.collect.mockReset().mockResolvedValue(ENV);
        hoisted.notifyStateChanged.mockReset().mockResolvedValue(undefined);
        fetchSpy.mockReset();
        vi.stubGlobal('fetch', fetchSpy);
        DebugLogStore.resetForTest();
        TabAttributionRegistry.resetForTest();
        DebugLog.resetForTest();
        DebugLogLifecycle.resetForTest();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    describe('sender trust matrix', () => {
        it.each([
            ['popup', POPUP],
            ['Options page in a tab', OPTIONS],
        ])('accepts control and read messages from the %s', async (_name, sender) => {
            await startWorker();
            await expect(DebugLogRuntimeMessages.handleGetStatus(sender))
                .resolves.toMatchObject({ ok: true });
            await expect(DebugLogRuntimeMessages.handleGetPreview(sender))
                .resolves.toMatchObject({ ok: true });
            await expect(DebugLogRuntimeMessages.handleGetBundle(sender))
                .resolves.toMatchObject({ ok: true });
            await expect(DebugLogRuntimeMessages.handleSetEnabled(true, sender))
                .resolves.toMatchObject({ ok: true });
            await expect(DebugLogRuntimeMessages.handleAppend(APPEND, sender))
                .resolves.toEqual(UNTRUSTED);
        });

        it.each([
            ['YouTube content script', CONTENT],
            ['foreign extension', makeForeignExtensionSender()],
            ['look-alike extension id', {
                id: EXTENSION_ID,
                url: `chrome-extension://${EXTENSION_ID}xyz/options.html`,
            }],
        ])('refuses control and read messages from a %s', async (_name, sender) => {
            await startWorker();
            await expect(DebugLogRuntimeMessages.handleGetStatus(sender))
                .resolves.toEqual(UNTRUSTED);
            await expect(DebugLogRuntimeMessages.handleGetPreview(sender))
                .resolves.toEqual(UNTRUSTED);
            await expect(DebugLogRuntimeMessages.handleGetBundle(sender))
                .resolves.toEqual(UNTRUSTED);
            await expect(DebugLogRuntimeMessages.handleSetEnabled(true, sender))
                .resolves.toEqual(UNTRUSTED);
            expect(DebugLogStore.isEnabled()).toBe(false);
        });

        it.each([
            ['child frame', makeContentSender({ tabId: 41, videoId: VIDEO_ID, frameId: 1 })],
            ['non-declarative origin', {
                id: EXTENSION_ID,
                tab: { id: 41, incognito: false },
                frameId: 0,
                url: 'https://www.youtube.com.example/watch?v=dQw4w9WgXcQ',
            } as never],
            ['foreign extension', makeForeignExtensionSender()],
            ['missing tab', { id: EXTENSION_ID, frameId: 0, url: 'https://www.youtube.com/' }],
        ])('refuses appends from a %s', async (_name, sender) => {
            await startWorker();
            await expect(DebugLogRuntimeMessages.handleAppend(APPEND, sender))
                .resolves.toEqual(UNTRUSTED);
        });
    });

    describe('handleSetEnabled', () => {
        it('enables with the snapshot marker first, broadcasts once, and stays idempotent', async () => {
            await startWorker();
            TabAttributionRegistry.noteSender(CONTENT);
            TabAttributionRegistry.noteSender(INCOGNITO_CONTENT);

            const first = await DebugLogRuntimeMessages.handleSetEnabled(true, OPTIONS);
            expect(first).toMatchObject({
                ok: true,
                status: { enabled: true, enabledAtMs: NOW_MS },
            });
            expect(hoisted.notifyStateChanged).toHaveBeenCalledTimes(1);
            expect(hoisted.notifyStateChanged).toHaveBeenCalledWith(true);
            await DebugLog.drain();
            const lines = (await DebugLogStore.readSnapshot()).lines;
            expect(eventNamesOf(lines)).toEqual(['logging-enabled']);
            expect(lines[0]).toContain('liveTabs=1');
            expect(lines[0]).toContain('mode=server');

            DebugLog.record(DEBUG_LOG_EVENT.WakeupProbe, { readyTabs: 0, unavailableTabs: 0 });
            const second = await DebugLogRuntimeMessages.handleSetEnabled(true, POPUP);
            expect(second).toMatchObject({
                ok: true,
                status: { eventCount: 2, enabledAtMs: NOW_MS },
            });
            expect(hoisted.notifyStateChanged).toHaveBeenCalledTimes(1);
            expect(await loggedEvents()).toEqual(['logging-enabled', 'wakeup-probe']);
        });

        it('disables with the terminal marker, keeps the log and broadcasts once', async () => {
            await startWorker();
            await DebugLogRuntimeMessages.handleSetEnabled(true, OPTIONS);
            hoisted.notifyStateChanged.mockClear();

            const off = await DebugLogRuntimeMessages.handleSetEnabled(false, OPTIONS);
            expect(off).toMatchObject({
                ok: true,
                status: { enabled: false, hasLog: true, eventCount: 2, disabledAtMs: NOW_MS },
            });
            expect(hoisted.notifyStateChanged).toHaveBeenCalledWith(false);
            DebugLog.record(DEBUG_LOG_EVENT.WakeupProbe, { readyTabs: 0, unavailableTabs: 0 });
            await expect(DebugLogRuntimeMessages.handleSetEnabled(false, OPTIONS))
                .resolves.toMatchObject({ ok: true });
            expect(hoisted.notifyStateChanged).toHaveBeenCalledTimes(1);
            expect(await loggedEvents()).toEqual(['logging-enabled', 'logging-disabled']);
        });

        it('clears the stored log on the next enable', async () => {
            await startWorker();
            await DebugLogRuntimeMessages.handleSetEnabled(true, OPTIONS);
            await DebugLogRuntimeMessages.handleSetEnabled(false, OPTIONS);
            const again = await DebugLogRuntimeMessages.handleSetEnabled(true, OPTIONS);
            expect(again).toMatchObject({ ok: true, status: { enabled: true, eventCount: 1 } });
            expect(await loggedEvents()).toEqual(['logging-enabled']);
        });
    });

    describe('reads', () => {
        it('status, preview and bundle never record events and stay consistent', async () => {
            await startWorker();
            await DebugLogRuntimeMessages.handleSetEnabled(true, OPTIONS);
            DebugLog.record(DEBUG_LOG_EVENT.WakeupProbe, { readyTabs: 1, unavailableTabs: 2 });
            await DebugLog.drain();
            const before = DebugLogStore.getStatus().eventCount;

            const status = await DebugLogRuntimeMessages.handleGetStatus(POPUP);
            const preview = await DebugLogRuntimeMessages.handleGetPreview(OPTIONS);
            const bundle = await DebugLogRuntimeMessages.handleGetBundle(OPTIONS);

            expect(status).toMatchObject({
                ok: true,
                status: { eventCount: before, enabled: true },
            });
            expect(preview).toMatchObject({
                ok: true,
                revision: DebugLogStore.getStatus().revision,
            });
            if (!preview.ok || !bundle.ok) {
                throw new Error('read failed');
            }
            expect(preview.text).toContain('wakeup-probe');
            expect(preview.totalBytes).toBe(DebugLogStore.getStatus().sizeBytes);
            expect(bundle.text.startsWith('TopSkip debug log\n')).toBe(true);
            expect(bundle.text).toContain('events=2');
            expect(bundle.text).toContain('wakeup-probe');
            expect(bundle.exportedAtMs).toBe(NOW_MS);
            expect(DebugLogStore.getStatus().eventCount).toBe(before);

            // Snapshot consistency (FR-029/FR-046): every event line is
            // `<iso> <worker>#<seq> …`, sequences are contiguous per worker
            // and no event is later than the header's exportedAt.
            const eventLines = bundle.text
                .split('\n')
                .filter((line) => /^\d{4}-/u.test(line));
            expect(eventLines).toHaveLength(2);
            const seqByWorker = new Map<string, number[]>();
            for (const line of eventLines) {
                const match = /^(\S+) (\S+)#(\d+) /u.exec(line);
                if (match === null) {
                    throw new Error(`unparsable line: ${line}`);
                }
                expect(Date.parse(match[1])).toBeLessThanOrEqual(bundle.exportedAtMs);
                seqByWorker.set(match[2], [
                    ...(seqByWorker.get(match[2]) ?? []),
                    Number(match[3]),
                ]);
            }
            for (const seqs of seqByWorker.values()) {
                seqs.forEach((seq, index) => {
                    if (index > 0) {
                        expect(seq).toBe(seqs[index - 1] + 1);
                    }
                });
            }
        });

        it('reports a failed bundle read as an error without logging it', async () => {
            await startWorker();
            await DebugLogRuntimeMessages.handleSetEnabled(true, OPTIONS);
            const readSnapshot = vi.spyOn(DebugLogStore, 'readSnapshot').mockRejectedValueOnce(
                new Error('storage read failed'),
            );

            await expect(DebugLogRuntimeMessages.handleGetBundle(OPTIONS)).resolves.toEqual({
                ok: false,
                error: 'storage read failed',
            });
            readSnapshot.mockRestore();
            expect(await loggedEvents()).toEqual(['logging-enabled']);
        });
    });

    describe('handleAppend', () => {
        it('stores events from a trusted content tab and reports the switch state', async () => {
            await startWorker();
            await DebugLogRuntimeMessages.handleSetEnabled(true, OPTIONS);

            await expect(DebugLogRuntimeMessages.handleAppend(APPEND, CONTENT)).resolves.toEqual({
                ok: true,
                enabled: true,
            });
            const lines = (await DebugLogStore.readSnapshot()).lines;
            expect(eventNamesOf(lines)).toEqual(['logging-enabled', 'fired-reset']);
            expect(lines[1]).toContain('t41');
            expect(lines[1]).toContain(VIDEO_ID);
        });

        it('notes the tab but stores nothing while the switch is off', async () => {
            await startWorker();
            await expect(DebugLogRuntimeMessages.handleAppend(APPEND, CONTENT)).resolves.toEqual({
                ok: true,
                enabled: false,
            });
            expect(TabAttributionRegistry.isIncognitoSync(41)).toBe(false);
            expect(DebugLogStore.getStatus().eventCount).toBe(0);
        });

        it('drops an incognito tab batch and counts it', async () => {
            await startWorker();
            await DebugLogRuntimeMessages.handleSetEnabled(true, OPTIONS);
            await DebugLogRuntimeMessages.handleAppend(APPEND, INCOGNITO_CONTENT);
            expect(DebugLogStore.getStatus()).toMatchObject({ eventCount: 1 });
            expect(DebugLogStore.getStatus().dropped.incognito).toBe(1);
        });
    });

    describe('handleDevSeed', () => {
        it('is refused outside dev builds before anything else is checked', async () => {
            await startWorker();
            await expect(
                DebugLogRuntimeMessages.handleDevSeed(
                    { state: DEV_DEBUG_LOG_SEED_STATE.On },
                    OPTIONS,
                ),
            ).resolves.toEqual({ ok: false, error: DEV_SEED_DISABLED_ERROR });
            expect(hoisted.local.set).not.toHaveBeenCalled();
        });

        it('seeds in dev builds for extension pages only and validates the payload', async () => {
            vi.stubGlobal('__TOPSKIP_INCLUDE_DEV_LOCAL__', true);
            await startWorker();

            await expect(
                DebugLogRuntimeMessages.handleDevSeed(
                    { state: DEV_DEBUG_LOG_SEED_STATE.On },
                    CONTENT,
                ),
            ).resolves.toEqual(UNTRUSTED);
            await expect(
                DebugLogRuntimeMessages.handleDevSeed({ state: 'bogus' } as never, OPTIONS),
            ).resolves.toEqual({ ok: false, error: 'Invalid debug log seed.' });

            await expect(
                DebugLogRuntimeMessages.handleDevSeed(
                    { state: DEV_DEBUG_LOG_SEED_STATE.OffStored, approxBytes: 2048 },
                    OPTIONS,
                ),
            ).resolves.toEqual({ ok: true });
            expect(DebugLogStore.getStatus()).toMatchObject({ enabled: false, hasLog: true });
            expect(hoisted.notifyStateChanged).toHaveBeenCalledWith(false);

            await expect(
                DebugLogRuntimeMessages.handleDevSeed(
                    { state: DEV_DEBUG_LOG_SEED_STATE.OffEmpty },
                    POPUP,
                ),
            ).resolves.toEqual({ ok: true });
            expect(DebugLogStore.getStatus()).toMatchObject({ enabled: false, hasLog: false });
        });
    });
});
