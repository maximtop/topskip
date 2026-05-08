import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from 'webextension-polyfill';
import type {
    LlmProviderAdapter,
    AnalyzeTranscriptResult,
} from '@/background/providers/llm-provider-adapter';
import { PROVIDER_AVAILABILITY } from '@/background/providers/llm-provider-adapter';
import { ProviderRuntimeMessages } from '@/background/messaging/provider-runtime-messages';

// ── Hoisted mocks (must be defined before imports) ──

const browserMocks = vi.hoisted(() => ({
    runtimeOnMessage: vi.fn(),
    runtimeSendMessage: vi.fn(() => Promise.resolve()),
    storageLocalGet: vi.fn(),
    storageLocalSet: vi.fn(),
}));

vi.mock('@/shared/browser', () => ({
    default: {
        runtime: {
            onMessage: { addListener: browserMocks.runtimeOnMessage },
            sendMessage: browserMocks.runtimeSendMessage,
        },
        storage: {
            local: {
                get: browserMocks.storageLocalGet,
                set: browserMocks.storageLocalSet,
            },
        },
    },
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

// ── Imports (after mocks) ──

import { PromoAnalysis } from '@/background/messaging/promo-analysis';

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
    return fn as unknown as MockAnalyzeFn;
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
        resetMocks();
        registryMocks.get.mockReturnValue(mockAdapter);
        prefsMocks.ready.mockResolvedValue(undefined);
        prefsMocks.save.mockResolvedValue(undefined);
        const loadFn = prefsMocks.load;
        loadFn.mockReturnValue({
            enabled: true,
            providerId: 'openrouter',
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('PromoAnalysis inflight map', () => {
        it('aborts the prior controller when replaced for the same tab', () => {
            const inflight = new Map<
                number,
                { videoId: string; abort: AbortController }
            >();
            const first = new AbortController();
            const onAbort = vi.fn();
            first.signal.addEventListener('abort', onAbort);
            inflight.set(7, { videoId: 'oldVid', abort: first });

            const prev = inflight.get(7);
            prev?.abort.abort();
            const next = new AbortController();
            inflight.set(7, { videoId: 'newVid', abort: next });

            expect(onAbort).toHaveBeenCalled();
            expect(first.signal.aborted).toBe(true);
            expect(inflight.get(7)?.videoId).toBe('newVid');
        });
    });

    describe('onCaptionsReady routes through adapter', () => {
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

        it('returns not_configured when registry.get returns undefined', () => {
            registryMocks.get.mockReturnValue(undefined);

            PromoAnalysis.onCaptionsReady(baseSender(), basePayload());

            return vi.waitFor(() => {
                expect(registryMocks.get).toHaveBeenCalledWith('openrouter');
                expect(mockAnalyze).not.toHaveBeenCalled();
                expect(detectionStoreMocks.set).toHaveBeenCalledWith(42, {
                    videoId: 'vid123',
                    status: 'not_configured',
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
                    status: 'not_configured',
                });
            });
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
            });
            expect(prefsBroadcastMocks.sendUpdatedToAllTabs).toHaveBeenCalled();
            expect(prefsPortHubMocks.broadcastPrefsUpdate).toHaveBeenCalledWith(
                {
                    enabled: true,
                    providerId: 'chrome-prompt-api',
                },
            );
        });
    });
});
