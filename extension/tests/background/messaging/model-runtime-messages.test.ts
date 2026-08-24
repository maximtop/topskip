import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEBUG_LOG_EVENT } from '@/shared/debug-log-events';
import { PROVIDER_ID } from '@/shared/providers';

const prefsLoad = vi.fn();
const prefsSave = vi.fn();
const openRouterLoad = vi.fn();
const openRouterSave = vi.fn();
const openAiLoad = vi.fn();
const openAiSave = vi.fn();
const testOpenRouterKey = vi.fn();
const testOpenAiKey = vi.fn();
const prefsBroadcast = vi.fn();
const prefsPortBroadcast = vi.fn();
const abortForProviderChange = vi.fn();
const providerHostAccessAll = vi.fn();
const providerHostAccessIsGranted = vi.fn();

vi.mock('@/background/storage/prefs-sync', () => ({
    PrefsSyncStorage: {
        ready: async () => {},
        load: (): Promise<unknown> => {
            const out: unknown = prefsLoad();
            return Promise.resolve(out);
        },
        save: async (p: unknown): Promise<void> => {
            await Promise.resolve(prefsSave(p));
        },
    },
}));

vi.mock('@/background/storage/openrouter-storage', () => ({
    OpenRouterStorage: {
        load: (): Promise<unknown> => {
            const out: unknown = openRouterLoad();
            return Promise.resolve(out);
        },
        save: async (c: unknown): Promise<void> => {
            await Promise.resolve(openRouterSave(c));
        },
        maskApiKey: () => '****r',
    },
}));

vi.mock('@/background/storage/openai-storage', () => ({
    OpenAiStorage: {
        load: (): Promise<unknown> => {
            const out: unknown = openAiLoad();
            return Promise.resolve(out);
        },
        save: async (c: unknown): Promise<void> => {
            await Promise.resolve(openAiSave(c));
        },
        maskApiKey: () => '****i',
    },
}));

vi.mock('@/background/openrouter/openrouter-models-api', () => ({
    fetchOpenRouterModelList: (): Promise<unknown> => {
        const out: unknown = testOpenRouterKey();
        return Promise.resolve(out);
    },
}));

vi.mock('@/background/openai/openai-client', () => ({
    testOpenAiApiKey: (): Promise<unknown> => {
        const out: unknown = testOpenAiKey();
        return Promise.resolve(out);
    },
}));

vi.mock('@/background/messaging/broadcast-prefs-updated', () => ({
    PrefsBroadcast: {
        sendUpdatedToAllTabs: async (prefs: unknown): Promise<void> => {
            await Promise.resolve(prefsBroadcast(prefs));
        },
    },
}));

vi.mock('@/background/messaging/prefs-port-hub', () => ({
    PrefsPortHub: {
        broadcastPrefsUpdate: (prefs: unknown): void => {
            prefsPortBroadcast(prefs);
        },
    },
}));

vi.mock('@/background/messaging/promo-analysis', () => ({
    PromoAnalysis: {
        abortForProviderChange: (providerId: string): void => {
            abortForProviderChange(providerId);
        },
    },
}));

vi.mock('@/background/permissions/provider-host-access', () => ({
    ProviderHostAccess: {
        all: (): Promise<unknown> => {
            const out: unknown = providerHostAccessAll();
            return Promise.resolve(out);
        },
        isGranted: (providerId: string): Promise<unknown> => {
            const out: unknown = providerHostAccessIsGranted(providerId);
            return Promise.resolve(out);
        },
    },
}));

const debugLogMock = vi.hoisted(() => ({ record: vi.fn() }));

vi.mock('@/background/debug-log/debug-log', () => ({ DebugLog: debugLogMock }));

const { ModelRuntimeMessages } =
    await import('@/background/messaging/model-runtime-messages');

