import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenRouterStorage } from '@/background/storage/openrouter-storage';
import { STORAGE_KEY_OPENROUTER } from '@/shared/constants';
import { OPENROUTER_DEFAULT_MODEL_SLUG } from
  '@/shared/openrouter-model-presets';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock('@/shared/browser', () => ({
  default: {
    storage: {
      local: {
        get: mocks.get,
        set: mocks.set,
      },
    },
  },
}));

describe('OpenRouterStorage', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.set.mockReset();
  });

  it('loads defaults when storage empty', async () => {
    mocks.get.mockResolvedValue({});
    const c = await OpenRouterStorage.load();
    expect(c.apiKey).toBe('');
    expect(c.model).toBe('');
    expect(c.customModels).toEqual([]);
  });

  it('loads persisted config', async () => {
    mocks.get.mockResolvedValue({
      [STORAGE_KEY_OPENROUTER]: {
        apiKey: 'secret',
        model: OPENROUTER_DEFAULT_MODEL_SLUG,
        customModels: ['vendor/custom'],
      },
    });
    const c = await OpenRouterStorage.load();
    expect(c.apiKey).toBe('secret');
    expect(c.model).toBe(OPENROUTER_DEFAULT_MODEL_SLUG);
    expect(c.customModels).toEqual(['vendor/custom']);
  });

  it('loads legacy row without customModels key as empty array', async () => {
    mocks.get.mockResolvedValue({
      [STORAGE_KEY_OPENROUTER]: {
        apiKey: '',
        model: OPENROUTER_DEFAULT_MODEL_SLUG,
      },
    });
    const c = await OpenRouterStorage.load();
    expect(c.customModels).toEqual([]);
  });

  it('migrates custom-only active model into customModels list', async () => {
    mocks.get.mockResolvedValue({
      [STORAGE_KEY_OPENROUTER]: {
        apiKey: '',
        model: 'acme/promo-model',
        customModels: [],
      },
    });
    const c = await OpenRouterStorage.load();
    expect(c.model).toBe('acme/promo-model');
    expect(c.customModels).toEqual(['acme/promo-model']);
    expect(mocks.set).toHaveBeenCalledTimes(1);
    expect(mocks.set.mock.calls[0]?.[0]).toEqual({
      [STORAGE_KEY_OPENROUTER]: {
        apiKey: '',
        model: 'acme/promo-model',
        customModels: ['acme/promo-model'],
      },
    });
  });

  it('save persists customModels', async () => {
    mocks.set.mockResolvedValue(undefined);
    await OpenRouterStorage.save({
      apiKey: '',
      model: OPENROUTER_DEFAULT_MODEL_SLUG,
      customModels: ['a/b'],
    });
    expect(mocks.set.mock.calls[0]?.[0]).toEqual({
      [STORAGE_KEY_OPENROUTER]: {
        apiKey: '',
        model: OPENROUTER_DEFAULT_MODEL_SLUG,
        customModels: ['a/b'],
      },
    });
  });

  it('maskApiKey returns null for empty', () => {
    expect(OpenRouterStorage.maskApiKey('')).toBeNull();
  });

  it('maskApiKey masks tail', () => {
    expect(OpenRouterStorage.maskApiKey('abcdefgh')).toBe('****efgh');
  });
});
