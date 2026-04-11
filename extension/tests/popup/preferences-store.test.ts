import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PreferencesStore } from '@/popup/preferences-store';
import { TOPSKIP_MESSAGE } from '@/shared/messages';

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
}));

vi.mock('@/shared/browser', () => ({
  default: {
    runtime: {
      sendMessage: mocks.sendMessage,
    },
  },
}));

describe('PreferencesStore', () => {
  beforeEach(() => {
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValue({
      ok: true,
      prefs: { enabled: false },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('load applies stored enabled flag', async () => {
    const store = new PreferencesStore();
    await store.load();
    expect(store.enabled).toBe(false);
    expect(mocks.sendMessage).toHaveBeenCalledWith({
      type: TOPSKIP_MESSAGE.GET_PREFS,
    });
  });

  it('setEnabled sends SET_PREFS to background', async () => {
    mocks.sendMessage.mockResolvedValue({ ok: true });
    const store = new PreferencesStore();
    await store.setEnabled(true);
    expect(mocks.sendMessage).toHaveBeenCalledWith({
      type: TOPSKIP_MESSAGE.SET_PREFS,
      enabled: true,
    });
  });

  it('load rejects when background returns error', async () => {
    mocks.sendMessage.mockResolvedValueOnce({
      ok: false,
      error: 'storage failure',
    });

    const store = new PreferencesStore();
    await expect(store.load()).rejects.toThrow('storage failure');
  });

  it('setEnabled rejects and reverts on background error', async () => {
    const store = new PreferencesStore();
    store.enabled = true;
    mocks.sendMessage.mockResolvedValueOnce({
      ok: false,
      error: 'write denied',
    });

    await expect(store.setEnabled(false)).rejects.toThrow('write denied');
    expect(store.enabled).toBe(true);
  });
});
