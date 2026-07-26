import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const { ModelRuntimeMessages } =
    await import('@/background/messaging/model-runtime-messages');

describe('ModelRuntimeMessages', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

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
});
