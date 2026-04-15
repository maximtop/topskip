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
            choices: [{ message: { content: '{"hasPromo":false}' } }],
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
