import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { callOpenAiResponse, testOpenAiApiKey } =
    await import('@/background/openai/openai-client');

describe('openai client', () => {
    beforeEach(() => fetchMock.mockReset());

    it('tests key with models endpoint', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            json: () => Promise.resolve({ data: [{ id: 'gpt-5.2' }] }),
        });
        await expect(testOpenAiApiKey('sk-test')).resolves.toEqual({
            ok: true,
            valid: true,
        });
    });

    it('classifies 401 as invalid key', async () => {
        fetchMock.mockResolvedValue({
            ok: false,
            status: 401,
            text: () => Promise.resolve('bad'),
        });
        await expect(testOpenAiApiKey('bad')).resolves.toEqual({
            ok: true,
            valid: false,
            error: 'OpenAI API key is invalid.',
        });
    });

    it('calls Responses API and returns output text', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            json: () =>
                Promise.resolve({
                    output: [
                        {
                            content: [
                                {
                                    type: 'output_text',
                                    text: '{"hasPromo":false}',
                                },
                            ],
                        },
                    ],
                }),
        });
        const result = await callOpenAiResponse({
            apiKey: 'sk-test',
            model: 'gpt-5.2',
            instructions: 'system',
            input: 'transcript',
        });
        expect(result).toEqual({ ok: true, rawContent: '{"hasPromo":false}' });
    });

    it('adds status and kind to an HTTP failure', async () => {
        fetchMock.mockResolvedValue({
            ok: false,
            status: 500,
            text: () => Promise.resolve('server oops'),
        });
        const r = await callOpenAiResponse({
            apiKey: 'sk',
            model: 'gpt-5.2',
            instructions: 's',
            input: 'i',
        });
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.status).toBe(500);
            expect(r.kind).toBe('http');
        }
    });
});
