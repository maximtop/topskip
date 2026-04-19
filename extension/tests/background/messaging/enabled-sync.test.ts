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

/* -------------------------------------------------------------- */
/*  FR-014 removed: SET_PREFS no longer touches OpenRouter storage */
/* -------------------------------------------------------------- */

describe('SET_PREFS does NOT propagate to OpenRouter storage (FR-014 removed)',
  () => {
    beforeEach(() => {
      vi.clearAllMocks();
      storageGet.mockImplementation((key: string) => {
        if (key === STORAGE_KEY_PREFS) {
          return Promise.resolve({
            [STORAGE_KEY_PREFS]: { enabled: true, providerId: 'openrouter' },
          });
        }
        if (key === STORAGE_KEY_OPENROUTER) {
          return Promise.resolve({
            [STORAGE_KEY_OPENROUTER]: {
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

    it(
      'SET_PREFS saves prefs but does not write OpenRouter storage',
      async () => {
      const result = await PrefsRuntimeMessages.handle(
        { type: 'TOPSKIP_SET_PREFS', enabled: false },
        { id: 'test' },
      );
      expect(result).toEqual({ ok: true });

      // Prefs key must be written
      const prefsSetCall = storageSet.mock.calls.find(
        (call: unknown[]) => {
          const arg = call[0] as Record<string, unknown>;
          return STORAGE_KEY_PREFS in arg;
        },
      );
      expect(prefsSetCall).toBeDefined();

      // OpenRouter key must NOT be written
      const orSetCall = storageSet.mock.calls.find(
        (call: unknown[]) => {
          const arg = call[0] as Record<string, unknown>;
          return STORAGE_KEY_OPENROUTER in arg;
        },
      );
      expect(orSetCall).toBeUndefined();
    });
  });

/* -------------------------------------------------------------- */
/*  FR-015 removed: SET_OPENROUTER_CONFIG no longer touches prefs  */
/* -------------------------------------------------------------- */

describe(
  'SET_OPENROUTER_CONFIG does NOT propagate to prefs (FR-015 removed)',
  () => {
    beforeEach(() => {
      vi.clearAllMocks();
      storageGet.mockImplementation((key: string) => {
        if (key === STORAGE_KEY_PREFS) {
          return Promise.resolve({
            [STORAGE_KEY_PREFS]: { enabled: true, providerId: 'openrouter' },
          });
        }
        if (key === STORAGE_KEY_OPENROUTER) {
          return Promise.resolve({
            [STORAGE_KEY_OPENROUTER]: {
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

    it(
      'SET_OPENROUTER_CONFIG saves OR config but does not write prefs',
      async () => {
      const result = await OpenRouterRuntimeMessages.handle(
        {
          type: 'TOPSKIP_SET_OPENROUTER_CONFIG',
          apiKey: '',
          model: 'test/model',
        },
        { id: 'test' },
      );
      expect(result).toEqual({ ok: true });

      // OpenRouter key must be written
      const orSetCall = storageSet.mock.calls.find(
        (call: unknown[]) => {
          const arg = call[0] as Record<string, unknown>;
          return STORAGE_KEY_OPENROUTER in arg;
        },
      );
      expect(orSetCall).toBeDefined();

      // Prefs key must NOT be written
      const prefsSetCall = storageSet.mock.calls.find(
        (call: unknown[]) => {
          const arg = call[0] as Record<string, unknown>;
          return STORAGE_KEY_PREFS in arg;
        },
      );
      expect(prefsSetCall).toBeUndefined();
    });
  });
