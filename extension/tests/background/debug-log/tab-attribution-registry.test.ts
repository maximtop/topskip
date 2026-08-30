import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = await vi.hoisted(async () => {
    const { createMemoryStorageArea } = await import(
        '../../helpers/memory-storage-area',
    );
    return { session: createMemoryStorageArea() };
});

vi.mock('@/shared/browser', () => ({
    default: {
        storage: {
            session: { get: storage.session.get, set: storage.session.set },
        },
    },
}));

import { TabAttributionRegistry } from '@/background/debug-log/tab-attribution-registry';
import { SESSION_STORAGE_KEY_DEBUG_LOG_TABS } from '@/shared/constants';
import {
    DEBUG_LOG_CEILING_WINDOW_MS,
    DEBUG_LOG_CONTENT_EVENTS_PER_TAB_PER_MINUTE,
} from '@/shared/debug-log-constants';

const NOW_MS = 1_900_000_000_000;
const PERSIST_DELAY_MS = 250;
const NORMAL_TAB = { id: 41, incognito: false, index: 0, highlighted: false,
    active: true, pinned: false, windowId: 1 };
const INCOGNITO_TAB = { ...NORMAL_TAB, id: 42, incognito: true };

/**
 * Simulates an MV3 worker restart while the mocked session storage survives.
 */
async function restartWorker(): Promise<typeof TabAttributionRegistry> {
    vi.resetModules();
    const mod = await import('@/background/debug-log/tab-attribution-registry');
    return mod.TabAttributionRegistry;
}

describe('TabAttributionRegistry', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        storage.session.reset();
        storage.session.restore();
        TabAttributionRegistry.resetForTest();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('knows a tab only after a note and reports unknown tabs as null', async () => {
        await TabAttributionRegistry.ready();
        expect(TabAttributionRegistry.isIncognitoSync(41)).toBeNull();

        TabAttributionRegistry.noteTab(NORMAL_TAB);
        TabAttributionRegistry.noteSender({ tab: INCOGNITO_TAB });

        expect(TabAttributionRegistry.isIncognitoSync(41)).toBe(false);
        expect(TabAttributionRegistry.isIncognitoSync(42)).toBe(true);
        expect(TabAttributionRegistry.countKnownNonIncognito()).toBe(1);
    });

    it('ignores senders and tabs without an id', async () => {
        await TabAttributionRegistry.ready();
        TabAttributionRegistry.noteSender({});
        TabAttributionRegistry.noteTab({ ...NORMAL_TAB, id: undefined });
        expect(TabAttributionRegistry.countKnownNonIncognito()).toBe(0);
    });

    it('mirrors noted tabs into session storage after the coalescing delay', async () => {
        await TabAttributionRegistry.ready();
        TabAttributionRegistry.noteTab(NORMAL_TAB);
        expect(storage.session.set).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(PERSIST_DELAY_MS);

        expect(storage.session.set).toHaveBeenCalledTimes(1);
        expect(storage.session.data[SESSION_STORAGE_KEY_DEBUG_LOG_TABS]).toEqual([
            [41, { incognito: false, windowStartMs: 0, count: 0 }],
        ]);
    });

    it('caps content events per tab inside a fixed one-minute window', async () => {
        await TabAttributionRegistry.ready();
        TabAttributionRegistry.noteTab(NORMAL_TAB);
        const limit = DEBUG_LOG_CONTENT_EVENTS_PER_TAB_PER_MINUTE;
        const windowStart = NOW_MS - (NOW_MS % DEBUG_LOG_CEILING_WINDOW_MS);

        let accepted = 0;
        for (let i = 0; i <= limit; i += 1) {
            if (TabAttributionRegistry.allowContentEvent(41, windowStart + i)) {
                accepted += 1;
            }
        }
        expect(accepted).toBe(limit);

        const nextWindow = windowStart + DEBUG_LOG_CEILING_WINDOW_MS;
        expect(TabAttributionRegistry.allowContentEvent(41, nextWindow)).toBe(true);
        expect(TabAttributionRegistry.allowContentEvent(99, nextWindow)).toBe(false);
    });

    it('releases counters and the flag on forget, persisting immediately', async () => {
        await TabAttributionRegistry.ready();
        TabAttributionRegistry.noteTab(NORMAL_TAB);
        expect(TabAttributionRegistry.allowContentEvent(41, NOW_MS)).toBe(true);

        await TabAttributionRegistry.forget(41);

        expect(TabAttributionRegistry.isIncognitoSync(41)).toBeNull();
        expect(storage.session.data[SESSION_STORAGE_KEY_DEBUG_LOG_TABS]).toEqual([]);
        expect(TabAttributionRegistry.allowContentEvent(41, NOW_MS)).toBe(false);
    });

    it('keeps attribution across a simulated worker restart (session retained)', async () => {
        await TabAttributionRegistry.ready();
        TabAttributionRegistry.noteTab(INCOGNITO_TAB);
        await vi.advanceTimersByTimeAsync(PERSIST_DELAY_MS);

        const Fresh = await restartWorker();
        expect(Fresh.isIncognitoSync(42)).toBeNull();
        await Fresh.ready();
        expect(Fresh.isIncognitoSync(42)).toBe(true);
    });

    it('forgets everything after a simulated extension reload (session wiped)', async () => {
        await TabAttributionRegistry.ready();
        TabAttributionRegistry.noteTab(INCOGNITO_TAB);
        await vi.advanceTimersByTimeAsync(PERSIST_DELAY_MS);
        storage.session.reset();
        storage.session.restore();

        const Fresh = await restartWorker();
        await Fresh.ready();
        expect(Fresh.isIncognitoSync(42)).toBeNull();
        expect(Fresh.allowContentEvent(42, NOW_MS)).toBe(false);
    });

    it('lets an in-memory note win over an older persisted entry', async () => {
        storage.session.data[SESSION_STORAGE_KEY_DEBUG_LOG_TABS] = [
            [41, { incognito: true, windowStartMs: 0, count: 3 }],
            [42, { incognito: true, windowStartMs: 0, count: 3 }],
        ];
        TabAttributionRegistry.noteTab(NORMAL_TAB);
        await TabAttributionRegistry.ready();
        expect(TabAttributionRegistry.isIncognitoSync(41)).toBe(false);
        expect(TabAttributionRegistry.isIncognitoSync(42)).toBe(true);
    });

    it('drops a malformed mirror instead of hydrating it', async () => {
        storage.session.data[SESSION_STORAGE_KEY_DEBUG_LOG_TABS] = [
            [42, { incognito: true, windowStartMs: 0, count: 3 }],
            'garbage',
        ];
        await TabAttributionRegistry.ready();
        expect(TabAttributionRegistry.isIncognitoSync(42)).toBeNull();
    });

    it('forget awaits hydration before deciding and stays silent on storage failure', async () => {
        storage.session.data[SESSION_STORAGE_KEY_DEBUG_LOG_TABS] = [
            [41, { incognito: false, windowStartMs: 0, count: 0 }],
        ];
        storage.session.set.mockRejectedValueOnce(new Error('session unavailable'));
        const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await expect(TabAttributionRegistry.forget(41)).resolves.toBeUndefined();

        expect(TabAttributionRegistry.isIncognitoSync(41)).toBeNull();
        expect(info).not.toHaveBeenCalled();
        expect(warn).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
        vi.restoreAllMocks();
    });
});
