import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpenRouterConfig } from '@/background/storage/openrouter-storage';
import { OpenRouterRuntimeMessages } from '@/background/messaging/openrouter-runtime-messages';
import { DEFAULT_DETECTION_MODEL_ID } from '@/shared/detection-models';
import { OPENROUTER_DEFAULT_MODEL_SLUG } from '@/shared/openrouter-model-presets';

const loadMock = vi.fn();
const saveMock = vi.fn();
const maskMock = vi.fn();
const fetchModelsMock = vi.fn();
const prefsLoadMock = vi.fn();
const prefsSaveMock = vi.fn();
const prefsBroadcastMock = vi.fn();
const prefsPortBroadcastMock = vi.fn();

vi.mock('@/background/storage/openrouter-storage', () => ({
    OpenRouterStorage: {
        /**
         * @returns Mocked config
         */
        load: async (): Promise<OpenRouterConfig> => {
            const out: unknown = await loadMock();
            return out as OpenRouterConfig;
        },
        /**
         * @param c - Config passed from handler
         * @returns Resolves when mock finishes
         */
        save: async (c: OpenRouterConfig): Promise<void> => {
            await Promise.resolve(saveMock(c));
        },
        /**
         * @param k - Raw API key
         * @returns Masked key from mock
         */
        maskApiKey: (k: string): string | null => {
            return maskMock(k) as string | null;
        },
    },
}));

vi.mock('@/background/storage/prefs-sync', () => ({
    PrefsSyncStorage: {
        ready: async (): Promise<void> => {},
        load: async (): Promise<unknown> => {
            return await prefsLoadMock();
        },
        save: async (prefs: unknown): Promise<void> => {
            await Promise.resolve(prefsSaveMock(prefs));
        },
    },
}));

vi.mock('@/background/messaging/broadcast-prefs-updated', () => ({
    PrefsBroadcast: {
        sendUpdatedToAllTabs: async (prefs: unknown): Promise<void> => {
            await Promise.resolve(prefsBroadcastMock(prefs));
        },
    },
}));

vi.mock('@/background/messaging/prefs-port-hub', () => ({
    PrefsPortHub: {
        broadcastPrefsUpdate: (prefs: unknown): void => {
            prefsPortBroadcastMock(prefs);
        },
    },
}));

vi.mock('@/background/openrouter/openrouter-models-api', () => ({
    fetchOpenRouterModelList: async (apiKey: string): Promise<string[]> => {
        return fetchModelsMock(apiKey) as Promise<string[]>;
    },
}));

