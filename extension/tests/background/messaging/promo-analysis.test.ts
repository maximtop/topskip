import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from 'webextension-polyfill';
import type {
    LlmProviderAdapter,
    AnalyzeTranscriptResult,
} from '@/background/providers/llm-provider-adapter';
import { PROVIDER_AVAILABILITY } from '@/background/providers/llm-provider-adapter';
import { ProviderRuntimeMessages } from '@/background/messaging/provider-runtime-messages';
import { DEBUG_LOG_EVENT } from '@/shared/debug-log-events';
import { PROMO_DETECTION_SOURCE } from '@/shared/messages';
import { PROMO_DETECTION_STATUS } from '@topskip/common/promo-types';

// ── Hoisted mocks (must be defined before imports) ──

const browserMocks = vi.hoisted(() => ({
    runtimeOnMessage: vi.fn(),
    runtimeSendMessage: vi.fn(() => Promise.resolve()),
    permissionsContains: vi.fn(),
    storageLocalGet: vi.fn(),
    storageLocalSet: vi.fn(),
    tabsSendMessage: vi.fn(() => Promise.resolve()),
}));

vi.mock('@/shared/browser', () => ({
    default: {
        runtime: {
            onMessage: { addListener: browserMocks.runtimeOnMessage },
            sendMessage: browserMocks.runtimeSendMessage,
        },
        permissions: { contains: browserMocks.permissionsContains },
        storage: {
            local: {
                get: browserMocks.storageLocalGet,
                set: browserMocks.storageLocalSet,
            },
        },
        tabs: {
            sendMessage: browserMocks.tabsSendMessage,
        },
    },
}));

// Typed so `mock.calls` stays `unknown[][]` (no-unsafe-return in helpers).
const debugLogMock = vi.hoisted(() => ({
    record: vi.fn<(...args: unknown[]) => void>(),
}));

vi.mock('@/background/debug-log/debug-log', () => ({
    DebugLog: debugLogMock,
}));

const logMocks = vi.hoisted(() => ({
    logBundle: vi.fn(),
    buildBundle: vi.fn().mockReturnValue('log bundle'),
}));

vi.mock(
    '@/background/openrouter/log-promo-analysis',
    async (importOriginal) => {
        const mod =
            await importOriginal<
                typeof import('@/background/openrouter/log-promo-analysis')
            >();
        return {
            ...mod,
            LogPromoAnalysis: { logAnalysisBundle: logMocks.logBundle },
            buildPromoAnalysisLogBundle: logMocks.buildBundle,
        };
    },
);

const prefsMocks = vi.hoisted(() => ({
    ready: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockReturnValue({
        enabled: true,
        providerId: 'openrouter',
        analysisMode: 'byok',
    }),
    save: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/background/storage/prefs-sync', () => ({
    PrefsSyncStorage: prefsMocks,
}));

const prefsBroadcastMocks = vi.hoisted(() => ({
    sendUpdatedToAllTabs: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/background/messaging/broadcast-prefs-updated', () => ({
    PrefsBroadcast: prefsBroadcastMocks,
}));

const prefsPortHubMocks = vi.hoisted(() => ({
    broadcastPrefsUpdate: vi.fn(),
}));

vi.mock('@/background/messaging/prefs-port-hub', () => ({
    PrefsPortHub: prefsPortHubMocks,
}));

const detectionStoreMocks = vi.hoisted(() => ({
    set: vi.fn(),
}));

vi.mock('@/background/promo-detection-store', () => ({
    PromoDetectionStore: detectionStoreMocks,
}));

const registryMocks = vi.hoisted(() => ({
    get: vi.fn(),
}));

vi.mock('@/background/providers/default-registry', () => ({
    defaultRegistry: { get: registryMocks.get },
}));

const providerBoundaryMocks = vi.hoisted(() => ({
    openRouterLoad: vi.fn(),
    openAiLoad: vi.fn(),
    callOpenRouterChat: vi.fn(),
    callOpenAiResponse: vi.fn(),
}));

vi.mock('@/background/storage/openrouter-storage', () => ({
    OpenRouterStorage: { load: providerBoundaryMocks.openRouterLoad },
}));

vi.mock('@/background/storage/openai-storage', () => ({
    OpenAiStorage: { load: providerBoundaryMocks.openAiLoad },
}));

