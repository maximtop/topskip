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

/* FR-015 added transitive imports of PrefsSyncStorage / PrefsBroadcast /
   ContentScriptsRegistration, all of which import @/shared/browser.
   Mock the polyfill + the three modules so this file stays focused on
   OpenRouterRuntimeMessages behaviour only. */
vi.mock('@/shared/browser', () => ({
  default: {
    runtime: { sendMessage: vi.fn() },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
      },
    },
    tabs: {
      query: vi.fn().mockResolvedValue([]),
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
    scripting: {
      registerContentScripts: vi.fn().mockResolvedValue(undefined),
      unregisterContentScripts: vi.fn().mockResolvedValue(undefined),
    },
  },
}));

vi.mock('@/background/storage/prefs-sync', () => ({
  PrefsSyncStorage: {
    ready: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue({ enabled: true }),
    save: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/background/messaging/broadcast-prefs-updated', () => ({
  PrefsBroadcast: {
    sendUpdatedToAllTabs: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/background/lifecycle/content-scripts-registration', () => ({
  ContentScriptsRegistration: {
    syncFromPrefs: vi.fn().mockResolvedValue(undefined),
  },
}));

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

describe('OpenRouterRuntimeMessages', () => {
  beforeEach(() => {
    loadMock.mockReset();
    saveMock.mockReset();
    maskMock.mockReset();
  });

  it('handleGet returns customModels', async () => {
    loadMock.mockResolvedValue({
      enabled: true,
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
      enabled: true,
      model: OPENROUTER_DEFAULT_MODEL_SLUG,
      apiKeyMasked: '****',
      customModels: ['x/y'],
    });
  });

  it('handleSet merges customModels from current storage', async () => {
    loadMock.mockResolvedValue({
      enabled: false,
      apiKey: '',
      model: '',
      customModels: ['saved/custom'],
    });
    saveMock.mockResolvedValue(undefined);
    const r = await OpenRouterRuntimeMessages.handle(
      {
        type: TOPSKIP_MESSAGE.SET_OPENROUTER_CONFIG,
        enabled: false,
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
      enabled: false,
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
      enabled: false,
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
});
