import { describe, expect, it, vi, beforeEach } from 'vitest';

const {
  sendMessage,
  storageGet,
  storageSet,
  tabsQuery,
  tabsSendMessage,
  registerContentScripts,
  unregisterContentScripts,
} = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  storageGet: vi.fn(),
  storageSet: vi.fn(),
  tabsQuery: vi.fn().mockResolvedValue([]),
  tabsSendMessage: vi.fn().mockResolvedValue(undefined),
  registerContentScripts: vi.fn().mockResolvedValue(undefined),
  unregisterContentScripts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/shared/browser', () => ({
  default: {
    runtime: { sendMessage },
    storage: { local: { get: storageGet, set: storageSet } },
    tabs: { query: tabsQuery, sendMessage: tabsSendMessage },
    scripting: {
      registerContentScripts,
      unregisterContentScripts,
    },
  },
}));

import { PrefsRuntimeMessages } from
  '@/background/messaging/runtime-messages';
import { OpenRouterRuntimeMessages } from
  '@/background/messaging/openrouter-runtime-messages';
import { STORAGE_KEY_PREFS, STORAGE_KEY_OPENROUTER } from
  '@/shared/constants';

describe('SET_PREFS propagates enabled to OpenRouter storage (FR-014)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // PrefsSyncStorage.ready() — seed prefs
    storageGet.mockImplementation((key: string) => {
      if (key === STORAGE_KEY_PREFS) {
        return Promise.resolve({
          [STORAGE_KEY_PREFS]: { enabled: true },
        });
      }
      if (key === STORAGE_KEY_OPENROUTER) {
        return Promise.resolve({
          [STORAGE_KEY_OPENROUTER]: {
            enabled: false,
            apiKey: 'sk-test',
            model: 'test/model',
            customModels: [],
          },
        });
      }
      return Promise.resolve({});
    });
    storageSet.mockResolvedValue(undefined);
  });

  it('updates OpenRouter enabled when popup sets enabled=false', async () => {
    const result = await PrefsRuntimeMessages.handle(
      { type: 'TOPSKIP_SET_PREFS', enabled: false },
      { id: 'test' },
    );
    expect(result).toEqual({ ok: true });

    // Verify that storage.set was called for BOTH keys
    const prefsSetCall = storageSet.mock.calls.find(
      (call: unknown[]) => {
        const arg = call[0] as Record<string, unknown>;
        return STORAGE_KEY_PREFS in arg;
      },
    );
    expect(prefsSetCall).toBeDefined();

    const orSetCall = storageSet.mock.calls.find(
      (call: unknown[]) => {
        const arg = call[0] as Record<string, unknown>;
        return STORAGE_KEY_OPENROUTER in arg;
      },
    );
    expect(orSetCall).toBeDefined();
    const orValue = (orSetCall![0] as Record<string, Record<string, unknown>>)[
      STORAGE_KEY_OPENROUTER
    ];
    expect(orValue.enabled).toBe(false);
  });
});

