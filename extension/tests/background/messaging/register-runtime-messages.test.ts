import { beforeEach, describe, expect, it, vi } from 'vitest';

// The real sender-trust check runs inside the dispatcher, so the mocked
// runtime id must match the id the sender helpers stamp on their senders.
const browserMocks = await vi.hoisted(async () => {
    const { EXTENSION_ID } = await import('../../helpers/runtime-senders');
    return {
        extensionId: EXTENSION_ID,
        addListener: vi.fn(),
        getManifest: vi.fn(() => ({ version: '0.1.0' })),
    };
});

vi.mock('@/shared/browser', () => ({
    default: {
        runtime: {
            id: browserMocks.extensionId,
            getURL: (): string => `chrome-extension://${browserMocks.extensionId}/`,
            getManifest: browserMocks.getManifest,
            onMessage: { addListener: browserMocks.addListener },
        },
    },
}));

const debugLogMocks = vi.hoisted(() => ({
    record: vi.fn(),
    registryReady: vi.fn().mockResolvedValue(undefined),
    registryNoteSender: vi.fn(),
    registryIsIncognitoSync: vi.fn((): boolean | null => null),
}));

vi.mock('@/background/debug-log/debug-log', () => ({
    DebugLog: { record: debugLogMocks.record },
}));
vi.mock('@/background/debug-log/tab-attribution-registry', () => ({
    TabAttributionRegistry: {
        ready: debugLogMocks.registryReady,
        noteSender: debugLogMocks.registryNoteSender,
        isIncognitoSync: debugLogMocks.registryIsIncognitoSync,
    },
}));
vi.mock('@/background/messaging/debug-log-runtime-messages', () => ({
    DebugLogRuntimeMessages: {
        handleAppend: vi.fn().mockResolvedValue({ ok: true, enabled: false }),
        handleGetStatus: vi.fn(),
        handleGetPreview: vi.fn(),
        handleGetBundle: vi.fn(),
        handleSetEnabled: vi.fn(),
        handleDevSeed: vi.fn(),
    },
}));

const prefsHandlerMocks = vi.hoisted(() => ({
    handleGet: vi.fn().mockResolvedValue({ ok: true, prefs: {}, debugLogEnabled: false }),
}));

vi.mock('@/background/messaging/runtime-messages', () => ({
    PrefsRuntimeMessages: {
        handleGet: prefsHandlerMocks.handleGet,
        handleSet: vi.fn(),
        handleSetAnalysisMode: vi.fn(),
    },
}));
vi.mock('@/background/storage/background-storage-access', () => ({
    BackgroundStorageAccess: { ready: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@/background/lifecycle/content-script-reattach', () => ({
    ContentScriptReattach: { handleRequest: vi.fn() },
}));
vi.mock('@/background/messaging/misc-runtime-messages', () => ({
    ContentLogMessages: { log: vi.fn() },
    PromoDetectionRuntimeMessages: { handleGet: vi.fn(), handleDevSet: vi.fn() },
}));
vi.mock('@/background/messaging/caption-runtime-messages', () => ({
    CaptionRuntimeMessages: { handle: vi.fn() },
}));
vi.mock('@/background/messaging/byok-setup-runtime-messages', () => ({
    ByokSetupRuntimeMessages: { handle: vi.fn(), setRegistry: vi.fn() },
}));
vi.mock('@/background/messaging/chrome-prompt-api-runtime-messages', () => ({
    ChromePromptApiRuntimeMessages: {},
}));
vi.mock('@/background/messaging/model-runtime-messages', () => ({
    ModelRuntimeMessages: {},
}));
vi.mock('@/background/messaging/openrouter-runtime-messages', () => ({
    OpenRouterRuntimeMessages: {},
}));
vi.mock('@/background/messaging/promo-analysis', () => ({
    PromoAnalysis: { setRegistry: vi.fn() },
}));
vi.mock('@/background/messaging/provider-runtime-messages', () => ({
    ProviderRuntimeMessages: { setRegistry: vi.fn() },
}));
vi.mock('@/background/messaging/server-analysis-runtime-messages', () => ({
    ServerAnalysisRuntimeMessages: {},
}));
vi.mock('@/background/server-analysis-issue-report', () => ({
    ServerAnalysisIssueReport: {},
}));

import { registerRuntimeMessages } from '@/background/messaging/register-runtime-messages';
import { DEBUG_LOG_EVENT } from '@/shared/debug-log-events';
import {
    CONTENT_SCRIPT_PROTOCOL_VERSION,
    TOPSKIP_MESSAGE,
} from '@/shared/messages';
import { makeContentSender, makeOptionsSender } from '../../helpers/runtime-senders';

type Listener = (message: unknown, sender: unknown) => Promise<unknown> | undefined;

/**
 * Registers the dispatcher and returns the listener it installed.
 */
function installDispatcher(): Listener {
    registerRuntimeMessages({} as never);
    const listener = browserMocks.addListener.mock.calls.at(-1)?.[0] as Listener | undefined;
    if (listener === undefined) {
        throw new Error('runtime.onMessage listener not registered');
    }
    return listener;
}

describe('dispatchRuntimeMessage content-ready barrier', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        debugLogMocks.registryIsIncognitoSync.mockReturnValue(null);
    });

    it('records content-ready once for the first message of a content tab', async () => {
        const dispatch = installDispatcher();
        const sender = makeContentSender({ tabId: 12, videoId: 'dQw4w9WgXcQ' });

        await dispatch({ type: TOPSKIP_MESSAGE.GET_PREFS }, sender);

        expect(debugLogMocks.registryNoteSender).toHaveBeenCalledWith(sender);
        expect(debugLogMocks.record).toHaveBeenCalledWith(
            DEBUG_LOG_EVENT.ContentReady,
            { protocol: CONTENT_SCRIPT_PROTOCOL_VERSION, extensionVersion: '0.1.0' },
            { tab: 12 },
        );
        expect(prefsHandlerMocks.handleGet).toHaveBeenCalledTimes(1);

        debugLogMocks.registryIsIncognitoSync.mockReturnValue(false);
        await dispatch({ type: TOPSKIP_MESSAGE.GET_PREFS }, sender);
        expect(debugLogMocks.record).toHaveBeenCalledTimes(1);
    });

    it('never notes or logs an extension page sender', async () => {
        const dispatch = installDispatcher();

        await dispatch({ type: TOPSKIP_MESSAGE.GET_PREFS }, makeOptionsSender({ tabId: 3 }));

        expect(debugLogMocks.registryNoteSender).not.toHaveBeenCalled();
        expect(debugLogMocks.record).not.toHaveBeenCalled();
    });
});
