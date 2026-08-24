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

const browserMocks = vi.hoisted(() => ({
    getManifest: vi.fn(() => ({ version: '0.1.0' })),
    getPlatformInfo: vi.fn().mockResolvedValue({ os: 'mac', arch: 'arm' }),
    getUILanguage: vi.fn(() => 'en-US'),
    query: vi.fn(),
    sendMessage: vi.fn(),
    executeScript: vi.fn(),
}));

vi.mock('@/shared/browser', () => ({
    default: {
        runtime: {
            id: 'ext-id',
            getURL: (): string => 'chrome-extension://ext-id/',
            getManifest: browserMocks.getManifest,
            getPlatformInfo: browserMocks.getPlatformInfo,
        },
        i18n: { getUILanguage: browserMocks.getUILanguage },
        storage: {
            local: {
                get: storage.local.get,
                set: storage.local.set,
                remove: storage.local.remove,
                setAccessLevel: vi.fn().mockResolvedValue(undefined),
            },
            session: { get: storage.session.get, set: storage.session.set },
        },
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

vi.mock('@/background/promo-detection-store', () => ({
    PromoDetectionStore: {
        set: vi.fn().mockResolvedValue(undefined),
        clear: vi.fn().mockResolvedValue(undefined),
    },
}));

const providerRegistryMocks = vi.hoisted(() => ({
    get: vi.fn(),
}));

vi.mock('@/background/providers/default-registry', () => ({
    defaultRegistry: { get: providerRegistryMocks.get },
}));

const openRouterStorageMocks = vi.hoisted(() => ({
    load: vi.fn(),
    save: vi.fn().mockResolvedValue(undefined),
    maskApiKey: vi.fn(() => '****l'),
}));

vi.mock('@/background/storage/openrouter-storage', () => ({
    OpenRouterStorage: openRouterStorageMocks,
}));

vi.mock('@/background/storage/openai-storage', () => ({
    OpenAiStorage: {
        load: vi.fn().mockResolvedValue({ apiKey: '', model: 'gpt-5.2' }),
        save: vi.fn().mockResolvedValue(undefined),
        maskApiKey: vi.fn(() => '****a'),
    },
}));

vi.mock('@/background/messaging/broadcast-prefs-updated', () => ({
    PrefsBroadcast: { sendUpdatedToAllTabs: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@/background/messaging/prefs-port-hub', () => ({
    PrefsPortHub: { broadcastPrefsUpdate: vi.fn() },
}));

vi.mock('@/background/permissions/provider-host-access', () => ({
    ProviderHostAccess: {
        all: vi.fn().mockResolvedValue({ openrouter: 'granted', openai: 'granted' }),
        isGranted: vi.fn().mockResolvedValue(true),
    },
}));

vi.mock('@/background/captions/log-transcript-dev', () => ({
    logTranscriptForDeveloper: vi.fn(),
}));

import { DebugLog } from '@/background/debug-log/debug-log';
import {
    DebugLogExport,
    EnvironmentProbe,
    type DebugLogEnvironment,
} from '@/background/debug-log/debug-log-export';
import { DebugLogStore } from '@/background/debug-log/debug-log-store';
import { TabAttributionRegistry } from '@/background/debug-log/tab-attribution-registry';
import { ContentScriptReattach } from '@/background/lifecycle/content-script-reattach';
import { CaptionRuntimeMessages } from '@/background/messaging/caption-runtime-messages';
import { ModelRuntimeMessages } from '@/background/messaging/model-runtime-messages';
import { PromoAnalysis } from '@/background/messaging/promo-analysis';
import { PROVIDER_AVAILABILITY } from '@/background/providers/llm-provider-adapter';
import type { LlmProviderAdapter } from '@/background/providers/llm-provider-adapter';
import { CaptureDiagnostics } from '@/content/captions/capture-diagnostics';
import { ANALYSIS_MODE } from '@/shared/constants';
import { DEBUG_LOG_EVENT } from '@/shared/debug-log-events';
import type { DebugLogAppendPayload } from '@/shared/messages';
import { PROVIDER_ID } from '@/shared/providers';
import { makeContentSender } from '../../helpers/runtime-senders';

const NOW_MS = 1_900_000_000_000;
const TAB_ID = 5;
const REATTACH_TAB_ID = 41;
const VIDEO_ID = 'dQw4w9WgXcQ';
const WATCH_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const RECEIVING_END_MISSING = new Error(
    'Could not establish connection. Receiving end does not exist.',
);

/**
 * One sentinel per free-form input class the spec names (SC-002).
 */
const SENTINEL = {
    CaptionBody: 'CAPTION_BODY_SENTINEL',
    TranscriptHash: 'TRANSCRIPT_HASH_deadbeefdeadbeef',
    AssistantText: 'ASSISTANT_TEXT_SENTINEL',
    ApiKey: 'sk-APIKEY-SENTINEL',
    InstallToken: 'INSTALL_TOKEN_SENTINEL',
    Cookie: 'COOKIE_SENTINEL',
    SignedUrl: 'https://x/timedtext?pot=SIGNED_URL_PARAM_SENTINEL',
    ProviderBody: 'PROVIDER_BODY_SENTINEL',
    ValidationText: 'VALIBOT_ERROR_SENTINEL',
    ExecuteScriptUrl: 'chrome-extension://EXECUTE_SCRIPT_URL_SENTINEL',
    PageTitle: 'PAGE_TITLE_SENTINEL',
    FullUserAgent: 'Mozilla/5.0 (X11) FULL_UA_SENTINEL Chrome/139.0.0.0',
} as const;

/**
 * Every sentinel, for the all-emitters sweep.
 */
const SENTINELS: readonly string[] = Object.values(SENTINEL);

/**
 * Environment facts pinned by the suite so header assertions are exact.
 */
const ENV: DebugLogEnvironment = {
    extensionBuild: '0.1.0',
    browserMajor: 139,
    osFamily: 'mac',
    locale: 'en-US',
    analysisMode: ANALYSIS_MODE.Server,
    providerId: PROVIDER_ID.OpenRouter,
    modelId: 'openrouter:test-model',
};

/**
 * Hydrates store and registry, turns the switch on, opens the facade and
 * makes the content tab known (non-incognito) so its events are kept.
 *
 * @returns Promise settled once the logger accepts events.
 */
async function openEnabledLogger(): Promise<void> {
    await DebugLogStore.ready(false);
    await TabAttributionRegistry.ready();
    await DebugLogStore.enable(NOW_MS);
    DebugLog.open();
    TabAttributionRegistry.noteSender(contentSender());
}

/**
 * Flushes everything committed so far and builds the real export bundle.
 *
 * @returns Formatted bundle text.
 */
async function exportBundle(): Promise<string> {
    await DebugLog.drain();
    await DebugLogStore.flush();
    const snapshot = await DebugLogStore.readSnapshot();
    return DebugLogExport.buildBundle(snapshot, ENV, NOW_MS);
}

/**
 * Sender for the trusted content tab.
 *
 * @returns Message sender as Chrome would populate it.
 */
function contentSender(): ReturnType<typeof makeContentSender> {
    return makeContentSender({ tabId: TAB_ID, videoId: VIDEO_ID });
}

/**
 * BYOK adapter returning the given analysis result for every chunk.
 *
 * @param result - Analysis result every `analyzeTranscript` call resolves to.
 * @returns Adapter double for the provider registry mock.
 */
function makeAdapter(
    result: Awaited<ReturnType<LlmProviderAdapter['analyzeTranscript']>>,
): LlmProviderAdapter {
    return {
        id: PROVIDER_ID.OpenRouter,
        displayName: 'TestAdapter',
        availability: vi.fn().mockResolvedValue(PROVIDER_AVAILABILITY.AVAILABLE),
        maxTranscriptChars: vi.fn().mockResolvedValue(Number.MAX_SAFE_INTEGER),
        analyzeTranscript: vi.fn().mockResolvedValue(result),
    };
}

/**
 * Caption payload whose text is the caption-body sentinel.
 *
 * @returns Successful captions payload for the analysis entry points.
 */
function captionsPayload(): Parameters<typeof PromoAnalysis.onCaptionsReady>[1] {
    return {
        ok: true,
        videoId: VIDEO_ID,
        languageCode: 'en',
        segments: [{ text: SENTINEL.CaptionBody, startSec: 0, durationSec: 2 }],
    };
}

/**
 * Runs a BYOK analysis to completion (the detection store mock observes the
 * terminal status) and returns once `byok-run-ended` has been recorded.
 *
 * @param adapter - Adapter double the provider registry serves.
 * @returns Promise settled once the run's end was recorded.
 */
async function driveByokRun(adapter: LlmProviderAdapter): Promise<void> {
    providerRegistryMocks.get.mockReturnValue(adapter);
    PromoAnalysis.onCaptionsReady(contentSender(), captionsPayload());
    await vi.waitFor(async () => {
        const bundle = await exportBundle();
        expect(bundle).toContain(DEBUG_LOG_EVENT.ByokRunEnded);
    });
}

/**
 * Drives every emitter of this suite once with its sentinel.
 *
 * @returns Promise settled once every emitter ran.
 */
async function driveAllEmitters(): Promise<void> {
    await CaptionRuntimeMessages.handle(
        { ok: false, videoId: VIDEO_ID, reason: 'capture-timeout', error: SENTINEL.SignedUrl },
        contentSender(),
    );
    browserMocks.executeScript.mockRejectedValue(new Error(SENTINEL.ExecuteScriptUrl));
    await ContentScriptReattach.handleRequest();
    await driveByokRun(
        makeAdapter({
            ok: false,
            error: `${SENTINEL.ProviderBody} ${SENTINEL.TranscriptHash}`,
            rawAssistant: SENTINEL.AssistantText,
            status: 500,
            kind: 'http',
        }),
    );
    await ModelRuntimeMessages.handleSaveConnectionKey(
        PROVIDER_ID.OpenRouter,
        SENTINEL.ApiKey,
    );
    appendCaptureFailure({
        stage: 'capture-parse-failed',
        reason: 'capture-parse-failed',
        error: SENTINEL.ValidationText,
        title: SENTINEL.PageTitle,
        cookie: SENTINEL.Cookie,
        token: SENTINEL.InstallToken,
    });
}

/**
 * Routes one ISOLATED `capture-failed` stage through the same mapping and
 * append path the runtime uses.
 *
 * @param details - Structured stage details, including free-form inputs.
 */
function appendCaptureFailure(details: Record<string, unknown>): void {
    const mapped = CaptureDiagnostics.toDebugLogEvent('capture-failed', details);
    expect(mapped).not.toBeNull();
    if (mapped === null) {
        return;
    }
    DebugLog.appendFromContent(
        TAB_ID,
        {
            events: [
                {
                    event: mapped.event,
                    ageMs: 0,
                    video: VIDEO_ID,
                    // The mapping only ever emits bounded scalars, so the
                    // wire schema's stricter field type is already satisfied.
                    fields: mapped.fields as DebugLogAppendPayload['events'][number]['fields'],
                },
            ],
        },
        NOW_MS,
    );
}

describe('sentinel injection (FR-046, SC-002)', () => {
    beforeEach(async () => {
        // Real timers (the BYOK run awaits adapter promises); only the clock
        // is pinned so every line carries NOW_MS.
        vi.setSystemTime(NOW_MS);
        for (const area of [storage.local, storage.session]) {
            area.reset();
            area.restore();
        }
        vi.clearAllMocks();
        DebugLogStore.resetForTest();
        TabAttributionRegistry.resetForTest();
        DebugLog.resetForTest();
        prefsMocks.load.mockResolvedValue({
            enabled: true,
            providerId: PROVIDER_ID.OpenRouter,
            analysisMode: ANALYSIS_MODE.Byok,
            activeModelId: 'openrouter:test-model',
        });
        openRouterStorageMocks.load.mockResolvedValue({
            apiKey: '',
            model: 'provider/model',
            customModels: [],
        });
        browserMocks.query.mockResolvedValue([
            { id: REATTACH_TAB_ID, url: WATCH_URL, incognito: false },
        ]);
        browserMocks.sendMessage.mockRejectedValue(RECEIVING_END_MISSING);
        browserMocks.executeScript.mockResolvedValue([{ result: false, frameId: 0 }]);
        await openEnabledLogger();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('caption-failure: payload.error never reaches the bundle', async () => {
        await CaptionRuntimeMessages.handle(
            { ok: false, videoId: VIDEO_ID, reason: 'capture-timeout', error: SENTINEL.SignedUrl },
            contentSender(),
        );

        const bundle = await exportBundle();
        expect(bundle).toContain(DEBUG_LOG_EVENT.CaptureFailed);
        expect(bundle).toContain('reason=capture-timeout');
        expect(bundle).not.toContain('SIGNED_URL_PARAM_SENTINEL');
    });

    it('reattach: the injection error text never reaches the bundle', async () => {
        browserMocks.executeScript.mockRejectedValue(new Error(SENTINEL.ExecuteScriptUrl));

        await ContentScriptReattach.handleRequest();

        const bundle = await exportBundle();
        expect(bundle).toContain(DEBUG_LOG_EVENT.Reattach);
        expect(bundle).toContain('outcome=inject_failed');
        expect(bundle).not.toContain('EXECUTE_SCRIPT_URL_SENTINEL');
    });

    it('provider failure: error body, assistant text and hash never reach the bundle', async () => {
        await driveByokRun(
            makeAdapter({
                ok: false,
                error: `${SENTINEL.ProviderBody} ${SENTINEL.TranscriptHash}`,
                rawAssistant: SENTINEL.AssistantText,
                status: 500,
                kind: 'http',
            }),
        );

        const bundle = await exportBundle();
        expect(bundle).toContain(DEBUG_LOG_EVENT.ByokChunk);
        expect(bundle).toContain('status=500');
        expect(bundle).toContain('outcome=adapter-error');
        expect(bundle).not.toContain(SENTINEL.ProviderBody);
        expect(bundle).not.toContain(SENTINEL.AssistantText);
        expect(bundle).not.toContain(SENTINEL.TranscriptHash);
        expect(bundle).not.toContain(SENTINEL.CaptionBody);
    });

    it('connection key: the saved key never reaches the bundle', async () => {
        await ModelRuntimeMessages.handleSaveConnectionKey(
            PROVIDER_ID.OpenRouter,
            SENTINEL.ApiKey,
        );

        const bundle = await exportBundle();
        expect(bundle).toContain(DEBUG_LOG_EVENT.ConnectionKeySaved);
        expect(bundle).toContain(`provider=${PROVIDER_ID.OpenRouter}`);
        expect(bundle).not.toContain(SENTINEL.ApiKey);
    });

    it('caption parse failure: the validation error and page strings never reach the bundle', async () => {
        appendCaptureFailure({
            stage: 'capture-parse-failed',
            reason: 'capture-parse-failed',
            error: SENTINEL.ValidationText,
            title: SENTINEL.PageTitle,
        });

        const bundle = await exportBundle();
        expect(bundle).toContain(DEBUG_LOG_EVENT.CaptureFailed);
        expect(bundle).toContain('reason=capture-parse-failed');
        expect(bundle).not.toContain(SENTINEL.ValidationText);
        expect(bundle).not.toContain(SENTINEL.PageTitle);
    });

    it('environment: only the browser major survives, never the full user agent', async () => {
        vi.stubGlobal('navigator', { userAgent: SENTINEL.FullUserAgent });

        const env = await EnvironmentProbe.collect();
        const bundle = DebugLogExport.buildBundle(
            await DebugLogStore.readSnapshot(),
            env,
            NOW_MS,
        );

        expect(env.browserMajor).toBe(139);
        expect(bundle).toContain('browser=139');
        expect(bundle).not.toContain('FULL_UA_SENTINEL');
    });

    it('the exported bundle contains none of the sentinels after every emitter ran', async () => {
        await driveAllEmitters();

        const bundle = await exportBundle();
        expect(bundle.length).toBeGreaterThan(0);
        for (const sentinel of SENTINELS) {
            expect(bundle).not.toContain(sentinel);
        }
        // FR-046 "page URL/title": the bare video id is allowed, the sender's
        // page URL (sender.url / tabs.query url) is not.
        expect(bundle).not.toContain(WATCH_URL);
        expect(bundle).not.toContain('youtube.com/watch');
        expect(bundle).toContain(VIDEO_ID);
    });
});