describe('SET_OPENROUTER_CONFIG propagates enabled to prefs (FR-015)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storageGet.mockImplementation((key: string) => {
      if (key === STORAGE_KEY_PREFS) {
        return Promise.resolve({
          [STORAGE_KEY_PREFS]: { enabled: true },
        });
      }
      if (key === STORAGE_KEY_OPENROUTER) {
        return Promise.resolve({
          [STORAGE_KEY_OPENROUTER]: {
            enabled: true,
            apiKey: 'sk-test',
            model: 'test/model',
            customModels: [],
          },
        });
      }
      return Promise.resolve({});
    });
    storageSet.mockResolvedValue(undefined);
    tabsQuery.mockResolvedValue([]);
  });

  it('updates prefs enabled and broadcasts when options' +
    ' sets enabled=false', async () => {
    const result = await OpenRouterRuntimeMessages.handle(
      {
        type: 'TOPSKIP_SET_OPENROUTER_CONFIG',
        enabled: false,
        apiKey: '',
        model: 'test/model',
      },
      { id: 'test' },
    );
    expect(result).toEqual({ ok: true });

    // Verify prefs storage was updated
    const prefsSetCall = storageSet.mock.calls.find(
      (call: unknown[]) => {
        const arg = call[0] as Record<string, unknown>;
        return STORAGE_KEY_PREFS in arg;
      },
    );
    expect(prefsSetCall).toBeDefined();
    const prefsValue = (
      prefsSetCall![0] as Record<
        string, Record<string, unknown>
      >
    )[STORAGE_KEY_PREFS];
    expect(prefsValue.enabled).toBe(false);

    // Verify broadcast was sent to all tabs
    expect(tabsQuery).toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------- */
/*  FR-016: reconcile divergent enabled flags on init              */
/* -------------------------------------------------------------- */

import { reconcileDivergentEnabled } from '@/background/background';

describe('reconcileDivergentEnabled (FR-016)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storageSet.mockResolvedValue(undefined);
  });

  it('resolves to true when prefs=true but openrouter=false', async () => {
    storageGet.mockImplementation((key: string) => {
      if (key === STORAGE_KEY_PREFS) {
        return Promise.resolve({
          [STORAGE_KEY_PREFS]: { enabled: true },
        });
      }
      if (key === STORAGE_KEY_OPENROUTER) {
        return Promise.resolve({
          [STORAGE_KEY_OPENROUTER]: {
            enabled: false,
            apiKey: 'sk-test',
            model: 'test/model',
            customModels: ['test/model'],
          },
        });
      }
      return Promise.resolve({});
    });

    await reconcileDivergentEnabled();

    const orSetCall = storageSet.mock.calls.find(
      (call: unknown[]) => {
        const arg = call[0] as Record<string, unknown>;
        return STORAGE_KEY_OPENROUTER in arg;
      },
    );
    expect(orSetCall).toBeDefined();
    const orValue = (orSetCall![0] as Record<string, Record<string, unknown>>)[
      STORAGE_KEY_OPENROUTER
    ];
    expect(orValue.enabled).toBe(true);
  });

  it('resolves to true when prefs=false but openrouter=true', async () => {
    storageGet.mockImplementation((key: string) => {
      if (key === STORAGE_KEY_PREFS) {
        return Promise.resolve({
          [STORAGE_KEY_PREFS]: { enabled: false },
        });
      }
      if (key === STORAGE_KEY_OPENROUTER) {
        return Promise.resolve({
          [STORAGE_KEY_OPENROUTER]: {
            enabled: true,
            apiKey: 'sk-test',
            model: 'test/model',
            customModels: ['test/model'],
          },
        });
      }
      return Promise.resolve({});
    });

    await reconcileDivergentEnabled();

    const prefsSetCall = storageSet.mock.calls.find(
      (call: unknown[]) => {
        const arg = call[0] as Record<string, unknown>;
        return STORAGE_KEY_PREFS in arg;
      },
    );
    expect(prefsSetCall).toBeDefined();
    const prefsValue = (
      prefsSetCall![0] as Record<
        string, Record<string, unknown>
      >
    )[STORAGE_KEY_PREFS];
    expect(prefsValue.enabled).toBe(true);
  });

  it('does nothing when both agree', async () => {
    storageGet.mockImplementation((key: string) => {
      if (key === STORAGE_KEY_PREFS) {
        return Promise.resolve({
          [STORAGE_KEY_PREFS]: { enabled: true },
        });
      }
      if (key === STORAGE_KEY_OPENROUTER) {
        return Promise.resolve({
          [STORAGE_KEY_OPENROUTER]: {
            enabled: true,
            apiKey: 'sk-test',
            model: 'test/model',
            customModels: ['test/model'],
          },
        });
      }
      return Promise.resolve({});
    });

    await reconcileDivergentEnabled();

    // Only PrefsSyncStorage.ready() seed calls — no extra writes
    // to unify since they already agree.
    const orSetCalls = storageSet.mock.calls.filter(
      (call: unknown[]) => {
        const arg = call[0] as Record<string, unknown>;
        return STORAGE_KEY_OPENROUTER in arg;
      },
    );
    expect(orSetCalls.length).toBe(0);
  });
});