describe('OpenRouterRuntimeMessages', () => {
    beforeEach(() => {
        loadMock.mockReset();
        saveMock.mockReset();
        maskMock.mockReset();
        fetchModelsMock.mockReset();
        prefsLoadMock.mockReset();
        prefsSaveMock.mockReset();
        prefsBroadcastMock.mockReset();
        prefsPortBroadcastMock.mockReset();
        prefsLoadMock.mockResolvedValue({
            enabled: true,
            providerId: 'openrouter',
            activeModelId: DEFAULT_DETECTION_MODEL_ID,
        });
    });

    it('handleGet returns customModels', async () => {
        loadMock.mockResolvedValue({
            apiKey: 'k',
            model: OPENROUTER_DEFAULT_MODEL_SLUG,
            customModels: ['x/y'],
        });
        maskMock.mockReturnValue('****');
        const r = await OpenRouterRuntimeMessages.handleGet();
        expect(r).toEqual({
            ok: true,
            model: OPENROUTER_DEFAULT_MODEL_SLUG,
            apiKeyMasked: '****',
            customModels: ['x/y'],
        });
    });

    it('handleSet merges customModels from current storage', async () => {
        loadMock.mockResolvedValue({
            apiKey: '',
            model: '',
            customModels: ['saved/custom'],
        });
        saveMock.mockResolvedValue(undefined);
        const r = await OpenRouterRuntimeMessages.handleSet(
            '',
            OPENROUTER_DEFAULT_MODEL_SLUG,
        );
        expect(r).toEqual({ ok: true });
        expect(saveMock).toHaveBeenCalledWith(
            expect.objectContaining({
                model: OPENROUTER_DEFAULT_MODEL_SLUG,
                customModels: ['saved/custom'],
            }),
        );
    });

    it('handleAddCustomModel rejects empty slug', async () => {
        const r = await OpenRouterRuntimeMessages.handleAddCustomModel('   ');
        expect(r).toEqual({ ok: false, error: 'Model id is required' });
        expect(saveMock).not.toHaveBeenCalled();
    });

    it('handleAddCustomModel rejects builtin slug', async () => {
        const r = await OpenRouterRuntimeMessages.handleAddCustomModel(
            OPENROUTER_DEFAULT_MODEL_SLUG,
        );
        expect(r).toEqual({
            ok: false,
            error: 'That model is already a built-in preset',
        });
    });

    it('handleAddCustomModel appends and selects model', async () => {
        loadMock.mockResolvedValue({
            apiKey: '',
            model: OPENROUTER_DEFAULT_MODEL_SLUG,
            customModels: [],
        });
        saveMock.mockResolvedValue(undefined);
        const r =
            await OpenRouterRuntimeMessages.handleAddCustomModel(
                '  vendor/foo  ',
            );
        expect(r).toEqual({ ok: true, customModels: ['vendor/foo'] });
        expect(saveMock).toHaveBeenCalledWith(
            expect.objectContaining({
                model: 'vendor/foo',
                customModels: ['vendor/foo'],
            }),
        );
    });

    it('handleRemoveCustomModel resets active model when removed', async () => {
        loadMock.mockResolvedValue({
            apiKey: '',
            model: 'vendor/foo',
            customModels: ['vendor/foo'],
        });
        saveMock.mockResolvedValue(undefined);
        const r =
            await OpenRouterRuntimeMessages.handleRemoveCustomModel(
                'vendor/foo',
            );
        expect(r).toEqual({ ok: true, customModels: [] });
        expect(saveMock).toHaveBeenCalledWith(
            expect.objectContaining({
                model: OPENROUTER_DEFAULT_MODEL_SLUG,
                customModels: [],
            }),
        );
    });

    it('handleRemoveCustomModel repairs active model prefs when removed', async () => {
        loadMock.mockResolvedValue({
            apiKey: '',
            model: 'vendor/foo',
            customModels: ['vendor/foo'],
        });
        prefsLoadMock.mockResolvedValue({
            enabled: true,
            providerId: 'openrouter',
            activeModelId: 'openrouter:vendor/foo',
        });
        saveMock.mockResolvedValue(undefined);
        prefsSaveMock.mockResolvedValue(undefined);
        prefsBroadcastMock.mockResolvedValue(undefined);

        const r =
            await OpenRouterRuntimeMessages.handleRemoveCustomModel(
                'vendor/foo',
            );

        expect(r).toEqual({ ok: true, customModels: [] });
        expect(prefsSaveMock).toHaveBeenCalledWith({
            enabled: true,
            providerId: 'openrouter',
            activeModelId: DEFAULT_DETECTION_MODEL_ID,
        });
        expect(prefsBroadcastMock).toHaveBeenCalledWith(
            expect.objectContaining({
                activeModelId: DEFAULT_DETECTION_MODEL_ID,
            }),
        );
        expect(prefsPortBroadcastMock).toHaveBeenCalledWith(
            expect.objectContaining({
                activeModelId: DEFAULT_DETECTION_MODEL_ID,
            }),
        );
    });

    it('handleValidateModelSlug rejects invalid format slug', async () => {
        const r = await OpenRouterRuntimeMessages.handleValidateModelSlug(
            'invalid-format',
            'sk-test',
        );
        expect(r).toEqual({
            ok: true,
            valid: false,
            error: 'Invalid format. Use owner/model-name.',
        });
    });

    it('slug valid with empty key is unverified', async () => {
        const r = await OpenRouterRuntimeMessages.handleValidateModelSlug(
            'google/gemini-2.5-flash',
            '',
        );
        expect(r).toEqual({
            ok: true,
            valid: true,
            unverified: true,
        });
    });

    it('checks API when key is present slug found', async () => {
        fetchModelsMock.mockResolvedValue([
            'google/gemini-2.5-flash',
            'openai/gpt-4o',
        ]);
        const r = await OpenRouterRuntimeMessages.handleValidateModelSlug(
            'google/gemini-2.5-flash',
            'sk-test',
        );
        expect(r).toEqual({ ok: true, valid: true });
    });

    it('rejects slug not found in API', async () => {
        fetchModelsMock.mockResolvedValue(['google/gemini-2.5-flash']);
        const r = await OpenRouterRuntimeMessages.handleValidateModelSlug(
            'nonexistent/model',
            'sk-test',
        );
        expect(r).toEqual({
            ok: true,
            valid: false,
            error: 'Model not found on OpenRouter.',
        });
    });

    it('gracefully handles API fetch error', async () => {
        fetchModelsMock.mockResolvedValue([]);
        const r = await OpenRouterRuntimeMessages.handleValidateModelSlug(
            'google/gemini-2.5-flash',
            'sk-test',
        );
        expect(r).toEqual({
            ok: true,
            valid: true,
            unverified: true,
        });
    });
});
