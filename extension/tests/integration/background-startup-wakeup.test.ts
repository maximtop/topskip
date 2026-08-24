import { beforeEach, describe, expect, it, vi } from 'vitest';

const startupState = vi.hoisted(
    (): {
        handlersRegistered: boolean;
        pendingTerminalEvent: boolean;
        emittedMessages: unknown[];
        backgroundListener: ((message: unknown) => void) | null;
    } => ({
        handlersRegistered: false,
        pendingTerminalEvent: true,
        emittedMessages: [],
        backgroundListener: null,
    }),
);

const browserMocks = vi.hoisted(() => ({
    addRemovedListener: vi.fn(),
    getManifest: vi.fn(() => ({ version: '0.1.0' })),
    query: vi.fn().mockResolvedValue([{ id: 41 }]),
    sendMessage: vi.fn(),
}));

const debugLogMocks = vi.hoisted(() => ({
    storeReady: vi.fn().mockResolvedValue(undefined),
    storeIsEnabled: vi.fn(() => false),
    lifecycleRegister: vi.fn(),
    markWorkerStarted: vi.fn().mockResolvedValue(undefined),
    record: vi.fn(),
    drain: vi.fn().mockResolvedValue(undefined),
    registryReady: vi.fn().mockResolvedValue(undefined),
    registryNoteTab: vi.fn(),
    registryIsIncognitoSync: vi.fn((): boolean | null => null),
    registryForget: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/shared/browser', () => ({
    default: {
        runtime: { getManifest: browserMocks.getManifest },
        tabs: {
            onRemoved: { addListener: browserMocks.addRemovedListener },
            query: browserMocks.query,
            sendMessage: browserMocks.sendMessage,
        },
    },
}));

vi.mock('@/background/storage/background-storage-access', () => ({
    BackgroundStorageAccess: {
        ready: vi.fn().mockResolvedValue(undefined),
    },
}));

const prefsMocks = vi.hoisted(() => ({
    ready: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/background/storage/prefs-sync', () => ({
    PrefsSyncStorage: prefsMocks,
}));

const detectionMocks = vi.hoisted(() => ({
    clear: vi.fn().mockResolvedValue(undefined),
    ready: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/background/promo-detection-store', () => ({
    PromoDetectionStore: detectionMocks,
}));

vi.mock('@/background/messaging/prefs-port-hub', () => ({
    PrefsPortHub: { register: vi.fn() },
}));

vi.mock('@/background/messaging/promo-analysis', () => ({
    PromoAnalysis: { abortForTab: vi.fn() },
}));

vi.mock('@/background/providers/default-registry', () => ({
    defaultRegistry: {},
}));

