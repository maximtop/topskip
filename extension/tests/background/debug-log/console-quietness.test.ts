import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const installationMocks = vi.hoisted(() => ({
    loadFresh: vi.fn(),
    save: vi.fn(),
    clear: vi.fn(),
}));

vi.mock('@/background/storage/server-installation-storage', () => ({
    ServerInstallationStorage: installationMocks,
}));

const storeMocks = vi.hoisted(() => ({
    ready: vi.fn().mockResolvedValue(undefined),
    isHydrated: vi.fn(() => true),
    isEnabled: vi.fn(() => false),
    append: vi.fn(),
    noteDropped: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/background/debug-log/debug-log-store', () => ({
    DebugLogStore: storeMocks,
}));

const registryMocks = vi.hoisted(() => ({
    ready: vi.fn().mockResolvedValue(undefined),
    noteTab: vi.fn(),
    noteSender: vi.fn(),
    isIncognitoSync: vi.fn((): boolean | null => false),
    allowContentEvent: vi.fn(() => true),
    countKnownNonIncognito: vi.fn(() => 1),
}));

vi.mock('@/background/debug-log/tab-attribution-registry', () => ({
    TabAttributionRegistry: registryMocks,
}));

const browserMocks = vi.hoisted(() => ({
    getManifest: vi.fn(() => ({ version: '0.1.0' })),
    query: vi.fn(),
    sendMessage: vi.fn(),
    executeScript: vi.fn(),
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

const prefsMocks = vi.hoisted(() => ({
    ready: vi.fn().mockResolvedValue(undefined),
    load: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/background/storage/prefs-sync', () => ({
    PrefsSyncStorage: prefsMocks,
}));

const detectionStoreMocks = vi.hoisted(() => ({
    set: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/background/promo-detection-store', () => ({
    PromoDetectionStore: detectionStoreMocks,
}));

const providerRegistryMocks = vi.hoisted(() => ({
    get: vi.fn(),
}));

vi.mock('@/background/providers/default-registry', () => ({
    defaultRegistry: { get: providerRegistryMocks.get },
}));

vi.mock('@/background/captions/log-transcript-dev', () => ({
    logTranscriptForDeveloper: vi.fn(),
}));

import type { Runtime } from 'webextension-polyfill';

import { DebugLog } from '@/background/debug-log/debug-log';
import { ContentScriptReattach } from '@/background/lifecycle/content-script-reattach';
import { ContentScriptWakeup } from '@/background/lifecycle/content-script-wakeup';
import { CaptionRuntimeMessages } from '@/background/messaging/caption-runtime-messages';
import { PromoAnalysis } from '@/background/messaging/promo-analysis';
import { PROVIDER_AVAILABILITY } from '@/background/providers/llm-provider-adapter';
import type { LlmProviderAdapter } from '@/background/providers/llm-provider-adapter';
import { ServerAnalysisClient } from '@/background/server-analysis-client';
import { ANALYSIS_MODE, LOG_PREFIX_CAPTIONS } from '@/shared/constants';
import { CONTENT_SCRIPT_PROTOCOL_VERSION } from '@/shared/messages';
import { PROVIDER_ID } from '@/shared/providers';
import { PROMO_DETECTION_STATUS } from '@topskip/common/promo-types';
import { expectOnlyStartupLine, spyOnAllConsole } from '../../helpers/console-spy';
import { makeContentSender } from '../../helpers/runtime-senders';

const fetchMock =
    vi.fn<(...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>>();
const TOKEN = 'a'.repeat(43);
const TOKEN_EXPIRY_MS = 4_102_444_800_000;
const VIDEO_ID = 'dQw4w9WgXcQ';
const TAB_ID = 7;
const WATCH_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const IDENTITY = {
    videoId: VIDEO_ID,
    languageCode: 'en-us',
    // SHA-256 of the canonicalized single-segment 'hello' transcript below,
    // so the echoed identity passes the client's response validation.
    transcriptHash:
        'e558391f191061d4cede4782fbdcf0292672debba25406394bb5777b992abd2c',
    algorithmVersion: 'server-v6',
};
const ANALYSIS_INPUT = {
    videoId: VIDEO_ID,
    durationSec: 213,
    extensionVersion: '0.1.0',
    languageCode: 'en-us',
    segments: [{ startSec: 0, durationSec: 1, text: 'hello' }],
};
const PROCESSING_RESPONSE = {
    status: 'processing' as const,
    ...IDENTITY,
    jobId: 'job-server-v6',
    pollAfterSec: 3,
};
const CURRENT_ACK = {
    ok: true,
    protocolVersion: CONTENT_SCRIPT_PROTOCOL_VERSION,
    extensionVersion: '0.1.0',
};
const PROVIDER_BODY = 'OpenRouter HTTP 500: PROVIDER_BODY_SENTINEL';
const PROMO_ANALYSIS_FAILED_CODE = 'promo-analysis-failed';

/**
 * Minimal BYOK adapter whose analysis call rejects with a body-bearing error.
 *
 * @returns Adapter double for the provider registry mock.
 */
function makeRejectingAdapter(): LlmProviderAdapter {
    return {
        id: PROVIDER_ID.OpenRouter,
        displayName: 'TestAdapter',
        availability: vi.fn().mockResolvedValue(PROVIDER_AVAILABILITY.AVAILABLE),
        maxTranscriptChars: vi.fn().mockResolvedValue(Number.MAX_SAFE_INTEGER),
        analyzeTranscript: vi.fn().mockRejectedValue(new Error(PROVIDER_BODY)),
    };
}

/**
 * Minimal BYOK adapter whose analysis resolves with a no-promo result, so the
 * byok-run-started / byok-chunk / byok-run-ended metadata path runs to the end.
 *
 * @returns Adapter double for the provider registry mock.
 */
function makeSucceedingAdapter(): LlmProviderAdapter {
    return {
        id: PROVIDER_ID.OpenRouter,
        displayName: 'TestAdapter',
        availability: vi.fn().mockResolvedValue(PROVIDER_AVAILABILITY.AVAILABLE),
        maxTranscriptChars: vi.fn().mockResolvedValue(Number.MAX_SAFE_INTEGER),
        analyzeTranscript: vi.fn().mockResolvedValue({
            ok: true,
            hasPromo: false,
            providerMeta: { id: PROVIDER_ID.OpenRouter, model: 'test-model' },
            rawAssistant: '',
        }),
    };
}

/**
 * Caption payload of the `ok: true` shape used to start a BYOK run.
 *
 * @returns Successful captions payload for the analysis entry points.
 */
function captionsPayload(): Parameters<typeof PromoAnalysis.onCaptionsReady>[1] {
    return {
        ok: true,
        videoId: VIDEO_ID,
        languageCode: 'en',
        segments: [{ text: 'Hello world', startSec: 0, durationSec: 2 }],
    };
}

/**
 * Sender for a trusted content tab.
 *
 * @returns Message sender as Chrome would populate it.
 */
function contentSender(): Runtime.MessageSender {
    return makeContentSender({ tabId: TAB_ID, videoId: VIDEO_ID });
}

/**
 * Drives a Server-mode analysis request (202 processing) with tab attribution.
 *
 * @returns Promise settled when the analysis request resolved.
 */
async function driveServerAnalysis(): Promise<void> {
    installationMocks.loadFresh.mockResolvedValue({
        token: TOKEN,
        expiresAtMs: TOKEN_EXPIRY_MS,
    });
    fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify(PROCESSING_RESPONSE), { status: 202 }),
    );
    await ServerAnalysisClient.requestAnalysis({
        ...ANALYSIS_INPUT,
        tabId: TAB_ID,
    });
}

describe('console quietness (FR-037, release-like flags)', () => {
    let spies: ReturnType<typeof spyOnAllConsole>;

    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('fetch', fetchMock);
        storeMocks.isEnabled.mockReturnValue(false);
        registryMocks.isIncognitoSync.mockReturnValue(false);
        prefsMocks.load.mockResolvedValue({
            enabled: true,
            providerId: PROVIDER_ID.OpenRouter,
            analysisMode: ANALYSIS_MODE.Byok,
            activeModelId: 'openrouter:test-model',
        });
        browserMocks.query.mockResolvedValue([]);
        browserMocks.sendMessage.mockResolvedValue(CURRENT_ACK);
        browserMocks.executeScript.mockResolvedValue([{ result: false, frameId: 0 }]);
        DebugLog.resetForTest();
        DebugLog.open();
        spies = spyOnAllConsole();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('Server-mode HTTP + delivery emits no console line (switch off)', async () => {
        await driveServerAnalysis();

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expectOnlyStartupLine(spies);
        expect(storeMocks.append).not.toHaveBeenCalled();
    });

    it('Server-mode flow emits no console line with the switch on', async () => {
        storeMocks.isEnabled.mockReturnValue(true);

        await driveServerAnalysis();

        // Recording happened (http-start/http-response reached the store) …
        expect(storeMocks.append).toHaveBeenCalled();
        // … and nothing was printed: records never mirror to the console in
        // release-like builds.
        expectOnlyStartupLine(spies);
    });

    it('a caption failure prints one warn with a stable reason only', async () => {
        await CaptionRuntimeMessages.handle(
            {
                ok: false,
                videoId: VIDEO_ID,
                reason: 'capture-timeout',
                error: 'https://x/timedtext?pot=SIGNED_URL_PARAM_SENTINEL',
            },
            contentSender(),
        );

        expect(spies.warn.mock.calls).toEqual([[LOG_PREFIX_CAPTIONS, 'capture-timeout']]);
        expect(spies.error).not.toHaveBeenCalled();
        expect(spies.log).not.toHaveBeenCalled();
        expect(spies.info).not.toHaveBeenCalled();
        expect(spies.debug).not.toHaveBeenCalled();
        expect(JSON.stringify(spies.warn.mock.calls)).not.toContain('SIGNED_URL_PARAM_SENTINEL');
    });

    it('an unexpected promo-analysis exception prints one stable error code', async () => {
        providerRegistryMocks.get.mockReturnValue(makeRejectingAdapter());

        PromoAnalysis.onCaptionsReady(contentSender(), captionsPayload());
        await vi.waitFor(() => {
            expect(spies.error).toHaveBeenCalled();
        });

        expect(spies.error.mock.calls).toEqual([
            ['[TopSkip] Promo analysis failed', PROMO_ANALYSIS_FAILED_CODE],
        ]);
        expect(JSON.stringify(spies.error.mock.calls)).not.toContain('PROVIDER_BODY_SENTINEL');
        expect(spies.warn).not.toHaveBeenCalled();
        expect(spies.log).not.toHaveBeenCalled();
        expect(spies.info).not.toHaveBeenCalled();
        expect(spies.debug).not.toHaveBeenCalled();
    });

    it('reattach + wakeup emit no console line', async () => {
        browserMocks.query.mockResolvedValue([
            { id: 41, url: WATCH_URL, incognito: false },
        ]);

        await ContentScriptReattach.handleRequest();
        await ContentScriptWakeup.notifyExistingTabs();

        expect(browserMocks.sendMessage).toHaveBeenCalled();
        expectOnlyStartupLine(spies);
    });

    it('BYOK metadata path prints nothing with the switch on', async () => {
        storeMocks.isEnabled.mockReturnValue(true);
        providerRegistryMocks.get.mockReturnValue(makeSucceedingAdapter());

        PromoAnalysis.onCaptionsReady(contentSender(), captionsPayload());
        await vi.waitFor(() => {
            expect(detectionStoreMocks.set).toHaveBeenLastCalledWith(
                TAB_ID,
                expect.objectContaining({ status: PROMO_DETECTION_STATUS.NoPromo }),
            );
        });

        // byok-run-started / byok-chunk / byok-run-ended reached the store …
        expect(storeMocks.append).toHaveBeenCalled();
        // … and none of them was mirrored to the console.
        expectOnlyStartupLine(spies);
    });

    it('a successful caption payload prints nothing (switch off)', async () => {
        providerRegistryMocks.get.mockReturnValue(makeSucceedingAdapter());

        await CaptionRuntimeMessages.handle(captionsPayload(), contentSender());
        await vi.waitFor(() => {
            expect(detectionStoreMocks.set).toHaveBeenLastCalledWith(
                TAB_ID,
                expect.objectContaining({ status: PROMO_DETECTION_STATUS.NoPromo }),
            );
        });

        expectOnlyStartupLine(spies);
        expect(storeMocks.append).not.toHaveBeenCalled();
    });
});
