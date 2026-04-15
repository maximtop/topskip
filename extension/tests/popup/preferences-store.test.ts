import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PreferencesStore } from '@/popup/preferences-store';
import { TOPSKIP_MESSAGE } from '@/shared/messages';

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  connectPostMessage: vi.fn(),
  connectDisconnect: vi.fn(),
  connectOnDisconnect: {
    addListener: vi.fn(),
    removeListener: vi.fn(),
  },
  connectOnMessage: {
    addListener: vi.fn(),
    removeListener: vi.fn(),
  },
}));

const mockPort = {
  name: 'topskip:prefs',
  postMessage: mocks.connectPostMessage,
  disconnect: mocks.connectDisconnect,
  onDisconnect: mocks.connectOnDisconnect,
  onMessage: mocks.connectOnMessage,
};

vi.mock('@/shared/browser', () => ({
  default: {
    runtime: {
      sendMessage: mocks.sendMessage,
      connect: vi.fn(() => mockPort),
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

  it('connectPort listens for PREFS_UPDATED on the port', () => {
    const store = new PreferencesStore();
    store.connectPort();
    expect(mocks.connectOnMessage.addListener).toHaveBeenCalledOnce();
  });

  it('updates enabled when a PREFS_UPDATED message arrives on the port', () => {
    const store = new PreferencesStore();
    store.connectPort();

    // Grab the listener that was registered
    const listener = mocks.connectOnMessage.addListener.mock
      .calls[0][0] as (msg: unknown) => void;

    // Simulate a message from the background
    listener({
      type: 'TOPSKIP_PREFS_UPDATED',
      prefs: { enabled: false },
    });

    expect(store.enabled).toBe(false);

    listener({
      type: 'TOPSKIP_PREFS_UPDATED',
      prefs: { enabled: true },
    });

    expect(store.enabled).toBe(true);
  });

  it('ignores invalid messages on the port', () => {
    const store = new PreferencesStore();
    store.enabled = true;
    store.connectPort();

    const listener = mocks.connectOnMessage.addListener.mock
      .calls[0][0] as (msg: unknown) => void;

    listener({ type: 'UNKNOWN_TYPE' });
    expect(store.enabled).toBe(true);

    listener(null);
    expect(store.enabled).toBe(true);
  });

  it('disconnectPort calls port.disconnect', () => {
    const store = new PreferencesStore();
    store.connectPort();
    store.disconnectPort();
    expect(mocks.connectDisconnect).toHaveBeenCalledOnce();
  });
});
