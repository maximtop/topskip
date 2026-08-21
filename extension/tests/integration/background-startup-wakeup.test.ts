import { describe, expect, it, vi } from 'vitest';

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

vi.mock('@/background/storage/prefs-sync', () => ({
    PrefsSyncStorage: { ready: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@/background/promo-detection-store', () => ({
    PromoDetectionStore: {
        clear: vi.fn().mockResolvedValue(undefined),
        ready: vi.fn().mockResolvedValue(undefined),
    },
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

import { Background } from '@/background/background';
import {
    CONTENT_SCRIPT_PROTOCOL_VERSION,
    TOPSKIP_MESSAGE,
} from '@/shared/messages';

describe('background startup wakeup', () => {
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
});
