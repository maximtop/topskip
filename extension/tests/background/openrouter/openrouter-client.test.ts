import { afterEach, describe, expect, it, vi } from 'vitest';

import { callOpenRouterChat } from '@/background/openrouter/openrouter-client';

describe('callOpenRouterChat', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('posts JSON and returns raw assistant text', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: (): Promise<string> =>
        Promise.resolve(
          JSON.stringify({
            id: 'gen-123',
            model: 'openai/gpt-5.4',
            choices: [
              {
                finish_reason: 'stop',
                native_finish_reason: 'stop',
                message: { content: '{"hasPromo":false}' },
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 4,
              total_tokens: 14,
              prompt_tokens_details: {
                cached_tokens: 2,
              },
              completion_tokens_details: {
                reasoning_tokens: 1,
              },
              cost: 0.1234,
            },
          }),
        ),
    });
    vi.stubGlobal('fetch', fetchMock);

    const r = await callOpenRouterChat({
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rawContent).toBe('{"hasPromo":false}');
      expect(r.responseId).toBe('gen-123');
      expect(r.responseModel).toBe('openai/gpt-5.4');
      expect(r.finishReason).toBe('stop');
      expect(r.nativeFinishReason).toBe('stop');
      expect(r.usage?.promptTokens).toBe(10);
      expect(r.usage?.completionTokens).toBe(4);
      expect(r.usage?.totalTokens).toBe(14);
      expect(r.usage?.promptTokensDetails?.cachedTokens).toBe(2);
      expect(r.usage?.completionTokensDetails?.reasoningTokens).toBe(1);
      expect(r.usage?.cost).toBe(0.1234);
    }
    expect(fetchMock).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer k',
          'Content-Type': 'application/json',
        },
      }),
    );
  });

  it('returns error on non-OK HTTP', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: (): Promise<string> => Promise.resolve('unauthorized'),
      }),
    );

    const r = await callOpenRouterChat({
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('401');
    }
  });
});
