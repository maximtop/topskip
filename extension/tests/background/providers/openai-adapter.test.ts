import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadMock = vi.fn();
const callOpenAiResponseMock = vi.fn();

vi.mock('@/background/storage/openai-storage', () => ({
    OpenAiStorage: {
        load: (): Promise<unknown> => {
            const out: unknown = loadMock();
            return Promise.resolve(out);
        },
    },
}));

vi.mock('@/background/openai/openai-client', () => ({
    callOpenAiResponse: (params: unknown): Promise<unknown> => {
        const out: unknown = callOpenAiResponseMock(params);
        return Promise.resolve(out);
    },
}));

const { OpenAiAdapter } = await import('@/background/providers/openai-adapter');
const { PROVIDER_ID, PROVIDER_AVAILABILITY } =
    await import('@/background/providers/llm-provider-adapter');

describe('OpenAiAdapter', () => {
    beforeEach(() => {
        loadMock.mockReset();
        callOpenAiResponseMock.mockReset();
    });

    it('is available when api key and model exist', async () => {
        loadMock.mockResolvedValue({ apiKey: 'sk-test', model: 'gpt-5.2' });
        await expect(new OpenAiAdapter().availability()).resolves.toBe(
            PROVIDER_AVAILABILITY.AVAILABLE,
        );
    });

    it('delegates transcript analysis to OpenAI Responses API', async () => {
        loadMock.mockResolvedValue({ apiKey: 'sk-test', model: 'gpt-5.2' });
        callOpenAiResponseMock.mockResolvedValue({
            ok: true,
            rawContent: '{"hasPromo":false}',
        });
        const result = await new OpenAiAdapter().analyzeTranscript({
            transcript: 'hello',
            videoId: 'v',
            languageCode: 'en',
        });
        expect(result).toEqual({
            ok: true,
            hasPromo: false,
            providerMeta: { id: PROVIDER_ID.OpenAI, model: 'gpt-5.2' },
            rawAssistant: '{"hasPromo":false}',
        });
    });
});