vi.mock('@/background/openrouter/openrouter-client', () => ({
    callOpenRouterChat: providerBoundaryMocks.callOpenRouterChat,
}));

vi.mock('@/background/openai/openai-client', () => ({
    callOpenAiResponse: providerBoundaryMocks.callOpenAiResponse,
}));

// ── Imports (after mocks) ──

import { PromoAnalysis } from '@/background/messaging/promo-analysis';
import { OpenAiAdapter } from '@/background/providers/openai-adapter';
import { OpenRouterAdapter } from '@/background/providers/openrouter-adapter';

// ── Test fixtures ──

type Payload = Extract<
    import('@/shared/messages').CaptionsFromContentPayload,
    { ok: true }
>;

const baseSender = (tabId = 42): Runtime.MessageSender =>
    ({ tab: { id: tabId } }) as Runtime.MessageSender;

const basePayload = (videoId = 'vid123'): Payload => ({
    ok: true,
    videoId,
    languageCode: 'en',
    segments: [{ text: 'Hello world', startSec: 0, durationSec: 2 }],
});

type AnalyzeFnParams = Parameters<LlmProviderAdapter['analyzeTranscript']>[0];

type MockAnalyzeFn = (
    params: AnalyzeFnParams,
) => Promise<AnalyzeTranscriptResult>;

const makeAnalyzeTranscript = (): MockAnalyzeFn => {
    const fn = vi.fn().mockResolvedValue({
        ok: true,
        hasPromo: false,
        providerMeta: {
            id: 'openrouter',
            model: 'test-model',
        },
        rawAssistant: '{"hasPromo":false,"confidence":"high"}',
    });
    return fn;
};

function makeAdapter(
    overrides: Partial<Record<keyof LlmProviderAdapter, unknown>> = {},
) {
    return {
        id: 'openrouter',
        displayName: 'TestAdapter',
        availability: vi
            .fn()
            .mockResolvedValue(PROVIDER_AVAILABILITY.AVAILABLE),
        maxTranscriptChars: vi.fn().mockResolvedValue(Number.MAX_SAFE_INTEGER),
        analyzeTranscript: makeAnalyzeTranscript(),
        ...overrides,
    } as LlmProviderAdapter;
}

function makePendingAnalyze(signalSpy: (signal?: AbortSignal) => void) {
    return vi.fn().mockImplementation(async (params: AnalyzeFnParams) => {
        signalSpy(params.signal);
        return await new Promise<AnalyzeTranscriptResult>(() => {});
    }) as MockAnalyzeFn;
}

let mockAnalyze: MockAnalyzeFn;
let mockAdapter: LlmProviderAdapter;

function resetMocks(): void {
    mockAnalyze = makeAnalyzeTranscript();
    mockAdapter = makeAdapter({
        analyzeTranscript: mockAnalyze,
    });
}

