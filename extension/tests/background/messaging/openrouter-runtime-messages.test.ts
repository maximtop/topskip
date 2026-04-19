import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpenRouterConfig } from '@/background/storage/openrouter-storage';
import { OpenRouterRuntimeMessages } from
  '@/background/messaging/openrouter-runtime-messages';
import { TOPSKIP_MESSAGE } from '@/shared/messages';
import { OPENROUTER_DEFAULT_MODEL_SLUG } from
  '@/shared/openrouter-model-presets';

const loadMock = vi.fn();
const saveMock = vi.fn();
const maskMock = vi.fn();
const fetchModelsMock = vi.fn();

/* No longer needs transitive browser/prefs/broadcast mocks since FR-015
   sync was removed from handleSet. */

vi.mock('@/background/storage/openrouter-storage', () => ({
  OpenRouterStorage: {
    /**
     * @returns Mocked config
     */
    load: async (): Promise<OpenRouterConfig> => {
      const out: unknown = await loadMock();
      return out as OpenRouterConfig;
    },
    /**
     * @param c - Config passed from handler
     * @returns Resolves when mock finishes
     */
    save: async (c: OpenRouterConfig): Promise<void> => {
      await Promise.resolve(saveMock(c));
    },
    /**
     * @param k - Raw API key
     * @returns Masked key from mock
     */
    maskApiKey: (k: string): string | null => {
      return maskMock(k) as string | null;
    },
  },
}));

vi.mock('@/background/openrouter/openrouter-models-api', () => ({
  fetchOpenRouterModelList: async (apiKey: string): Promise<string[]> => {
    return fetchModelsMock(apiKey) as Promise<string[]>;
  },
}));

