import { beforeEach, describe, expect, it, vi } from 'vitest';

const storageGet = vi.fn();
const storageSet = vi.fn();

vi.mock('@/shared/browser', () => ({
    default: {
        storage: {
            local: {
                get: storageGet,
                set: storageSet,
            },
        },
    },
}));

const { PrefsSyncStorage } = await import('@/background/storage/prefs-sync');
const { DEFAULT_DETECTION_MODEL_ID, CHROME_BUILTIN_MODEL_ID } =
    await import('@/shared/detection-models');

describe('PrefsSyncStorage model migration', () => {
    beforeEach(() => {
        storageGet.mockReset();
        storageSet.mockReset();
    });

    it('adds activeModelId to existing OpenRouter prefs', async () => {
        storageGet.mockResolvedValue({
            'topskip:prefs': { enabled: true, providerId: 'openrouter' },
        });
        const prefs = await PrefsSyncStorage.load();
        expect(prefs.activeModelId).toBe(DEFAULT_DETECTION_MODEL_ID);
        expect(prefs.providerId).toBe('openrouter');
        expect(storageSet).toHaveBeenCalled();
    });

    it('maps old Chrome provider prefs to the built-in model id', async () => {
        storageGet.mockResolvedValue({
            'topskip:prefs': { enabled: true, providerId: 'chrome-prompt-api' },
        });
        const prefs = await PrefsSyncStorage.load();
        expect(prefs.activeModelId).toBe(CHROME_BUILTIN_MODEL_ID);
    });

    it('defaults legacy prefs to server analysis mode', async () => {
        storageGet.mockResolvedValue({
            'topskip:prefs': { enabled: true, providerId: 'openrouter' },
        });

        const prefs = await PrefsSyncStorage.load();

        expect(prefs.analysisMode).toBe('server');
        expect(storageSet).toHaveBeenCalledWith({
            'topskip:prefs': {
                enabled: true,
                providerId: 'openrouter',
                activeModelId: DEFAULT_DETECTION_MODEL_ID,
                analysisMode: 'server',
            },
        });
    });
});