describe('ModelRuntimeMessages', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        providerHostAccessAll.mockResolvedValue({
            openrouter: 'granted',
            openai: 'granted',
        });
        providerHostAccessIsGranted.mockResolvedValue(true);
    });

    it.each([
        {
            apiKey: '',
            hostAccessStatus: 'missing',
            connectionStatus: 'missing',
            modelAvailability: 'unavailable',
        },
        {
            apiKey: 'sk-or',
            hostAccessStatus: 'missing',
            connectionStatus: 'saved',
            modelAvailability: 'unavailable',
        },
        {
            apiKey: '',
            hostAccessStatus: 'granted',
            connectionStatus: 'missing',
            modelAvailability: 'unavailable',
        },
        {
            apiKey: 'sk-or',
            hostAccessStatus: 'granted',
            connectionStatus: 'saved',
            modelAvailability: 'available',
        },
    ])(
        'keeps OpenRouter key/access independent: %#',
        async ({
            apiKey,
            hostAccessStatus,
            connectionStatus,
            modelAvailability,
        }) => {
            prefsLoad.mockResolvedValue({
                enabled: true,
                providerId: 'openrouter',
                activeModelId:
                    'openrouter:google/gemini-3.1-pro-preview',
            });
            openRouterLoad.mockResolvedValue({
                apiKey,
                model: 'google/gemini-3.1-pro-preview',
                customModels: [],
            });
            openAiLoad.mockResolvedValue({ apiKey: '', model: '' });
            providerHostAccessAll.mockResolvedValue({
                openrouter: hostAccessStatus,
                openai: 'missing',
            });

            const response = await ModelRuntimeMessages.handleGetSettings();

            expect(response).toEqual(expect.objectContaining({ ok: true }));
            if (!response.ok) {
                return;
            }
            const connection = response.connections.find(
                (item) => item.providerId === 'openrouter',
            );
            const model = response.models.find(
                (item) => item.providerId === 'openrouter',
            );
            expect(connection).toEqual(
                expect.objectContaining({
                    status: connectionStatus,
                    hostAccessStatus,
                }),
            );
            expect(model?.availability).toBe(modelAvailability);
        },
    );

    it('returns models and connections', async () => {
        prefsLoad.mockResolvedValue({
            enabled: true,
            providerId: 'openrouter',
            activeModelId: 'openrouter:google/gemini-3.1-pro-preview',
        });
        openRouterLoad.mockResolvedValue({
            apiKey: 'sk-or',
            model: 'google/gemini-3.1-pro-preview',
            customModels: [],
        });
        openAiLoad.mockResolvedValue({ apiKey: 'sk-openai', model: 'gpt-5.2' });
        const response = await ModelRuntimeMessages.handleGetSettings();
        expect(response).toEqual(expect.objectContaining({ ok: true }));
        if (response.ok) {
            expect(response.models.some((m) => m.providerId === 'openai')).toBe(
                true,
            );
            expect(response.connections).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ providerId: 'openrouter' }),
                    expect.objectContaining({ providerId: 'openai' }),
                ]),
            );
        }
    });

    it('sets active model and derived provider', async () => {
        prefsLoad.mockResolvedValue({
            enabled: true,
            providerId: 'openrouter',
            activeModelId: 'openrouter:google/gemini-3.1-pro-preview',
        });
        openRouterLoad.mockResolvedValue({
            apiKey: 'sk-or',
            model: 'google/gemini-3.1-pro-preview',
            customModels: [],
        });
        openAiLoad.mockResolvedValue({ apiKey: '', model: '' });

        const response =
            await ModelRuntimeMessages.handleSetActiveModel('openai:gpt-5.2');

        expect(response).toEqual({ ok: true });
        expect(prefsSave).toHaveBeenCalledWith(
            expect.objectContaining({
                providerId: 'openai',
                activeModelId: 'openai:gpt-5.2',
            }),
        );
        expect(openAiSave).toHaveBeenCalledWith({
            apiKey: '',
            model: 'gpt-5.2',
        });
    });

    it.each([
        {
            providerId: 'openrouter' as const,
            load: openRouterLoad,
            test: testOpenRouterKey,
            config: {
                apiKey: 'sk-openrouter',
                model: 'provider/model',
                customModels: [],
            },
        },
        {
            providerId: 'openai' as const,
            load: openAiLoad,
            test: testOpenAiKey,
            config: { apiKey: 'sk-openai', model: 'gpt-5.2' },
        },
    ])(
        'requires the $providerId host grant before testing a saved key',
        async ({ providerId, load, test, config }) => {
            load.mockResolvedValue(config);
            providerHostAccessIsGranted.mockResolvedValue(false);

            const response =
                await ModelRuntimeMessages.handleTestConnectionKey(
                    providerId,
                    undefined,
                );

            expect(response).toEqual({
                ok: false,
                code: 'host_access_required',
                providerId,
            });
            expect(providerHostAccessIsGranted).toHaveBeenCalledWith(
                providerId,
            );
            expect(test).not.toHaveBeenCalled();
        },
    );

    it('records connection-key-saved with the provider only (never the key)', async () => {
        openRouterLoad.mockReturnValue({ apiKey: '', model: 'provider/model', customModels: [] });

        const result = await ModelRuntimeMessages.handleSaveConnectionKey(
            PROVIDER_ID.OpenRouter,
            'sk-APIKEY-SENTINEL',
        );

        expect(result).toEqual({ ok: true, apiKeyMasked: '****r' });
        expect(debugLogMock.record).toHaveBeenCalledWith(
            DEBUG_LOG_EVENT.ConnectionKeySaved,
            { provider: PROVIDER_ID.OpenRouter },
        );
        expect(JSON.stringify(debugLogMock.record.mock.calls)).not.toContain('sk-APIKEY-SENTINEL');
    });

    it('does not record connection-key-saved when the save fails', async () => {
        openRouterLoad.mockReturnValue({ apiKey: '', model: 'provider/model', customModels: [] });
        openRouterSave.mockRejectedValueOnce(new Error('quota'));

        const result = await ModelRuntimeMessages.handleSaveConnectionKey(
            PROVIDER_ID.OpenRouter,
            'sk-APIKEY-SENTINEL',
        );

        expect(result).toEqual({ ok: false, error: 'quota' });
        expect(debugLogMock.record).not.toHaveBeenCalled();
    });
});
