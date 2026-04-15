const OPENROUTER_CHAT_COMPLETIONS_URL =
  'https://openrouter.ai/api/v1/chat/completions';

export type OpenRouterChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type CallOpenRouterChatParams = {
  apiKey: string;
  model: string;
  messages: OpenRouterChatMessage[];
  signal?: AbortSignal;
};

/**
 * Calls OpenRouter chat completions (non-streaming). Does not log the API key.
 *
 * @param params - Model, key, messages, optional abort signal
 * @returns Assistant message text or error
 */
export async function callOpenRouterChat(
  params: CallOpenRouterChatParams,
): Promise<
  { ok: true; rawContent: string } | { ok: false; error: string }
> {
  const { apiKey, model, messages, signal } = params;
  try {
    const res = await fetch(OPENROUTER_CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        stream: false,
      }),
      signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        error: `OpenRouter HTTP ${res.status}: ${text.slice(0, 200)}`,
      };
    }
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      return { ok: false, error: 'OpenRouter response was not JSON' };
    }
    if (!json || typeof json !== 'object') {
      return { ok: false, error: 'OpenRouter JSON shape invalid' };
    }
    const choices = (json as { choices?: unknown }).choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      return { ok: false, error: 'OpenRouter response missing choices' };
    }
    const first = choices[0] as { message?: { content?: unknown } };
    const content = first.message?.content;
    if (typeof content !== 'string') {
      return { ok: false, error: 'OpenRouter assistant content missing' };
    }
    return { ok: true, rawContent: content };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
