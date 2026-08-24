import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const browserMocks = vi.hoisted(() => ({
    getManifest: vi.fn(() => ({ version: '0.1.0' })),
    query: vi.fn(),
    sendMessage: vi.fn(),
}));

const logMocks = vi.hoisted(() => ({
    info: vi.fn(),
    warn: vi.fn(),
}));

const debugLogMocks = vi.hoisted(() => ({
    record: vi.fn(),
    noteTab: vi.fn(),
    isIncognitoSync: vi.fn((): boolean | null => null),
}));

vi.mock('@/shared/browser', () => ({
    default: {
        runtime: { getManifest: browserMocks.getManifest },
        tabs: {
            query: browserMocks.query,
            sendMessage: browserMocks.sendMessage,
        },
    },
}));

vi.mock('@/background/server-analysis-log', () => ({
    BackgroundServerAnalysisLog: logMocks,
}));

vi.mock('@/background/debug-log/debug-log', () => ({
    DebugLog: { record: debugLogMocks.record },
}));

vi.mock('@/background/debug-log/tab-attribution-registry', () => ({
    TabAttributionRegistry: {
        noteTab: debugLogMocks.noteTab,
        isIncognitoSync: debugLogMocks.isIncognitoSync,
    },
}));

import { ContentScriptWakeup } from '@/background/lifecycle/content-script-wakeup';
import { DEBUG_LOG_EVENT } from '@/shared/debug-log-events';
import {
    CONTENT_SCRIPT_PROTOCOL_VERSION,
    TOPSKIP_MESSAGE,
} from '@/shared/messages';

const CURRENT_ACK = {
    ok: true,
    protocolVersion: CONTENT_SCRIPT_PROTOCOL_VERSION,
    extensionVersion: '0.1.0',
};

