import { beforeEach, describe, expect, it, vi } from 'vitest';

import { STORAGE_KEY_PREFS } from '@/shared/constants';

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

import { PrefsSyncStorage } from '@/background/storage/prefs-sync';

describe('PrefsSyncStorage', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.set.mockReset();
  });

  it('loads defaults with providerId when storage empty', async () => {
    mocks.get.mockResolvedValue({});
    const prefs = await PrefsSyncStorage.load();
    expect(prefs.enabled).toBe(true);
    expect(prefs.providerId).toBe('openrouter');
  });

  it('loads persisted prefs with providerId', async () => {
    mocks.get.mockResolvedValue({
      [STORAGE_KEY_PREFS]: {
        enabled: false,
        providerId: 'chrome-prompt-api',
      },
    });
    const prefs = await PrefsSyncStorage.load();
    expect(prefs.enabled).toBe(false);
    expect(prefs.providerId).toBe('chrome-prompt-api');
  });

  it('save persists providerId', async () => {
    mocks.set.mockResolvedValue(undefined);
    await PrefsSyncStorage.save({
      enabled: false,
      providerId: 'chrome-prompt-api',
    });
    expect(mocks.set).toHaveBeenCalledWith({
      [STORAGE_KEY_PREFS]: {
        enabled: false,
        providerId: 'chrome-prompt-api',
      },
    });
  });
});
