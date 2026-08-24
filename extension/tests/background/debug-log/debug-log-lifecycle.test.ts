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

const runtimeMocks = vi.hoisted(() => ({
    onStartup: vi.fn(),
    onInstalled: vi.fn(),
}));

const probeMocks = vi.hoisted(() => ({
    collect: vi.fn(),
}));

const broadcastMocks = vi.hoisted(() => ({
    notifyStateChanged: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/background/debug-log/debug-log-broadcast', () => ({
    DebugLogBroadcast: { notifyStateChanged: broadcastMocks.notifyStateChanged },
}));

vi.mock('@/shared/browser', () => ({
    default: {
        runtime: {
            onStartup: { addListener: runtimeMocks.onStartup },
            onInstalled: { addListener: runtimeMocks.onInstalled },
        },
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

vi.mock('@/background/debug-log/debug-log-export', () => ({
    EnvironmentProbe: { collect: probeMocks.collect },
}));

import { DebugLog } from '@/background/debug-log/debug-log';
import { DebugLogLifecycle } from '@/background/debug-log/debug-log-lifecycle';
import { DebugLogStore } from '@/background/debug-log/debug-log-store';
import { TabAttributionRegistry } from '@/background/debug-log/tab-attribution-registry';
import {
    SESSION_STORAGE_KEY_DEBUG_LOG_WORKER,
    STORAGE_KEY_DEBUG_LOG_SWITCH,
} from '@/shared/constants';
import { DEBUG_LOG_STORE_VERSION } from '@/shared/debug-log-constants';
import { DEBUG_LOG_EVENT, DEBUG_LOG_RESTART_CAUSE } from '@/shared/debug-log-events';
import { eventNamesOf } from '../../helpers/debug-log-lines';

const NOW_MS = 1_900_000_000_000;
const TAB = { id: 41, incognito: false, index: 0, highlighted: false,
    active: true, pinned: false, windowId: 1 };
const ENV = {
    extensionBuild: 'dev-2',
    browserMajor: 140,
    osFamily: 'mac',
    locale: 'en-US',
    analysisMode: 'server',
    providerId: 'openrouter',
    modelId: 'openrouter:preset',
};

/**
 * Listener shapes captured from the mocked runtime events.
 */
type StartupListener = () => void;
type InstalledListener = (details: {
    reason: string;
    temporary: boolean;
    previousVersion?: string;
}) => void;

/**
 * The `onStartup` callback registered by the last `register()` call.
 */
function startupListener(): StartupListener {
    const listener = runtimeMocks.onStartup.mock.calls.at(-1)?.[0] as
        | StartupListener
        | undefined;
    if (listener === undefined) {
        throw new Error('onStartup listener not registered');
    }
    return listener;
}

/**
 * The `onInstalled` callback registered by the last `register()` call.
 */
function installedListener(): InstalledListener {
    const listener = runtimeMocks.onInstalled.mock.calls.at(-1)?.[0] as
        | InstalledListener
        | undefined;
    if (listener === undefined) {
        throw new Error('onInstalled listener not registered');
    }
    return listener;
}

/**
 * Clears every module's static state like a fresh service worker while the
 * mocked storage survives.
 */
function resetLifetime(): void {
    DebugLogStore.resetForTest();
    TabAttributionRegistry.resetForTest();
    DebugLog.resetForTest();
    DebugLogLifecycle.resetForTest();
    runtimeMocks.onStartup.mockClear();
    runtimeMocks.onInstalled.mockClear();
    DebugLogLifecycle.register();
}

/**
 * Completes a worker start: hydrate with the given profile default, then
 * run the lifecycle marker.
 */
async function completeStart(buildLabel: string, defaultEnabled = false): Promise<void> {
    await DebugLogStore.ready(defaultEnabled);
    await DebugLogLifecycle.markWorkerStarted(buildLabel);
}

/**
 * Turns the switch on as a user would (facade open, marker written), then
 * starts over like a new lifetime with the session wiped.
 */
async function arrangeEnabledLog(): Promise<void> {
    await DebugLogStore.ready(false);
    DebugLog.open();
    await DebugLogLifecycle.enable(NOW_MS);
    await DebugLog.drain();
    resetLifetime();
}

/**
 * Flushes and returns every stored line.
 */
async function loggedLines(): Promise<string[]> {
    await DebugLog.drain();
    return (await DebugLogStore.readSnapshot()).lines;
}

/**
 * Flushes and returns the event names of every stored line.
 */
async function loggedEvents(): Promise<string[]> {
    return eventNamesOf(await loggedLines());
}

describe('DebugLogLifecycle', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(NOW_MS);
        for (const area of [storage.local, storage.session]) {
            area.reset();
            area.restore();
        }
        probeMocks.collect.mockReset();
        probeMocks.collect.mockResolvedValue(ENV);
        broadcastMocks.notifyStateChanged.mockClear();
        resetLifetime();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('registers the startup and install listeners synchronously', () => {
        expect(runtimeMocks.onStartup).toHaveBeenCalledTimes(1);
        expect(runtimeMocks.onInstalled).toHaveBeenCalledTimes(1);
    });

    it('logs worker-started first=true, the generic marker lazily and once, and never at init', async () => {
        await arrangeEnabledLog();

        await completeStart('dev-1');
        expect(await loggedEvents()).toEqual(['logging-enabled', 'worker-started']);
        expect((await loggedLines())[1]).toContain('build=dev-1 first=true');
        expect(storage.session.data[SESSION_STORAGE_KEY_DEBUG_LOG_WORKER]).toBeDefined();

        DebugLog.record(DEBUG_LOG_EVENT.WakeupProbe, { readyTabs: 0, unavailableTabs: 0 });
        DebugLog.record(DEBUG_LOG_EVENT.WakeupProbe, { readyTabs: 1, unavailableTabs: 0 });
        const lines = await loggedLines();
        expect(eventNamesOf(lines)).toEqual([
            'logging-enabled',
            'worker-started',
            'runtime-restarted',
            'wakeup-probe',
            'wakeup-probe',
        ]);
        expect(lines[2]).toContain(`cause=${DEBUG_LOG_RESTART_CAUSE.SessionStateLost}`);
    });

    it('logs first=false and no cause marker when session state survived', async () => {
        await arrangeEnabledLog();
        await completeStart('dev-1');
        // The worker-started line sits behind the debounced flush; a worker
        // that dies before it elapses loses that tail by design, so persist
        // it before simulating the next lifetime.
        await DebugLog.drain();
        resetLifetime();

        await completeStart('dev-1');
        DebugLog.record(DEBUG_LOG_EVENT.WakeupProbe, { readyTabs: 0, unavailableTabs: 0 });

        const lines = await loggedLines();
        expect(eventNamesOf(lines)).toEqual([
            'logging-enabled',
            'worker-started',
            'worker-started',
            'wakeup-probe',
        ]);
        expect(lines[2]).toContain('first=false');
    });

    it('logs browser-restarted after worker-started for a startup signal and skips the generic marker', async () => {
        await arrangeEnabledLog();
        startupListener()();

        await completeStart('dev-1');
        DebugLog.record(DEBUG_LOG_EVENT.WakeupProbe, { readyTabs: 0, unavailableTabs: 0 });

        const lines = await loggedLines();
        expect(eventNamesOf(lines)).toEqual([
            'logging-enabled',
            'worker-started',
            'browser-restarted',
            'wakeup-probe',
        ]);
        expect(lines[2]).toContain('build=dev-1');
    });

    it('logs extension-restarted with the persisted previous label for install and update only', async () => {
        await arrangeEnabledLog();
        await completeStart('dev-1');

        resetLifetime();
        installedListener()({ reason: 'update', temporary: false });
        await completeStart('dev-1');
        let lines = await loggedLines();
        expect(eventNamesOf(lines).slice(-2)).toEqual(['worker-started', 'extension-restarted']);
        expect(lines.at(-1)).toContain('previousBuild=dev-1 newBuild=dev-1 cause=update');

        resetLifetime();
        installedListener()({ reason: 'update', temporary: false, previousVersion: '0.1.0' });
        await completeStart('dev-2');
        lines = await loggedLines();
        expect(eventNamesOf(lines).slice(-2)).toEqual(['worker-started', 'extension-restarted']);
        expect(lines.at(-1)).toContain('previousBuild=dev-1 newBuild=dev-2 cause=update');

        resetLifetime();
        installedListener()({ reason: 'browser_update', temporary: false });
        await completeStart('dev-2');
        expect(eventNamesOf(await loggedLines()).at(-1)).toBe('worker-started');

        installedListener()({ reason: 'update', temporary: false });
        expect(eventNamesOf(await loggedLines()).at(-1)).toBe('extension-restarted');
    });

    it('names previousBuild=unknown when no label was ever persisted', async () => {
        await arrangeEnabledLog();
        installedListener()({ reason: 'install', temporary: false });
        await completeStart('dev-1');
        const lines = await loggedLines();
        expect(lines.at(-1)).toContain('previousBuild=unknown newBuild=dev-1 cause=install');
    });

    it('keeps both specific markers in arrival order and a late specific one after the generic', async () => {
        await arrangeEnabledLog();
        startupListener()();
        await completeStart('dev-1');
        installedListener()({ reason: 'update', temporary: false });
        expect(await loggedEvents()).toEqual([
            'logging-enabled',
            'worker-started',
            'browser-restarted',
            'extension-restarted',
        ]);

        resetLifetime();
        storage.session.reset();
        storage.session.restore();
        await completeStart('dev-1');
        DebugLog.record(DEBUG_LOG_EVENT.WakeupProbe, { readyTabs: 0, unavailableTabs: 0 });
        startupListener()();
        expect((await loggedEvents()).slice(4)).toEqual([
            'worker-started',
            'runtime-restarted',
            'wakeup-probe',
            'browser-restarted',
        ]);
    });

    it('persists the build label on every start while the switch is off', async () => {
        await completeStart('beta-1');
        expect(storage.local.data[STORAGE_KEY_DEBUG_LOG_SWITCH]).toEqual({
            version: DEBUG_LOG_STORE_VERSION,
            enabled: null,
            lastBuildLabel: 'beta-1',
        });
        expect(DebugLogStore.getStatus().eventCount).toBe(0);
        expect(DebugLogStore.isEnabled()).toBe(false);
    });

    it('applies the dev default exactly like a user "on": snapshot marker first, earlier events discarded', async () => {
        DebugLog.record(DEBUG_LOG_EVENT.WakeupProbe, { readyTabs: 1, unavailableTabs: 0 });
        TabAttributionRegistry.noteTab(TAB);

        await completeStart('dev-1', true);

        const lines = await loggedLines();
        expect(eventNamesOf(lines)).toEqual(['logging-enabled', 'worker-started']);
        expect(lines[0]).toContain('enabled=true');
        expect(lines[0]).toContain('mode=server');
        expect(lines[0]).toContain('provider=openrouter');
        expect(lines[0]).toContain('model=openrouter:preset');
        expect(lines[0]).toContain('locale=en-US');
        expect(lines[0]).toContain('liveTabs=1');
        expect(DebugLogStore.getStatus()).toMatchObject({ enabled: true, enabledAtMs: NOW_MS });
        expect(storage.local.data[STORAGE_KEY_DEBUG_LOG_SWITCH]).toMatchObject({
            enabled: true,
            lastBuildLabel: 'dev-1',
        });
        // Live content contexts bootstrapped before the default was applied
        // learn the new state through the same push a user "on" sends.
        expect(broadcastMocks.notifyStateChanged).toHaveBeenCalledWith(true);

        resetLifetime();
        broadcastMocks.notifyStateChanged.mockClear();
        await completeStart('dev-1', true);
        expect(await loggedEvents()).toEqual([
            'logging-enabled',
            'worker-started',
            'worker-started',
        ]);
        expect(broadcastMocks.notifyStateChanged).not.toHaveBeenCalled();
    });

    it('writes the logger markers at the switch boundaries and stays idempotent', async () => {
        await DebugLogStore.ready(false);
        DebugLog.open();

        const enabled = await DebugLogLifecycle.enable(NOW_MS);
        expect(enabled.enabled).toBe(true);
        DebugLog.record(DEBUG_LOG_EVENT.WakeupProbe, { readyTabs: 0, unavailableTabs: 0 });
        await DebugLogLifecycle.enable(NOW_MS + 1);
        const disabled = await DebugLogLifecycle.disable(NOW_MS + 2);
        expect(disabled.enabled).toBe(false);
        DebugLog.record(DEBUG_LOG_EVENT.WakeupProbe, { readyTabs: 0, unavailableTabs: 0 });
        await DebugLogLifecycle.disable(NOW_MS + 3);

        const lines = await loggedLines();
        expect(eventNamesOf(lines)).toEqual([
            'logging-enabled',
            'wakeup-probe',
            'logging-disabled',
        ]);
        expect(lines[2]).toContain('enabled=false');
        expect(probeMocks.collect).toHaveBeenCalledTimes(2);
    });

    it('still opens the facade and records worker-started when the enable snapshot fails', async () => {
        probeMocks.collect.mockRejectedValueOnce(new Error('prefs unavailable'));

        await expect(completeStart('dev-1', true)).resolves.toBeUndefined();

        expect(DebugLogStore.isEnabled()).toBe(false);
        DebugLog.record(DEBUG_LOG_EVENT.WakeupProbe, { readyTabs: 0, unavailableTabs: 0 });
        await DebugLog.drain();
        expect(DebugLogStore.getStatus().eventCount).toBe(0);
    });
});
