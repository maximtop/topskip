import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('openrouter-models-api', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
    });

    it('fetches models list from OpenRouter API', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () =>
                Promise.resolve({
                    data: [
                        { id: 'google/gemini-2.5-flash' },
                        { id: 'openai/gpt-4o' },
                    ],
                }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const { fetchOpenRouterModelList } =
            await import('@/background/openrouter/openrouter-models-api');
        const models = await fetchOpenRouterModelList('sk-test');
        expect(models).toContain('google/gemini-2.5-flash');
        expect(models).toContain('openai/gpt-4o');
        expect(mockFetch).toHaveBeenCalledWith(
            'https://openrouter.ai/api/v1/models',
            expect.objectContaining({
                headers: { Authorization: 'Bearer sk-test' },
            }),
        );
    });

    it('caches models list for subsequent calls with same key', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () =>
                Promise.resolve({
                    data: [{ id: 'google/gemini-2.5-flash' }],
                }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const { fetchOpenRouterModelList } =
            await import('@/background/openrouter/openrouter-models-api');
        await fetchOpenRouterModelList('sk-test');
        await fetchOpenRouterModelList('sk-test');

        expect(mockFetch).toHaveBeenCalledOnce();
    });

    it('returns empty array on network error', async () => {
        const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
        vi.stubGlobal('fetch', mockFetch);

        const { fetchOpenRouterModelList } =
            await import('@/background/openrouter/openrouter-models-api');
        const models = await fetchOpenRouterModelList('sk-test');
        expect(models).toEqual([]);
    });

    it('returns empty array when response is not ok', async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: false });
        vi.stubGlobal('fetch', mockFetch);

        const { fetchOpenRouterModelList } =
            await import('@/background/openrouter/openrouter-models-api');
        const models = await fetchOpenRouterModelList('sk-test');
        expect(models).toEqual([]);
    });

    it('gracefully handles malformed response', async () => {
        const mockFetch = vi.fn().mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ data: 'not-an-array' }),
        });
        vi.stubGlobal('fetch', mockFetch);

        const { fetchOpenRouterModelList } =
            await import('@/background/openrouter/openrouter-models-api');
        const models = await fetchOpenRouterModelList('sk-test');
        expect(models).toEqual([]);
    });
});
