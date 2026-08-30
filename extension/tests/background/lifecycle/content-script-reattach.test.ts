import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const browserMocks = vi.hoisted(() => ({
    getManifest: vi.fn(() => ({ version: '0.1.0' })),
    query: vi.fn(),
    sendMessage: vi.fn(),
    executeScript: vi.fn(),
}));

const logMocks = vi.hoisted(() => ({
    info: vi.fn(),
    warn: vi.fn(),
}));

vi.mock('@/shared/browser', () => ({
    default: {
        runtime: { getManifest: browserMocks.getManifest },
        tabs: {
            query: browserMocks.query,
            sendMessage: browserMocks.sendMessage,
        },
        scripting: { executeScript: browserMocks.executeScript },
    },
}));

vi.mock('@/background/server-analysis-log', () => ({
    BackgroundServerAnalysisLog: logMocks,
}));

const debugLogMocks = vi.hoisted(() => ({
    record: vi.fn(),
    noteTab: vi.fn(),
}));

vi.mock('@/background/debug-log/debug-log', () => ({
    DebugLog: { record: debugLogMocks.record },
}));

vi.mock('@/background/debug-log/tab-attribution-registry', () => ({
    TabAttributionRegistry: { noteTab: debugLogMocks.noteTab },
}));

import {
    CONTENT_SCRIPT_REATTACH_PROBE_TIMEOUT_MS,
    CONTENT_SCRIPT_REATTACH_SETTLE_TIMEOUT_MS,
    ContentScriptReattach,
} from '@/background/lifecycle/content-script-reattach';
import { CAPTION_PAGE_BRIDGE_INSTALL_FLAG } from '@/shared/caption-page-bridge-flags';
import { CONTENT_SCRIPT_BUNDLE } from '@/shared/content-script-bundles';
import { DEBUG_LOG_EVENT } from '@/shared/debug-log-events';
import {
    CONTENT_SCRIPT_PROTOCOL_VERSION,
    CONTENT_SCRIPT_REATTACH_OUTCOME,
    TOPSKIP_MESSAGE,
} from '@/shared/messages';

const TAB_ID = 41;
const WATCH_URL = 'https://www.youtube.com/watch?v=abc123DEF45';
const CURRENT_ACK = {
    ok: true,
    protocolVersion: CONTENT_SCRIPT_PROTOCOL_VERSION,
    extensionVersion: '0.1.0',
};
const RECEIVING_END_MISSING = new Error(
    'Could not establish connection. Receiving end does not exist.',
);

/**
 * Distinguishes the MAIN-world flag read from the two bundle injections.
 *
 * @param call - One recorded `scripting.executeScript` argument list.
 * @returns Whether the call is the settle probe rather than an injection.
 */
function isFlagProbe(call: unknown[]): boolean {
    const [injection] = call;
    return (
        typeof injection === 'object' &&
        injection !== null &&
        typeof Reflect.get(injection, 'func') === 'function'
    );
}

/**
 * Makes the MAIN-world flag probe report the given install states in order,
 * repeating the last one, while bundle injections resolve successfully.
 *
 * @param installedStates - Successive flag values seen by settle polls.
 */
function mockPageBridgeInstalled(installedStates: boolean[]): void {
    let probeIndex = 0;
    browserMocks.executeScript.mockImplementation((injection: unknown) => {
        if (isFlagProbe([injection])) {
            const state =
                installedStates[
                    Math.min(probeIndex, installedStates.length - 1)
                ] ?? false;
            probeIndex += 1;
            return Promise.resolve([{ result: state, frameId: 0 }]);
        }
        return Promise.resolve([{ result: undefined, frameId: 0 }]);
    });
}

/**
 * Lists only the bundle injections in call order.
 *
 * @returns Recorded injection argument objects.
 */
function injectionCalls(): unknown[] {
    return browserMocks.executeScript.mock.calls
        .filter((call) => !isFlagProbe(call))
        .map((call): unknown => call[0]);
}

