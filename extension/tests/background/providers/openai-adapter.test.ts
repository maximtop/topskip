import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadMock = vi.fn();
const callOpenAiResponseMock = vi.fn();
const providerHostAccessIsGrantedMock = vi.fn();

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

vi.mock('@/background/permissions/provider-host-access', () => ({
    ProviderHostAccess: {
        isGranted: (providerId: string): Promise<unknown> => {
            const out: unknown = providerHostAccessIsGrantedMock(providerId);
            return Promise.resolve(out);
        },
    },
}));

const { OpenAiAdapter } = await import('@/background/providers/openai-adapter');
const { PROVIDER_ID, PROVIDER_AVAILABILITY } =
    await import('@/background/providers/llm-provider-adapter');

describe('OpenAiAdapter', () => {
    beforeEach(() => {
        loadMock.mockReset();
        callOpenAiResponseMock.mockReset();
        providerHostAccessIsGrantedMock.mockReset().mockResolvedValue(true);
    });

    it('is available when api key and model exist', async () => {
        loadMock.mockResolvedValue({ apiKey: 'sk-test', model: 'gpt-5.2' });
        await expect(new OpenAiAdapter().availability()).resolves.toBe(
            PROVIDER_AVAILABILITY.AVAILABLE,
        );
    });

    it('is unavailable without calling the client when access is missing', async () => {
        loadMock.mockResolvedValue({ apiKey: 'sk-test', model: 'gpt-5.2' });
        providerHostAccessIsGrantedMock.mockResolvedValue(false);

        await expect(new OpenAiAdapter().availability()).resolves.toBe(
            PROVIDER_AVAILABILITY.UNAVAILABLE,
        );
        expect(callOpenAiResponseMock).not.toHaveBeenCalled();
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

    it('surfaces the client status and kind on an HTTP failure', async () => {
        loadMock.mockResolvedValue({ apiKey: 'sk-test', model: 'gpt-5.2' });
        callOpenAiResponseMock.mockResolvedValue({
            ok: false,
            error: 'OpenAI HTTP 429: rate',
            status: 429,
            kind: 'http',
        });

        const result = await new OpenAiAdapter().analyzeTranscript({
            transcript: 'hello',
            videoId: 'v',
            languageCode: 'en',
        });

        expect(result).toMatchObject({ ok: false, status: 429, kind: 'http' });
    });

    it('tags a parse failure with kind parse and a null status', async () => {
        loadMock.mockResolvedValue({ apiKey: 'sk-test', model: 'gpt-5.2' });
        callOpenAiResponseMock.mockResolvedValue({
            ok: true,
            rawContent: 'not json at all',
        });

        const result = await new OpenAiAdapter().analyzeTranscript({
            transcript: 'hello',
            videoId: 'v',
            languageCode: 'en',
        });

        expect(result).toMatchObject({ ok: false, status: null, kind: 'parse' });
    });

    it('rechecks access immediately before fetch after preflight revocation', async () => {
        loadMock.mockResolvedValue({ apiKey: 'sk-test', model: 'gpt-5.2' });
        providerHostAccessIsGrantedMock
            .mockResolvedValueOnce(true)
            .mockResolvedValueOnce(false);
        const adapter = new OpenAiAdapter();

        await expect(adapter.availability()).resolves.toBe(
            PROVIDER_AVAILABILITY.AVAILABLE,
        );
        await expect(
            adapter.analyzeTranscript({
                transcript: 'hello',
                videoId: 'v',
                languageCode: 'en',
            }),
        ).resolves.toEqual({
            ok: false,
            failureCode: 'host_access_required',
            error: 'Provider host access is required',
        });
        expect(providerHostAccessIsGrantedMock).toHaveBeenCalledTimes(2);
        expect(callOpenAiResponseMock).not.toHaveBeenCalled();
    });
});