describe('ContentScriptWakeup.notifyExistingTabs', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        browserMocks.query.mockResolvedValue([]);
        browserMocks.sendMessage.mockResolvedValue(CURRENT_ACK);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('queries every tab without requesting URLs and sends readiness only', async () => {
        browserMocks.query.mockResolvedValue([{ id: 41 }, { id: undefined }]);

        await ContentScriptWakeup.notifyExistingTabs();

        expect(browserMocks.query).toHaveBeenCalledWith({});
        expect(browserMocks.sendMessage).toHaveBeenCalledWith(41, {
            type: TOPSKIP_MESSAGE.CONTENT_SCRIPT_READY,
        });
        expect(browserMocks.sendMessage).toHaveBeenCalledOnce();
    });

    it('accepts a valid acknowledgement on the second bounded attempt', async () => {
        browserMocks.query.mockResolvedValue([{ id: 41 }]);
        browserMocks.sendMessage
            .mockRejectedValueOnce(new Error('worker still attaching'))
            .mockResolvedValueOnce(CURRENT_ACK);

        const pending = ContentScriptWakeup.notifyExistingTabs();
        await vi.advanceTimersByTimeAsync(50);
        await pending;

        expect(browserMocks.sendMessage).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['malformed response', { ok: true }],
        [
            'wrong protocol',
            { ...CURRENT_ACK, protocolVersion: CONTENT_SCRIPT_PROTOCOL_VERSION + 1 },
        ],
        ['wrong extension version', { ...CURRENT_ACK, extensionVersion: '0.0.9' }],
    ])('bounds retries for a %s', async (_name, response) => {
        browserMocks.query.mockResolvedValue([{ id: 41 }]);
        browserMocks.sendMessage.mockResolvedValue(response);

        const pending = ContentScriptWakeup.notifyExistingTabs();
        await vi.advanceTimersByTimeAsync(50);
        await pending;

        expect(browserMocks.sendMessage).toHaveBeenCalledTimes(2);
    });

    it.each(['missing receiver', 'closed tab'])(
        'treats a %s as a best-effort miss',
        async () => {
            browserMocks.query.mockResolvedValue([{ id: 41 }]);
            browserMocks.sendMessage.mockRejectedValue(new Error('gone'));

            const pending = ContentScriptWakeup.notifyExistingTabs();
            await vi.advanceTimersByTimeAsync(50);

            await expect(pending).resolves.toBeUndefined();
            expect(browserMocks.sendMessage).toHaveBeenCalledTimes(2);
        },
    );

    it('times out both attempts without leaving timers behind', async () => {
        browserMocks.query.mockResolvedValue([{ id: 41 }]);
        browserMocks.sendMessage.mockReturnValue(new Promise(() => {}));

        const pending = ContentScriptWakeup.notifyExistingTabs();
        await vi.advanceTimersByTimeAsync(350);

        await expect(pending).resolves.toBeUndefined();
        expect(browserMocks.sendMessage).toHaveBeenCalledTimes(2);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('contains a rejected tab query at the startup boundary', async () => {
        browserMocks.query.mockRejectedValue(new Error('tabs unavailable'));

        await expect(
            ContentScriptWakeup.notifyExistingTabs(),
        ).resolves.toBeUndefined();

        expect(browserMocks.sendMessage).not.toHaveBeenCalled();
        expect(logMocks.warn).toHaveBeenCalledWith(
            'content-script-wakeup-query-failed',
            { reason: 'tabs-query-failed' },
        );
    });

    it('notes only acknowledging tabs and logs content-ready for each of them', async () => {
        browserMocks.query.mockResolvedValue([
            { id: 41, incognito: false },
            { id: 42, incognito: true },
            { id: 43, incognito: false },
        ]);
        browserMocks.sendMessage.mockImplementation((tabId: number) =>
            tabId === 43
                ? Promise.reject(new Error('gone'))
                : Promise.resolve(CURRENT_ACK),
        );

        const pending = ContentScriptWakeup.notifyExistingTabs();
        await vi.advanceTimersByTimeAsync(50);
        await pending;

        expect(debugLogMocks.noteTab).toHaveBeenCalledTimes(2);
        expect(debugLogMocks.noteTab).toHaveBeenCalledWith(
            expect.objectContaining({ id: 41, incognito: false }),
        );
        expect(debugLogMocks.noteTab).toHaveBeenCalledWith(
            expect.objectContaining({ id: 42, incognito: true }),
        );
        expect(debugLogMocks.record).toHaveBeenCalledWith(
            DEBUG_LOG_EVENT.ContentReady,
            { protocol: CONTENT_SCRIPT_PROTOCOL_VERSION, extensionVersion: '0.1.0' },
            { tab: 41 },
        );
        expect(debugLogMocks.record).toHaveBeenCalledWith(
            DEBUG_LOG_EVENT.ContentReady,
            { protocol: CONTENT_SCRIPT_PROTOCOL_VERSION, extensionVersion: '0.1.0' },
            { tab: 42 },
        );
        expect(debugLogMocks.record).toHaveBeenLastCalledWith(
            DEBUG_LOG_EVENT.WakeupProbe,
            { readyTabs: 2, unavailableTabs: 1 },
        );
    });

    it('logs the aggregate probe result even when nobody answers', async () => {
        browserMocks.query.mockResolvedValue([{ id: 41 }]);
        browserMocks.sendMessage.mockRejectedValue(new Error('gone'));

        const pending = ContentScriptWakeup.notifyExistingTabs();
        await vi.advanceTimersByTimeAsync(50);
        await pending;

        expect(debugLogMocks.noteTab).not.toHaveBeenCalled();
        expect(debugLogMocks.record).toHaveBeenCalledTimes(1);
        expect(debugLogMocks.record).toHaveBeenCalledWith(
            DEBUG_LOG_EVENT.WakeupProbe,
            { readyTabs: 0, unavailableTabs: 1 },
        );
    });

    it('logs nothing when the tab query fails', async () => {
        browserMocks.query.mockRejectedValue(new Error('tabs unavailable'));

        await ContentScriptWakeup.notifyExistingTabs();

        expect(debugLogMocks.record).not.toHaveBeenCalled();
        expect(debugLogMocks.noteTab).not.toHaveBeenCalled();
    });
});
