import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PROVIDER_AVAILABILITY,
  PROVIDER_ID,
  type AnalyzeTranscriptParams,
} from '@/background/providers/llm-provider-adapter';

const mocks = vi.hoisted(() => ({
  callOpenRouterChat: vi.fn(),
  storageGet: vi.fn(),
  storageSet: vi.fn(),
}));

vi.mock('@/background/openrouter/openrouter-client', () => ({
  callOpenRouterChat: mocks.callOpenRouterChat,
}));

vi.mock('@/shared/browser', () => ({
  default: {
    storage: {
      local: {
        get: mocks.storageGet,
        set: mocks.storageSet,
      },
    },
  },
}));

/* Must import after mock setup so vi.mock takes effect. */
const { OpenRouterAdapter } = await import(
  '@/background/providers/openrouter-adapter'
);

const baseParams: AnalyzeTranscriptParams = {
  transcript: 'videoId=abc\nlanguage=en\n\nhello world',
  videoId: 'abc',
  languageCode: 'en',
  durationSec: 300,
};

describe('OpenRouterAdapter', () => {
  beforeEach(() => {
    mocks.callOpenRouterChat.mockReset();
    mocks.storageGet.mockReset();
    mocks.storageSet.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('properties', () => {
    it('has id matching PROVIDER_ID.OpenRouter', () => {
      const adapter = new OpenRouterAdapter();
      expect(adapter.id).toBe(PROVIDER_ID.OpenRouter);
    });

    it('has displayName "OpenRouter"', () => {
      const adapter = new OpenRouterAdapter();
      expect(adapter.displayName).toBe('OpenRouter');
    });
  });

  describe('availability', () => {
    it('returns "available" when apiKey and model are configured', async () => {
      mocks.storageGet.mockResolvedValue({
        'topskip:openrouter': {
          enabled: true,
          apiKey: 'sk-test',
          model: 'google/gemini-3.1-pro-preview',
          customModels: [],
        },
      });
      const adapter = new OpenRouterAdapter();
      const avail = await adapter.availability();
      expect(avail).toBe(
        PROVIDER_AVAILABILITY.Available,
      );
    });

    it('returns "unavailable" when apiKey is empty', async () => {
      mocks.storageGet.mockResolvedValue({
        'topskip:openrouter': {
          enabled: true,
          apiKey: '',
          model: 'google/gemini-3.1-pro-preview',
          customModels: [],
        },
      });
      const adapter = new OpenRouterAdapter();
      const avail = await adapter.availability();
      expect(avail).toBe(
        PROVIDER_AVAILABILITY.Unavailable,
      );
    });

    it('returns "unavailable" when model is empty', async () => {
      mocks.storageGet.mockResolvedValue({
        'topskip:openrouter': {
          enabled: true,
          apiKey: 'sk-test',
          model: '',
          customModels: [],
        },
      });
      const adapter = new OpenRouterAdapter();
      const avail = await adapter.availability();
      expect(avail).toBe(
        PROVIDER_AVAILABILITY.Unavailable,
      );
    });

    it('returns "unavailable" when storage is empty', async () => {
      mocks.storageGet.mockResolvedValue({});
      const adapter = new OpenRouterAdapter();
      const avail = await adapter.availability();
      expect(avail).toBe(
        PROVIDER_AVAILABILITY.Unavailable,
      );
    });
  });

  describe('analyzeTranscript', () => {
    it(
      'delegates to callOpenRouterChat and returns parsed promo blocks',
      async () => {
      mocks.storageGet.mockResolvedValue({
        'topskip:openrouter': {
          enabled: true,
          apiKey: 'sk-test',
          model: 'openai/gpt-4o',
          customModels: [],
        },
      });
      mocks.callOpenRouterChat.mockResolvedValue({
        ok: true,
        rawContent: JSON.stringify({
          hasPromo: true,
          promoBlocks: [{ startSec: 10, endSec: 40 }],
        }),
      });

      const adapter = new OpenRouterAdapter();
      const result = await adapter.analyzeTranscript(baseParams);

      expect(result.ok).toBe(true);
      if (result.ok && result.hasPromo) {
        expect(result.blocks).toEqual([{ startSec: 10, endSec: 40 }]);
        expect(result.providerMeta).toEqual({
          id: PROVIDER_ID.OpenRouter,
          model: 'openai/gpt-4o',
        });
      }

      expect(
        mocks.callOpenRouterChat,
      ).toHaveBeenCalledWith({
        apiKey: 'sk-test',
        model: 'openai/gpt-4o',
        signal: undefined,
        messages: [
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          { role: 'system', content: expect.any(String) },
          { role: 'user', content: baseParams.transcript },
        ],
      });
    });

    it('returns hasPromo false when LLM says no promo', async () => {
      mocks.storageGet.mockResolvedValue({
        'topskip:openrouter': {
          enabled: true,
          apiKey: 'sk-test',
          model: 'openai/gpt-4o',
          customModels: [],
        },
      });
      mocks.callOpenRouterChat.mockResolvedValue({
        ok: true,
        rawContent: JSON.stringify({ hasPromo: false }),
      });

      const adapter = new OpenRouterAdapter();
      const result = await adapter.analyzeTranscript(baseParams);

      expect(result).toEqual({
        ok: true,
        hasPromo: false,
        providerMeta: { id: PROVIDER_ID.OpenRouter, model: 'openai/gpt-4o' },
      });
    });

    it('returns error when callOpenRouterChat fails', async () => {
      mocks.storageGet.mockResolvedValue({
        'topskip:openrouter': {
          enabled: true,
          apiKey: 'sk-test',
          model: 'openai/gpt-4o',
          customModels: [],
        },
      });
      mocks.callOpenRouterChat.mockResolvedValue({
        ok: false,
        error: 'OpenRouter HTTP 429: rate limit',
      });

      const adapter = new OpenRouterAdapter();
      const result = await adapter.analyzeTranscript(baseParams);

      expect(result).toEqual({
        ok: false,
        error: 'OpenRouter HTTP 429: rate limit',
      });
    });

    it('returns error when parse fails', async () => {
      mocks.storageGet.mockResolvedValue({
        'topskip:openrouter': {
          enabled: true,
          apiKey: 'sk-test',
          model: 'openai/gpt-4o',
          customModels: [],
        },
      });
      mocks.callOpenRouterChat.mockResolvedValue({
        ok: true,
        rawContent: 'not json at all',
      });

      const adapter = new OpenRouterAdapter();
      const result = await adapter.analyzeTranscript(baseParams);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('not JSON');
      }
    });

    it('forwards the abort signal to callOpenRouterChat', async () => {
      mocks.storageGet.mockResolvedValue({
        'topskip:openrouter': {
          enabled: true,
          apiKey: 'sk-test',
          model: 'openai/gpt-4o',
          customModels: [],
        },
      });
      mocks.callOpenRouterChat.mockResolvedValue({
        ok: true,
        rawContent: JSON.stringify({ hasPromo: false }),
      });

      const abort = new AbortController();
      const adapter = new OpenRouterAdapter();
      await adapter.analyzeTranscript({ ...baseParams, signal: abort.signal });

      expect(mocks.callOpenRouterChat).toHaveBeenCalledWith(
        expect.objectContaining({ signal: abort.signal }),
      );
    });

    it('returns error when config has no apiKey', async () => {
      mocks.storageGet.mockResolvedValue({
        'topskip:openrouter': {
          enabled: true,
          apiKey: '',
          model: 'openai/gpt-4o',
          customModels: [],
        },
      });

      const adapter = new OpenRouterAdapter();
      const result = await adapter.analyzeTranscript(baseParams);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('not configured');
      }
    });
  });
});