vi.mock('@/shared/i18n/i18n', () => ({
    i18n: { init: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@/background/messaging/register-runtime-messages', () => ({
    registerRuntimeMessages: vi.fn(() => {
        startupState.handlersRegistered = true;
        startupState.backgroundListener = (message: unknown): void => {
            startupState.emittedMessages.push(message);
        };
    }),
}));

vi.mock('@/background/server-analysis-log', () => ({
    BackgroundServerAnalysisLog: { info: vi.fn(), warn: vi.fn() },
}));

vi.mock('@/background/debug-log/debug-log-store', () => ({
    DebugLogStore: {
        ready: debugLogMocks.storeReady,
        isEnabled: debugLogMocks.storeIsEnabled,
    },
}));

vi.mock('@/background/debug-log/debug-log-lifecycle', () => ({
    DebugLogLifecycle: {
        register: debugLogMocks.lifecycleRegister,
        markWorkerStarted: debugLogMocks.markWorkerStarted,
    },
}));

vi.mock('@/background/debug-log/debug-log', () => ({
    DebugLog: { record: debugLogMocks.record, drain: debugLogMocks.drain },
}));

vi.mock('@/background/debug-log/tab-attribution-registry', () => ({
    TabAttributionRegistry: {
        ready: debugLogMocks.registryReady,
        noteTab: debugLogMocks.registryNoteTab,
        isIncognitoSync: debugLogMocks.registryIsIncognitoSync,
        forget: debugLogMocks.registryForget,
    },
}));

import { Background } from '@/background/background';
import { DEBUG_LOG_EVENT } from '@/shared/debug-log-events';
import {
    CONTENT_SCRIPT_PROTOCOL_VERSION,
    TOPSKIP_MESSAGE,
} from '@/shared/messages';

/**
 * The `tabs.onRemoved` callback registered by the last `Background.init()`.
 */
function tabRemovedListener(): (tabId: number) => void {
    const listener = browserMocks.addRemovedListener.mock.calls.at(-1)?.[0] as
        | ((tabId: number) => void)
        | undefined;
    if (listener === undefined) {
        throw new Error('tabs.onRemoved listener not registered');
    }
    return listener;
}

describe('background startup wakeup', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        browserMocks.query.mockResolvedValue([{ id: 41 }]);
        debugLogMocks.registryIsIncognitoSync.mockReturnValue(null);
    });

    it('registers handlers before one wake resumes a pending terminal event', async () => {
        browserMocks.sendMessage.mockImplementation(
            (_tabId: number, message: { type?: string }) => {
                expect(startupState.handlersRegistered).toBe(true);
                expect(message).toEqual({
                    type: TOPSKIP_MESSAGE.CONTENT_SCRIPT_READY,
                });
                if (startupState.pendingTerminalEvent) {
                    startupState.pendingTerminalEvent = false;
                    startupState.backgroundListener?.({
                        type: TOPSKIP_MESSAGE.SERVER_ANALYSIS_SESSION_EVENT,
                        payload: {
                            event: 'analysis_interrupted',
                            reason: 'runtime_unavailable',
                            sessionId:
                                '00000000-0000-4000-8000-000000000001',
                            videoId: 'dQw4w9WgXcQ',
                        },
                    });
                }
                return Promise.resolve({
                    ok: true,
                    protocolVersion: CONTENT_SCRIPT_PROTOCOL_VERSION,
                    extensionVersion: '0.1.0',
                });
            },
        );

        Background.init();

        await vi.waitFor(() => {
            expect(browserMocks.sendMessage).toHaveBeenCalledOnce();
        });
        expect(startupState.emittedMessages).toEqual([
            expect.objectContaining({
                type: TOPSKIP_MESSAGE.SERVER_ANALYSIS_SESSION_EVENT,
            }),
        ]);
        expect(
            startupState.emittedMessages.filter(
                (message) =>
                    message !== null &&
                    typeof message === 'object' &&
                    Reflect.get(message, 'type') ===
                        TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS,
            ),
        ).toHaveLength(0);
    });

    it('registers the debug-log lifecycle synchronously and marks the worker started after hydration', async () => {
        browserMocks.sendMessage.mockResolvedValue(undefined);
        let hydrated = false;
        debugLogMocks.storeReady.mockImplementation(() => {
            hydrated = true;
            return Promise.resolve();
        });
        debugLogMocks.markWorkerStarted.mockImplementation(() => {
            expect(hydrated).toBe(true);
            return Promise.resolve();
        });

        Background.init();

        expect(debugLogMocks.lifecycleRegister).toHaveBeenCalledTimes(1);
        expect(debugLogMocks.markWorkerStarted).not.toHaveBeenCalled();
        await vi.waitFor(() => {
            expect(debugLogMocks.markWorkerStarted).toHaveBeenCalledWith('0.1.0');
        });
        expect(debugLogMocks.registryReady).toHaveBeenCalled();
    });

    it('logs tab-closed only for known tabs, drains before forgetting, and keeps detection cleanup', async () => {
        browserMocks.sendMessage.mockResolvedValue(undefined);
        Background.init();
        const onRemoved = tabRemovedListener();
        const order: string[] = [];
        debugLogMocks.drain.mockImplementation(() => {
            order.push('drain');
            return Promise.resolve();
        });
        debugLogMocks.registryForget.mockImplementation(() => {
            order.push('forget');
            return Promise.resolve();
        });

        debugLogMocks.registryIsIncognitoSync.mockReturnValue(false);
        onRemoved(41);
        await vi.waitFor(() => {
            expect(debugLogMocks.registryForget).toHaveBeenCalledWith(41);
        });
        expect(debugLogMocks.record).toHaveBeenCalledWith(
            DEBUG_LOG_EVENT.TabClosed,
            {},
            { tab: 41 },
        );
        expect(order).toEqual(['drain', 'forget']);

        debugLogMocks.record.mockClear();
        debugLogMocks.registryForget.mockClear();
        debugLogMocks.registryIsIncognitoSync.mockReturnValue(null);
        onRemoved(77);
        await vi.waitFor(() => {
            expect(detectionMocks.clear).toHaveBeenCalledWith(77);
        });
        // The real startup wake probe still runs in the background here and
        // records its own aggregate event, so only tab-closed is asserted.
        expect(debugLogMocks.record).not.toHaveBeenCalledWith(
            DEBUG_LOG_EVENT.TabClosed,
            {},
            { tab: 77 },
        );
        expect(debugLogMocks.registryForget).not.toHaveBeenCalled();
    });

    it('records storage-unavailable and keeps the release console error when prefs storage fails', async () => {
        browserMocks.sendMessage.mockResolvedValue(undefined);
        prefsMocks.ready.mockRejectedValueOnce(new Error('gone'));
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'info').mockImplementation(() => {});

        Background.init();

        await vi.waitFor(() => {
            expect(consoleError).toHaveBeenCalledWith(
                '[TopSkip] Background storage is unavailable.',
            );
        });
        expect(debugLogMocks.record).toHaveBeenCalledWith(
            DEBUG_LOG_EVENT.StorageUnavailable,
        );
        expect(JSON.stringify(debugLogMocks.record.mock.calls)).not.toContain('gone');
        consoleError.mockRestore();
    });
});
