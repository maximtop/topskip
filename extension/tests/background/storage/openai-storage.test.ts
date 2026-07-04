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

const { OpenAiStorage } = await import('@/background/storage/openai-storage');

describe('OpenAiStorage', () => {
    beforeEach(() => {
        storageGet.mockReset();
        storageSet.mockReset();
    });

    it('returns defaults when storage is missing', async () => {
        storageGet.mockResolvedValue({});
        await expect(OpenAiStorage.load()).resolves.toEqual({
            apiKey: '',
            model: '',
        });
    });

    it('masks saved api keys', () => {
        expect(OpenAiStorage.maskApiKey('sk-test-1234')).toBe('****1234');
    });
});