describe('ContentScriptReattach.handleRequest', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        browserMocks.query.mockResolvedValue([{ id: TAB_ID, url: WATCH_URL }]);
        browserMocks.sendMessage.mockRejectedValue(RECEIVING_END_MISSING);
        mockPageBridgeInstalled([false]);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('reports no active tab without probing or injecting', async () => {
        browserMocks.query.mockResolvedValue([]);

        await expect(ContentScriptReattach.handleRequest()).resolves.toEqual({
            ok: true,
            tabId: null,
            outcome: CONTENT_SCRIPT_REATTACH_OUTCOME.NoActiveTab,
        });
        expect(browserMocks.sendMessage).not.toHaveBeenCalled();
        expect(browserMocks.executeScript).not.toHaveBeenCalled();
        expect(debugLogMocks.noteTab).not.toHaveBeenCalled();
        expect(debugLogMocks.record).toHaveBeenCalledWith(
            DEBUG_LOG_EVENT.Reattach,
            { outcome: CONTENT_SCRIPT_REATTACH_OUTCOME.NoActiveTab },
            {},
        );
    });

    it('never injects when Chrome hides the active tab URL', async () => {
        browserMocks.query.mockResolvedValue([{ id: TAB_ID, incognito: false }]);

        await expect(ContentScriptReattach.handleRequest()).resolves.toEqual({
            ok: true,
            tabId: TAB_ID,
            outcome: CONTENT_SCRIPT_REATTACH_OUTCOME.UrlUnavailable,
        });
        expect(browserMocks.sendMessage).not.toHaveBeenCalled();
        expect(browserMocks.executeScript).not.toHaveBeenCalled();
        expect(debugLogMocks.noteTab).toHaveBeenCalledWith(
            expect.objectContaining({ id: TAB_ID, incognito: false }),
        );
        expect(debugLogMocks.record).toHaveBeenCalledWith(
            DEBUG_LOG_EVENT.Reattach,
            { outcome: CONTENT_SCRIPT_REATTACH_OUTCOME.UrlUnavailable },
            { tab: TAB_ID },
        );
    });

    it('logs already_attached and reattached outcomes with the tab id', async () => {
        browserMocks.sendMessage.mockResolvedValue(CURRENT_ACK);
        await ContentScriptReattach.handleRequest();
        expect(debugLogMocks.record).toHaveBeenLastCalledWith(
            DEBUG_LOG_EVENT.Reattach,
            { outcome: CONTENT_SCRIPT_REATTACH_OUTCOME.AlreadyAttached },
            { tab: TAB_ID },
        );

        browserMocks.sendMessage.mockRejectedValue(RECEIVING_END_MISSING);
        await ContentScriptReattach.handleRequest();
        expect(debugLogMocks.record).toHaveBeenLastCalledWith(
            DEBUG_LOG_EVENT.Reattach,
            { outcome: CONTENT_SCRIPT_REATTACH_OUTCOME.Reattached },
            { tab: TAB_ID },
        );
        expect(debugLogMocks.record).toHaveBeenCalledTimes(2);
    });

    it('logs failures as stable codes and never the API error text', async () => {
        browserMocks.executeScript.mockImplementation((injection: unknown) =>
            isFlagProbe([injection])
                ? Promise.resolve([{ result: false, frameId: 0 }])
                : Promise.reject(new Error('Cannot access contents of the page')),
        );
        await ContentScriptReattach.handleRequest();
        expect(debugLogMocks.record).toHaveBeenLastCalledWith(
            DEBUG_LOG_EVENT.Reattach,
            { outcome: 'inject_failed' },
            { tab: TAB_ID },
        );

        browserMocks.query.mockRejectedValue(new Error('tabs unavailable'));
        await ContentScriptReattach.handleRequest();
        expect(debugLogMocks.record).toHaveBeenLastCalledWith(
            DEBUG_LOG_EVENT.Reattach,
            { outcome: 'tabs_unavailable' },
            {},
        );
        expect(JSON.stringify(debugLogMocks.record.mock.calls)).not.toContain('Cannot access');
        expect(JSON.stringify(debugLogMocks.record.mock.calls)).not.toContain('tabs unavailable');
    });

    it.each([
        'https://github.com/maximtop/topskip',
        'https://www.youtube.com.evil.example/watch?v=abc',
        'https://user:pass@www.youtube.com/watch?v=abc',
        'chrome://extensions/',
    ])('refuses an unsupported document %s', async (url) => {
        browserMocks.query.mockResolvedValue([{ id: TAB_ID, url }]);

        await expect(ContentScriptReattach.handleRequest()).resolves.toEqual({
            ok: true,
            tabId: TAB_ID,
            outcome: CONTENT_SCRIPT_REATTACH_OUTCOME.UnsupportedPage,
        });
        expect(browserMocks.executeScript).not.toHaveBeenCalled();
    });

    it('leaves a tab with a live current bundle alone', async () => {
        browserMocks.sendMessage.mockResolvedValue(CURRENT_ACK);

        await expect(ContentScriptReattach.handleRequest()).resolves.toEqual({
            ok: true,
            tabId: TAB_ID,
            outcome: CONTENT_SCRIPT_REATTACH_OUTCOME.AlreadyAttached,
        });
        expect(browserMocks.sendMessage).toHaveBeenCalledWith(TAB_ID, {
            type: TOPSKIP_MESSAGE.CONTENT_SCRIPT_READY,
        });
        expect(browserMocks.executeScript).not.toHaveBeenCalled();
    });

    it('injects MAIN before ISOLATED when no bundle answers', async () => {
        await expect(ContentScriptReattach.handleRequest()).resolves.toEqual({
            ok: true,
            tabId: TAB_ID,
            outcome: CONTENT_SCRIPT_REATTACH_OUTCOME.Reattached,
        });
        expect(injectionCalls()).toEqual([
            {
                target: { tabId: TAB_ID },
                files: [CONTENT_SCRIPT_BUNDLE.MainBridge],
                world: 'MAIN',
            },
            {
                target: { tabId: TAB_ID },
                files: [CONTENT_SCRIPT_BUNDLE.IsolatedWatch],
                world: 'ISOLATED',
            },
        ]);
        expect(logMocks.info).toHaveBeenCalledWith(
            'content-script-reattached',
            { tabId: TAB_ID },
        );
    });

    it('reads the bridge flag in the MAIN world with only the flag name', async () => {
        await ContentScriptReattach.handleRequest();

        const probe = browserMocks.executeScript.mock.calls.find(isFlagProbe);
        expect(probe?.[0]).toMatchObject({
            target: { tabId: TAB_ID },
            world: 'MAIN',
            args: [CAPTION_PAGE_BRIDGE_INSTALL_FLAG],
        });
    });

    it('replaces a stale bundle that answers with another version', async () => {
        browserMocks.sendMessage.mockResolvedValue({
            ...CURRENT_ACK,
            extensionVersion: '0.0.9',
        });

        const pending = ContentScriptReattach.handleRequest();
        await vi.advanceTimersByTimeAsync(CONTENT_SCRIPT_REATTACH_PROBE_TIMEOUT_MS);

        await expect(pending).resolves.toMatchObject({
            outcome: CONTENT_SCRIPT_REATTACH_OUTCOME.Reattached,
        });
        expect(injectionCalls()).toHaveLength(2);
    });

    it('waits for an orphaned bridge to retire before injecting', async () => {
        mockPageBridgeInstalled([true, true, false]);

        const pending = ContentScriptReattach.handleRequest();
        await vi.advanceTimersByTimeAsync(0);
        expect(injectionCalls()).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(CONTENT_SCRIPT_REATTACH_SETTLE_TIMEOUT_MS);

        await expect(pending).resolves.toMatchObject({
            outcome: CONTENT_SCRIPT_REATTACH_OUTCOME.Reattached,
        });
        expect(injectionCalls()).toHaveLength(2);
        expect(logMocks.warn).not.toHaveBeenCalled();
    });

    it('injects anyway once the settle window elapses on a flag that never clears', async () => {
        mockPageBridgeInstalled([true]);

        const pending = ContentScriptReattach.handleRequest();
        await vi.advanceTimersByTimeAsync(CONTENT_SCRIPT_REATTACH_SETTLE_TIMEOUT_MS);
        await vi.advanceTimersByTimeAsync(CONTENT_SCRIPT_REATTACH_SETTLE_TIMEOUT_MS);

        await expect(pending).resolves.toMatchObject({
            outcome: CONTENT_SCRIPT_REATTACH_OUTCOME.Reattached,
        });
        expect(injectionCalls()).toHaveLength(2);
        expect(logMocks.warn).toHaveBeenCalledWith(
            'content-script-reattach-settle-timeout',
            { tabId: TAB_ID },
        );
    });

    it('reports an injection failure instead of claiming success', async () => {
        browserMocks.executeScript.mockImplementation((injection: unknown) =>
            isFlagProbe([injection])
                ? Promise.resolve([{ result: false, frameId: 0 }])
                : Promise.reject(new Error('Cannot access contents of the page')),
        );

        await expect(ContentScriptReattach.handleRequest()).resolves.toEqual({
            ok: false,
            error: 'Cannot access contents of the page',
        });
        expect(logMocks.warn).toHaveBeenCalledWith(
            'content-script-reattach-failed',
            { tabId: TAB_ID, error: 'Cannot access contents of the page' },
        );
    });

    it('reports a tabs API failure', async () => {
        browserMocks.query.mockRejectedValue(new Error('tabs unavailable'));

        await expect(ContentScriptReattach.handleRequest()).resolves.toEqual({
            ok: false,
            error: 'tabs unavailable',
        });
    });

    it('coalesces concurrent requests for the same tab into one injection', async () => {
        const first = ContentScriptReattach.handleRequest();
        const second = ContentScriptReattach.handleRequest();
        await vi.advanceTimersByTimeAsync(0);

        const results = await Promise.all([first, second]);

        expect(results[0]).toEqual(results[1]);
        expect(injectionCalls()).toHaveLength(2);
        expect(debugLogMocks.record).toHaveBeenCalledTimes(1);
    });

    it('probes again after a completed request', async () => {
        await ContentScriptReattach.handleRequest();
        browserMocks.sendMessage.mockResolvedValue(CURRENT_ACK);

        await expect(ContentScriptReattach.handleRequest()).resolves.toMatchObject({
            outcome: CONTENT_SCRIPT_REATTACH_OUTCOME.AlreadyAttached,
        });
        expect(injectionCalls()).toHaveLength(2);
    });
});
