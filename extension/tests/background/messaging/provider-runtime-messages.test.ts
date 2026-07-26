import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    PROVIDER_AVAILABILITY,
    type AnalyzeTranscriptParams,
    type AnalyzeTranscriptResult,
    type LlmProviderAdapter,
} from '@/background/providers/llm-provider-adapter';
import { ProviderRegistry } from '@/background/providers/provider-registry';

const mocks = vi.hoisted(() => ({
    prefsReady: vi.fn().mockResolvedValue(undefined),
    prefsLoad: vi.fn(),
    prefsSave: vi.fn().mockResolvedValue(undefined),
    sendUpdatedToAllTabs: vi.fn().mockResolvedValue(undefined),
    broadcastPrefsUpdate: vi.fn(),
    abortForProviderChange: vi.fn(),
    openRouterLoad: vi.fn(),
}));

vi.mock('@/background/storage/prefs-sync', () => ({
    PrefsSyncStorage: {
        ready: mocks.prefsReady,
        load: mocks.prefsLoad,
        save: mocks.prefsSave,
    },
}));

vi.mock('@/background/messaging/broadcast-prefs-updated', () => ({
    PrefsBroadcast: {
        sendUpdatedToAllTabs: mocks.sendUpdatedToAllTabs,
    },
}));

vi.mock('@/background/messaging/prefs-port-hub', () => ({
    PrefsPortHub: {
        broadcastPrefsUpdate: mocks.broadcastPrefsUpdate,
    },
}));

vi.mock('@/background/messaging/promo-analysis', () => ({
    PromoAnalysis: {
        abortForProviderChange: mocks.abortForProviderChange,
    },
}));

vi.mock('@/background/storage/openrouter-storage', () => ({
    OpenRouterStorage: {
        load: mocks.openRouterLoad,
    },
}));

vi.mock('@/background/providers/default-registry', () => ({
    defaultRegistry: new ProviderRegistry([]),
}));

const { ProviderRuntimeMessages } =
    await import('@/background/messaging/provider-runtime-messages');

function stubAdapter(
    id: 'openrouter' | 'chrome-prompt-api',
    displayName: string,
    availability: Awaited<ReturnType<LlmProviderAdapter['availability']>>,
): LlmProviderAdapter {
    return {
        id,
        displayName,
        availability: vi.fn().mockResolvedValue(availability),
        maxTranscriptChars: vi.fn().mockResolvedValue(Number.MAX_SAFE_INTEGER),
        analyzeTranscript: vi.fn(
            (
                _params: AnalyzeTranscriptParams,
            ): Promise<AnalyzeTranscriptResult> =>
                Promise.resolve({
                    ok: false,
                    error: 'unused',
                }),
        ),
    };
}

describe('ProviderRuntimeMessages', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.prefsLoad.mockResolvedValue({
            enabled: true,
            providerId: 'openrouter',
        });
        mocks.openRouterLoad.mockResolvedValue({
            apiKey: '',
            model: '',
            customModels: [],
        });
        ProviderRuntimeMessages.setRegistry(
            new ProviderRegistry([
                stubAdapter(
                    'openrouter',
                    'OpenRouter',
                    PROVIDER_AVAILABILITY.AVAILABLE,
                ),
                stubAdapter(
                    'chrome-prompt-api',
                    'Chrome Built-in',
                    PROVIDER_AVAILABILITY.UNAVAILABLE,
                ),
            ]),
        );
    });

    it('GET_PROVIDER_LIST returns both providers with availability', async () => {
        const res = await ProviderRuntimeMessages.handleGetList();

        expect(res).toEqual({
            ok: true,
            providers: [
                {
                    id: 'openrouter',
                    displayName: 'OpenRouter',
                    availability: 'available',
                },
                {
                    id: 'chrome-prompt-api',
                    displayName: 'Chrome Built-in',
                    availability: 'unavailable',
                },
            ],
        });
    });

    it('GET_ACTIVE_PROVIDER returns providerId and displayName', async () => {
        const res = await ProviderRuntimeMessages.handleGetActive();

        expect(res).toEqual({
            ok: true,
            providerId: 'openrouter',
            displayName: 'OpenRouter',
            modelName: '',
        });
    });

    it('GET_ACTIVE_PROVIDER includes configured model slug for openrouter', async () => {
        mocks.openRouterLoad.mockResolvedValueOnce({
            apiKey: 'sk-test',
            model: 'google/gemini-2.0-flash',
            customModels: [],
        });

        const res = await ProviderRuntimeMessages.handleGetActive();

        expect(res).toEqual({
            ok: true,
            providerId: 'openrouter',
            displayName: 'OpenRouter',
            modelName: 'google/gemini-2.0-flash',
        });
    });

    it(
        'GET_ACTIVE_PROVIDER returns "Gemini Nano" as modelName ' +
            'for chrome-prompt-api',
        async () => {
            mocks.prefsLoad.mockResolvedValueOnce({
                enabled: true,
                providerId: 'chrome-prompt-api',
            });

            const res = await ProviderRuntimeMessages.handleGetActive();

            expect(res).toEqual({
                ok: true,
                providerId: 'chrome-prompt-api',
                displayName: 'Chrome Built-in',
                modelName: 'Gemini Nano',
            });
        },
    );

    it('SET_ACTIVE_PROVIDER writes prefs and broadcasts updates', async () => {
        const res =
            await ProviderRuntimeMessages.handleSetActive('chrome-prompt-api');

        expect(res).toEqual({ ok: true });
        expect(mocks.prefsSave).toHaveBeenCalledWith({
            enabled: true,
            providerId: 'chrome-prompt-api',
        });
        expect(mocks.abortForProviderChange).toHaveBeenCalledWith(
            'chrome-prompt-api',
        );
        expect(mocks.sendUpdatedToAllTabs).toHaveBeenCalledWith({
            enabled: true,
            providerId: 'chrome-prompt-api',
        });
        expect(mocks.broadcastPrefsUpdate).toHaveBeenCalledWith({
            enabled: true,
            providerId: 'chrome-prompt-api',
        });
    });

    it('SET_ACTIVE_PROVIDER rejects an unknown provider id', async () => {
        const res =
            await ProviderRuntimeMessages.handleSetActive('does-not-exist');

        expect(res).toEqual({
            ok: false,
            error: 'Unknown provider: does-not-exist',
        });
        expect(mocks.prefsSave).not.toHaveBeenCalled();
    });
});