describe('PromoAnalysis — adapter routing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        debugLogMock.record.mockReset();
        browserMocks.tabsSendMessage.mockReset().mockResolvedValue(undefined);
        browserMocks.permissionsContains.mockReset().mockResolvedValue(true);
        detectionStoreMocks.set.mockReset().mockResolvedValue(undefined);
        resetMocks();
        registryMocks.get.mockReturnValue(mockAdapter);
        prefsMocks.ready.mockResolvedValue(undefined);
        prefsMocks.save.mockResolvedValue(undefined);
        providerBoundaryMocks.openRouterLoad.mockResolvedValue({
            apiKey: 'sk-openrouter',
            model: 'provider/model',
            customModels: [],
        });
        providerBoundaryMocks.openAiLoad.mockResolvedValue({
            apiKey: 'sk-openai',
            model: 'gpt-5.2',
        });
        const loadFn = prefsMocks.load;
        loadFn.mockReturnValue({
            enabled: true,
            providerId: 'openrouter',
            analysisMode: 'byok',
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('onCaptionsReady routes through adapter', () => {
        it('aborts prior analysis when new captions replace the same tab', async () => {
            const signals: AbortSignal[] = [];
            const analyze = makePendingAnalyze((signal) => {
                if (signal) {
                    signals.push(signal);
                }
            });
            registryMocks.get.mockReturnValue(
                makeAdapter({ analyzeTranscript: analyze }),
            );

            PromoAnalysis.onCaptionsReady(
                baseSender(7),
                basePayload('firstVideo'),
            );
            await vi.waitFor(() => {
                expect(signals).toHaveLength(1);
            });

            PromoAnalysis.onCaptionsReady(
                baseSender(7),
                basePayload('secondVideo'),
            );
            await vi.waitFor(() => {
                expect(signals).toHaveLength(2);
            });

            expect(signals[0]?.aborted).toBe(true);
            expect(signals[1]?.aborted).toBe(false);

            PromoAnalysis.abortForTab(7);
            expect(signals[1]?.aborted).toBe(true);
        });

        it('rejects old same-video completion after a BYOK route is re-enabled', async () => {
            let resolveOld: (result: AnalyzeTranscriptResult) => void =
                () => undefined;
            let resolveReplacement: (result: AnalyzeTranscriptResult) => void =
                () => undefined;
            const oldResult = new Promise<AnalyzeTranscriptResult>(
                (resolve) => {
                    resolveOld = resolve;
                },
            );
            const replacementResult = new Promise<AnalyzeTranscriptResult>(
                (resolve) => {
                    resolveReplacement = resolve;
                },
            );
            const analyze = vi
                .fn<MockAnalyzeFn>()
                .mockImplementationOnce(() => oldResult)
                .mockImplementationOnce(() => replacementResult);
            registryMocks.get.mockReturnValue(
                makeAdapter({ analyzeTranscript: analyze }),
            );

            PromoAnalysis.onCaptionsReady(
                baseSender(7),
                basePayload('sameVideo'),
            );
            await vi.waitFor(() => {
                expect(analyze).toHaveBeenCalledTimes(1);
            });

            PromoAnalysis.abortAll();
            PromoAnalysis.onCaptionsReady(
                baseSender(7),
                basePayload('sameVideo'),
            );
            await vi.waitFor(() => {
                expect(analyze).toHaveBeenCalledTimes(2);
            });

            resolveOld({
                ok: true,
                hasPromo: true,
                blocks: [{ startSec: 0, endSec: 1 }],
                providerMeta: {
                    id: 'openrouter',
                    model: 'old-route',
                },
                rawAssistant: '{"hasPromo":true}',
            });
            await new Promise<void>((resolve) => {
                globalThis.setTimeout(resolve, 0);
            });
            expect(browserMocks.tabsSendMessage).not.toHaveBeenCalled();

            resolveReplacement({
                ok: true,
                hasPromo: true,
                blocks: [{ startSec: 0, endSec: 2 }],
                providerMeta: {
                    id: 'openrouter',
                    model: 'replacement-route',
                },
                rawAssistant: '{"hasPromo":true}',
            });
            await vi.waitFor(() => {
                expect(browserMocks.tabsSendMessage).toHaveBeenCalledOnce();
            });
            expect(browserMocks.tabsSendMessage).toHaveBeenCalledWith(
                7,
                expect.objectContaining({
                    videoId: 'sameVideo',
                    promoBlocks: [{ startSec: 0, endSec: 2 }],
                }),
            );
        });

        it('does not let an aborted prefs read reclaim a replacement run', async () => {
            let resolveOldPrefs: (prefs: unknown) => void = () => undefined;
            let resolveReplacement: (result: AnalyzeTranscriptResult) => void =
                () => undefined;
            const oldPrefs = new Promise<unknown>((resolve) => {
                resolveOldPrefs = resolve;
            });
            const replacementResult = new Promise<AnalyzeTranscriptResult>(
                (resolve) => {
                    resolveReplacement = resolve;
                },
            );
            prefsMocks.load
                .mockImplementationOnce(() => oldPrefs)
                .mockResolvedValue({
                    enabled: true,
                    providerId: 'openrouter',
                    analysisMode: 'byok',
                });
            const analyze = vi
                .fn<MockAnalyzeFn>()
                .mockImplementationOnce(() => replacementResult)
                .mockResolvedValue({
                    ok: true,
                    hasPromo: false,
                    providerMeta: {
                        id: 'openrouter',
                        model: 'stale-route',
                    },
                    rawAssistant: '{"hasPromo":false}',
                });
            registryMocks.get.mockReturnValue(
                makeAdapter({ analyzeTranscript: analyze }),
            );

            PromoAnalysis.onCaptionsReady(
                baseSender(7),
                basePayload('sameVideo'),
            );
            await vi.waitFor(() => {
                expect(prefsMocks.load).toHaveBeenCalledTimes(1);
            });

            PromoAnalysis.abortAll();
            PromoAnalysis.onCaptionsReady(
                baseSender(7),
                basePayload('sameVideo'),
            );
            await vi.waitFor(() => {
                expect(analyze).toHaveBeenCalledOnce();
            });

            resolveOldPrefs({
                enabled: true,
                providerId: 'openrouter',
                analysisMode: 'byok',
            });
            await new Promise<void>((resolve) => {
                globalThis.setTimeout(resolve, 0);
            });
            expect(analyze).toHaveBeenCalledOnce();

            resolveReplacement({
                ok: true,
                hasPromo: true,
                blocks: [{ startSec: 0, endSec: 2 }],
                providerMeta: {
                    id: 'openrouter',
                    model: 'replacement-route',
                },
                rawAssistant: '{"hasPromo":true}',
            });
            await vi.waitFor(() => {
                expect(browserMocks.tabsSendMessage).toHaveBeenCalledOnce();
            });
        });

        it('does not publish stale status after an aborted tab delivery settles', async () => {
            let resolveOldDelivery: () => void = () => undefined;
            const oldDelivery = new Promise<void>((resolve) => {
                resolveOldDelivery = resolve;
            });
            const analyze = vi
                .fn<MockAnalyzeFn>()
                .mockResolvedValueOnce({
                    ok: true,
                    hasPromo: true,
                    blocks: [{ startSec: 0, endSec: 1 }],
                    providerMeta: {
                        id: 'openrouter',
                        model: 'old-route',
                    },
                    rawAssistant: '{"hasPromo":true}',
                })
                .mockResolvedValueOnce({
                    ok: true,
                    hasPromo: true,
                    blocks: [{ startSec: 0, endSec: 2 }],
                    providerMeta: {
                        id: 'openrouter',
                        model: 'replacement-route',
                    },
                    rawAssistant: '{"hasPromo":true}',
                });
            registryMocks.get.mockReturnValue(
                makeAdapter({ analyzeTranscript: analyze }),
            );
            browserMocks.tabsSendMessage
                .mockImplementationOnce(() => oldDelivery)
                .mockResolvedValueOnce(undefined);

            PromoAnalysis.onCaptionsReady(
                baseSender(7),
                basePayload('sameVideo'),
            );
            await vi.waitFor(() => {
                expect(browserMocks.tabsSendMessage).toHaveBeenCalledOnce();
            });

            PromoAnalysis.abortAll();
            PromoAnalysis.onCaptionsReady(
                baseSender(7),
                basePayload('sameVideo'),
            );
            await vi.waitFor(() => {
                expect(browserMocks.tabsSendMessage).toHaveBeenCalledTimes(2);
            });
            await vi.waitFor(() => {
                expect(detectionStoreMocks.set).toHaveBeenCalledWith(
                    7,
                    expect.objectContaining({
                        status: PROMO_DETECTION_STATUS.Detected,
                        promoBlocks: [{ startSec: 0, endSec: 2 }],
                    }),
                );
            });

            resolveOldDelivery();
            await new Promise<void>((resolve) => {
                globalThis.setTimeout(resolve, 0);
            });
            expect(detectionStoreMocks.set).not.toHaveBeenCalledWith(
                7,
                expect.objectContaining({
                    status: PROMO_DETECTION_STATUS.Detected,
                    promoBlocks: [{ startSec: 0, endSec: 1 }],
                }),
            );
        });

        it('resolves adapter from registry and calls analyzeTranscript', () => {
            const adapter = makeAdapter({
                analyzeTranscript: mockAnalyze,
            });
            registryMocks.get.mockReturnValue(adapter);

            PromoAnalysis.onCaptionsReady(baseSender(), basePayload());

            return vi.waitFor(() => {
                expect(registryMocks.get).toHaveBeenCalledWith('openrouter');
                expect(mockAnalyze).toHaveBeenCalled();
            });
        });

        it(
            'calls analyzeTranscript exactly once when the merged transcript ' +
                'fits a single chunk',
            () => {
                registryMocks.get.mockReturnValue(mockAdapter);
                PromoAnalysis.onCaptionsReady(baseSender(), basePayload());

                return vi.waitFor(() => {
                    expect(mockAnalyze).toHaveBeenCalledTimes(1);
                });
            },
        );

        it('does not build transcript logs outside the dev build', async () => {
            registryMocks.get.mockReturnValue(mockAdapter);
            PromoAnalysis.onCaptionsReady(baseSender(), basePayload());

            await vi.waitFor(() => {
                expect(detectionStoreMocks.set).toHaveBeenCalledWith(
                    42,
                    expect.objectContaining({ status: 'no_promo' }),
                );
            });

            expect(logMocks.buildBundle).not.toHaveBeenCalled();
            expect(logMocks.logBundle).not.toHaveBeenCalled();
        });

        it('routes to the provider from prefs on each run', () => {
            const chromeAnalyze = makeAnalyzeTranscript();
            const chromeAdapter = makeAdapter({
                id: 'chrome-prompt-api',
                displayName: 'Chrome built-in',
                analyzeTranscript: chromeAnalyze,
            });
            prefsMocks.load.mockReturnValue({
                enabled: true,
                providerId: 'chrome-prompt-api',
                analysisMode: 'byok',
            });
            registryMocks.get.mockReturnValue(chromeAdapter);

            PromoAnalysis.onCaptionsReady(
                baseSender(),
                basePayload('chromeVid'),
            );

            return vi.waitFor(() => {
                expect(registryMocks.get).toHaveBeenCalledWith(
                    'chrome-prompt-api',
                );
                expect(chromeAnalyze).toHaveBeenCalled();
            });
        });

        it('routes OpenAI active model through the OpenAI provider adapter', () => {
            const openAiAnalyze = makeAnalyzeTranscript();
            const openAiAdapter = makeAdapter({
                id: 'openai',
                displayName: 'OpenAI',
                analyzeTranscript: openAiAnalyze,
            });
            prefsMocks.load.mockReturnValue({
                enabled: true,
                providerId: 'openai',
                activeModelId: 'openai:gpt-5.2',
                analysisMode: 'byok',
            });
            registryMocks.get.mockReturnValue(openAiAdapter);

            PromoAnalysis.onCaptionsReady(
                baseSender(),
                basePayload('openAiVid'),
            );

            return vi.waitFor(() => {
                expect(registryMocks.get).toHaveBeenCalledWith('openai');
                expect(openAiAnalyze).toHaveBeenCalled();
            });
        });

        it('returns not_configured when registry.get returns undefined', () => {
            registryMocks.get.mockReturnValue(undefined);

            PromoAnalysis.onCaptionsReady(baseSender(), basePayload());

            return vi.waitFor(() => {
                expect(registryMocks.get).toHaveBeenCalledWith('openrouter');
                expect(mockAnalyze).not.toHaveBeenCalled();
                expect(detectionStoreMocks.set).toHaveBeenCalledWith(42, {
                    videoId: 'vid123',
                    status: PROMO_DETECTION_STATUS.NotConfigured,
                    source: PROMO_DETECTION_SOURCE.LocalProvider,
                });
            });
        });

        it('returns not_configured when adapter is unavailable', () => {
            const avail = vi
                .fn()
                .mockResolvedValue(PROVIDER_AVAILABILITY.UNAVAILABLE);
            const analyze = vi.fn();
            const adapter = makeAdapter({
                availability: avail,
                analyzeTranscript: analyze,
            });
            registryMocks.get.mockReturnValue(adapter);

            PromoAnalysis.onCaptionsReady(baseSender(), basePayload());

            return vi.waitFor(() => {
                expect(avail).toHaveBeenCalled();
                expect(analyze).not.toHaveBeenCalled();
                expect(detectionStoreMocks.set).toHaveBeenCalledWith(42, {
                    videoId: 'vid123',
                    status: PROMO_DETECTION_STATUS.NotConfigured,
                    source: PROMO_DETECTION_SOURCE.LocalProvider,
                });
            });
        });

        it.each([
            {
                providerId: 'openrouter',
                createAdapter: () => new OpenRouterAdapter(),
                providerClient: providerBoundaryMocks.callOpenRouterChat,
            },
            {
                providerId: 'openai',
                createAdapter: () => new OpenAiAdapter(),
                providerClient: providerBoundaryMocks.callOpenAiResponse,
            },
        ])(
            'publishes setup-required without a $providerId fetch or server fallback',
            async ({ providerId, createAdapter, providerClient }) => {
                prefsMocks.load.mockResolvedValue({
                    enabled: true,
                    providerId,
                    analysisMode: 'byok',
                });
                browserMocks.permissionsContains.mockResolvedValue(false);
                registryMocks.get.mockReturnValue(createAdapter());

                PromoAnalysis.onCaptionsReady(
                    baseSender(),
                    basePayload(`missing-${providerId}-access`),
                );

                await vi.waitFor(() => {
                    expect(detectionStoreMocks.set).toHaveBeenCalledWith(42, {
                        videoId: `missing-${providerId}-access`,
                        status: PROMO_DETECTION_STATUS.NotConfigured,
                        source: PROMO_DETECTION_SOURCE.LocalProvider,
                    });
                });
                expect(providerClient).not.toHaveBeenCalled();
                expect(browserMocks.tabsSendMessage).not.toHaveBeenCalled();
                expect(browserMocks.runtimeSendMessage).not.toHaveBeenCalled();
            },
        );

        it('stops all remaining chunks on a typed host-access failure', async () => {
            const analyze = vi.fn<MockAnalyzeFn>().mockResolvedValue({
                ok: false,
                failureCode: 'host_access_required',
                error: 'Provider host access is required',
            });
            registryMocks.get.mockReturnValue(
                makeAdapter({
                    maxTranscriptChars: vi.fn().mockResolvedValue(20),
                    analyzeTranscript: analyze,
                }),
            );
            const payload: Payload = {
                ...basePayload('revoked-access'),
                segments: [
                    { text: 'segment alpha', startSec: 0, durationSec: 1 },
                    { text: 'segment beta', startSec: 60, durationSec: 1 },
                    { text: 'segment gamma', startSec: 120, durationSec: 1 },
                ],
            };

            PromoAnalysis.onCaptionsReady(baseSender(), payload);

            await vi.waitFor(() => {
                expect(detectionStoreMocks.set).toHaveBeenCalledWith(42, {
                    videoId: 'revoked-access',
                    status: PROMO_DETECTION_STATUS.NotConfigured,
                    source: PROMO_DETECTION_SOURCE.LocalProvider,
                });
            });
            expect(analyze).toHaveBeenCalledOnce();
            expect(detectionStoreMocks.set).toHaveBeenCalledTimes(2);
            expect(detectionStoreMocks.set).not.toHaveBeenCalledWith(
                42,
                expect.objectContaining({
                    status: PROMO_DETECTION_STATUS.Error,
                    error: 'All transcript chunks failed',
                }),
            );
            expect(browserMocks.tabsSendMessage).not.toHaveBeenCalled();
            expect(browserMocks.runtimeSendMessage).not.toHaveBeenCalled();
        });

        it('stops split retries when access disappears before a retry fetch', async () => {
            const analyze = vi
                .fn<MockAnalyzeFn>()
                .mockResolvedValueOnce({
                    ok: false,
                    error: 'Transcript is too large',
                    tooLarge: true,
                })
                .mockResolvedValueOnce({
                    ok: false,
                    failureCode: 'host_access_required',
                    error: 'Provider host access is required',
                });
            registryMocks.get.mockReturnValue(
                makeAdapter({ analyzeTranscript: analyze }),
            );
            const payload: Payload = {
                ...basePayload('revoked-split-access'),
                segments: [
                    { text: 'first line', startSec: 0, durationSec: 1 },
                    { text: 'second line', startSec: 60, durationSec: 1 },
                ],
            };

            PromoAnalysis.onCaptionsReady(baseSender(), payload);

            await vi.waitFor(() => {
                expect(detectionStoreMocks.set).toHaveBeenCalledWith(42, {
                    videoId: 'revoked-split-access',
                    status: PROMO_DETECTION_STATUS.NotConfigured,
                    source: PROMO_DETECTION_SOURCE.LocalProvider,
                });
            });
            expect(analyze).toHaveBeenCalledTimes(2);
            expect(detectionStoreMocks.set).toHaveBeenCalledTimes(2);
            expect(detectionStoreMocks.set).not.toHaveBeenCalledWith(
                42,
                expect.objectContaining({
                    status: PROMO_DETECTION_STATUS.Error,
                    error: 'All transcript chunks failed',
                }),
            );
            expect(browserMocks.tabsSendMessage).not.toHaveBeenCalled();
            expect(browserMocks.runtimeSendMessage).not.toHaveBeenCalled();
        });

        it('re-checks persisted mode before resolving the provider', async () => {
            prefsMocks.load.mockResolvedValueOnce({
                enabled: true,
                providerId: 'openrouter',
                activeModelId: 'openrouter:test',
                analysisMode: 'server',
            });

            PromoAnalysis.onCaptionsReady(baseSender(), basePayload());

            await vi.waitFor(() => {
                expect(prefsMocks.load).toHaveBeenCalled();
            });
            expect(registryMocks.get).not.toHaveBeenCalled();
            expect(mockAnalyze).not.toHaveBeenCalled();
            expect(detectionStoreMocks.set).not.toHaveBeenCalled();
        });

        it('aborts inflight analysis when the active provider changes', async () => {
            let capturedSignal: AbortSignal | undefined;
            const analyze = makePendingAnalyze((signal) => {
                capturedSignal = signal;
            });
            const adapter = makeAdapter({
                analyzeTranscript: analyze,
            });
            registryMocks.get.mockReturnValue(adapter);

            PromoAnalysis.onCaptionsReady(
                baseSender(7),
                basePayload('abortVid'),
            );

            await vi.waitFor(() => {
                expect(analyze).toHaveBeenCalled();
            });

            const result =
                await ProviderRuntimeMessages.handleSetActive(
                    'chrome-prompt-api',
                );

            expect(result).toEqual({ ok: true });
            expect(capturedSignal?.aborted).toBe(true);
            expect(prefsMocks.save).toHaveBeenCalledWith({
                enabled: true,
                providerId: 'chrome-prompt-api',
                analysisMode: 'byok',
            });
            expect(prefsBroadcastMocks.sendUpdatedToAllTabs).toHaveBeenCalled();
            expect(prefsPortHubMocks.broadcastPrefsUpdate).toHaveBeenCalledWith(
                {
                    enabled: true,
                    providerId: 'chrome-prompt-api',
                    analysisMode: 'byok',
                },
            );
        });

        it('records byok-run-started, byok-chunk and byok-run-ended (metadata only)', async () => {
            registryMocks.get.mockReturnValue(mockAdapter);
            PromoAnalysis.onCaptionsReady(baseSender(), basePayload());

            await vi.waitFor(() => {
                expect(detectionStoreMocks.set).toHaveBeenCalledWith(
                    42,
                    expect.objectContaining({ status: 'no_promo' }),
                );
            });

            const events = debugLogMock.record.mock.calls.map(
                (call) => call[0],
            );
            expect(events).toContain(DEBUG_LOG_EVENT.ByokRunStarted);
            expect(events).toContain(DEBUG_LOG_EVENT.ByokChunk);
            expect(events).toContain(DEBUG_LOG_EVENT.ByokRunEnded);
            // No chunk/assistant text anywhere in recorded fields.
            const flat = JSON.stringify(debugLogMock.record.mock.calls);
            expect(flat).not.toContain('Hello world');
        });

        it(
            'logs a stable code (not the raw error) on an unexpected ' +
                'analysis exception',
            async () => {
                const err = new Error(
                    'OpenRouter HTTP 500: secret provider body',
                );
                registryMocks.get.mockReturnValue(
                    makeAdapter({
                        analyzeTranscript: vi.fn().mockRejectedValue(err),
                    }),
                );
                const consoleError = vi
                    .spyOn(console, 'error')
                    .mockImplementation(() => {});

                PromoAnalysis.onCaptionsReady(
                    baseSender(),
                    basePayload('boom'),
                );
                await vi.waitFor(() => {
                    expect(consoleError).toHaveBeenCalled();
                });

                expect(consoleError).not.toHaveBeenCalledWith(
                    '[TopSkip] Promo analysis failed',
                    expect.stringContaining('secret provider body'),
                );
                consoleError.mockRestore();
            },
        );

        it('logs host-access-check when the provider grant is missing', async () => {
            registryMocks.get.mockReturnValue(
                makeAdapter({
                    maxTranscriptChars: vi.fn().mockResolvedValue(20),
                    analyzeTranscript: vi.fn().mockResolvedValue({
                        ok: false,
                        failureCode: 'host_access_required',
                        error: 'Provider host access is required',
                    }),
                }),
            );
            PromoAnalysis.onCaptionsReady(baseSender(), basePayload('revoked'));
            await vi.waitFor(() => {
                expect(debugLogMock.record).toHaveBeenCalledWith(
                    DEBUG_LOG_EVENT.HostAccessCheck,
                    { provider: 'openrouter', outcome: 'host-access-required' },
                    { tab: 42, video: 'revoked' },
                );
            });
        });
    });
});