describe('OpenRouterRuntimeMessages', () => {
  beforeEach(() => {
    loadMock.mockReset();
    saveMock.mockReset();
    maskMock.mockReset();
    fetchModelsMock.mockReset();
  });

  it('handleGet returns customModels', async () => {
    loadMock.mockResolvedValue({
      apiKey: 'k',
      model: OPENROUTER_DEFAULT_MODEL_SLUG,
      customModels: ['x/y'],
    });
    maskMock.mockReturnValue('****');
    const r = await OpenRouterRuntimeMessages.handle(
      { type: TOPSKIP_MESSAGE.GET_OPENROUTER_CONFIG },
      {} as never,
    );
    expect(r).toEqual({
      ok: true,
      model: OPENROUTER_DEFAULT_MODEL_SLUG,
      apiKeyMasked: '****',
      customModels: ['x/y'],
    });
  });

  it('handleSet merges customModels from current storage', async () => {
    loadMock.mockResolvedValue({
      apiKey: '',
      model: '',
      customModels: ['saved/custom'],
    });
    saveMock.mockResolvedValue(undefined);
    const r = await OpenRouterRuntimeMessages.handle(
      {
        type: TOPSKIP_MESSAGE.SET_OPENROUTER_CONFIG,
        apiKey: '',
        model: OPENROUTER_DEFAULT_MODEL_SLUG,
      },
      {} as never,
    );
    expect(r).toEqual({ ok: true });
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: OPENROUTER_DEFAULT_MODEL_SLUG,
        customModels: ['saved/custom'],
      }),
    );
  });

  it('handleAddCustomModel rejects empty slug', async () => {
    const r = await OpenRouterRuntimeMessages.handle(
      {
        type: TOPSKIP_MESSAGE.ADD_OPENROUTER_CUSTOM_MODEL,
        slug: '   ',
      },
      {} as never,
    );
    expect(r).toEqual({ ok: false, error: 'Model id is required' });
    expect(saveMock).not.toHaveBeenCalled();
  });

  it('handleAddCustomModel rejects builtin slug', async () => {
    const r = await OpenRouterRuntimeMessages.handle(
      {
        type: TOPSKIP_MESSAGE.ADD_OPENROUTER_CUSTOM_MODEL,
        slug: OPENROUTER_DEFAULT_MODEL_SLUG,
      },
      {} as never,
    );
    expect(r).toEqual({
      ok: false,
      error: 'That model is already a built-in preset',
    });
  });

  it('handleAddCustomModel appends and selects model', async () => {
    loadMock.mockResolvedValue({
      apiKey: '',
      model: OPENROUTER_DEFAULT_MODEL_SLUG,
      customModels: [],
    });
    saveMock.mockResolvedValue(undefined);
    const r = await OpenRouterRuntimeMessages.handle(
      {
        type: TOPSKIP_MESSAGE.ADD_OPENROUTER_CUSTOM_MODEL,
        slug: '  vendor/foo  ',
      },
      {} as never,
    );
    expect(r).toEqual({ ok: true, customModels: ['vendor/foo'] });
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'vendor/foo',
        customModels: ['vendor/foo'],
      }),
    );
  });

  it('handleRemoveCustomModel resets active model when removed', async () => {
    loadMock.mockResolvedValue({
      apiKey: '',
      model: 'vendor/foo',
      customModels: ['vendor/foo'],
    });
    saveMock.mockResolvedValue(undefined);
    const r = await OpenRouterRuntimeMessages.handle(
      {
        type: TOPSKIP_MESSAGE.REMOVE_OPENROUTER_CUSTOM_MODEL,
        slug: 'vendor/foo',
      },
      {} as never,
    );
    expect(r).toEqual({ ok: true, customModels: [] });
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: OPENROUTER_DEFAULT_MODEL_SLUG,
        customModels: [],
      }),
    );
  });

  it('handleValidateModelSlug rejects invalid format slug', async () => {
    const r = await OpenRouterRuntimeMessages.handle(
      {
        type: TOPSKIP_MESSAGE.VALIDATE_OPENROUTER_MODEL,
        slug: 'invalid-format',
        apiKey: 'sk-test',
      },
      {} as never,
    );
    expect(r).toEqual({
      ok: true,
      valid: false,
      error: 'Invalid format. Use owner/model-name.',
    });
  });

  it('slug valid with empty key is unverified', async () => {
    const r = await OpenRouterRuntimeMessages.handle(
      {
        type: TOPSKIP_MESSAGE.VALIDATE_OPENROUTER_MODEL,
        slug: 'google/gemini-2.5-flash',
        apiKey: '',
      },
      {} as never,
    );
    expect(r).toEqual({
      ok: true,
      valid: true,
      unverified: true,
    });
  });

  it('checks API when key is present slug found', async () => {
    fetchModelsMock.mockResolvedValue([
      'google/gemini-2.5-flash',
      'openai/gpt-4o',
    ]);
    const r = await OpenRouterRuntimeMessages.handle(
      {
        type: TOPSKIP_MESSAGE.VALIDATE_OPENROUTER_MODEL,
        slug: 'google/gemini-2.5-flash',
        apiKey: 'sk-test',
      },
      {} as never,
    );
    expect(r).toEqual({ ok: true, valid: true });
  });

  it('rejects slug not found in API', async () => {
    fetchModelsMock.mockResolvedValue(['google/gemini-2.5-flash']);
    const r = await OpenRouterRuntimeMessages.handle(
      {
        type: TOPSKIP_MESSAGE.VALIDATE_OPENROUTER_MODEL,
        slug: 'nonexistent/model',
        apiKey: 'sk-test',
      },
      {} as never,
    );
    expect(r).toEqual({
      ok: true,
      valid: false,
      error: 'Model not found on OpenRouter.',
    });
  });

  it('gracefully handles API fetch error', async () => {
    fetchModelsMock.mockResolvedValue([]);
    const r = await OpenRouterRuntimeMessages.handle(
      {
        type: TOPSKIP_MESSAGE.VALIDATE_OPENROUTER_MODEL,
        slug: 'google/gemini-2.5-flash',
        apiKey: 'sk-test',
      },
      {} as never,
    );
    expect(r).toEqual({
      ok: true,
      valid: true,
      unverified: true,
    });
  });
});
