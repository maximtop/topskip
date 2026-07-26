import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PreferencesStore } from '@/popup/preferences-store';
import { TOPSKIP_MESSAGE } from '@/shared/messages';
import { ANALYSIS_MODE } from '@/shared/constants';

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

/**
 * Default mock implementation that dispatches by message type.
 * GET_PREFS → prefs response; GET_ACTIVE_PROVIDER → provider response.
 *
 * @param msg - Inbound message from sendMessage.
 * @returns Mock response promise.
 */
function defaultSendMessage(msg: unknown): Promise<unknown> {
    const type: unknown =
        msg && typeof msg === 'object' ? Reflect.get(msg, 'type') : undefined;
    if (type === TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER) {
        return Promise.resolve({
            ok: true,
            providerId: 'openrouter',
            displayName: 'OpenRouter',
            modelName: 'google/gemini-2.0-flash',
        });
    }
    // Default: prefs response
    return Promise.resolve({
        ok: true,
        prefs: { enabled: false, providerId: 'openrouter' },
    });
}

describe('PreferencesStore', () => {
    beforeEach(() => {
        mocks.sendMessage.mockReset();
        mocks.sendMessage.mockImplementation(defaultSendMessage);
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

    it('load applies the stored analysis mode', async () => {
        mocks.sendMessage.mockImplementation((msg: unknown) => {
            const type: unknown =
                msg && typeof msg === 'object'
                    ? Reflect.get(msg, 'type')
                    : undefined;
            if (type === TOPSKIP_MESSAGE.GET_PREFS) {
                return Promise.resolve({
                    ok: true,
                    prefs: {
                        enabled: true,
                        providerId: 'openrouter',
                        activeModelId: 'openrouter:test',
                        analysisMode: ANALYSIS_MODE.Byok,
                    },
                });
            }
            return defaultSendMessage(msg);
        });

        const store = new PreferencesStore();
        await store.load();

        expect(store.analysisMode).toBe(ANALYSIS_MODE.Byok);
    });

    it('load applies stored enabled flag and providerId', async () => {
        mocks.sendMessage.mockImplementation((msg: unknown) => {
            const type: unknown =
                msg && typeof msg === 'object'
                    ? Reflect.get(msg, 'type')
                    : undefined;
            if (type === TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER) {
                return Promise.resolve({
                    ok: true,
                    providerId: 'chrome-prompt-api',
                    displayName: 'Chrome Built-in',
                    modelName: 'Gemini Nano',
                });
            }
            return Promise.resolve({
                ok: true,
                prefs: { enabled: false, providerId: 'chrome-prompt-api' },
            });
        });
        const store = new PreferencesStore();
        await store.load();
        expect(store.enabled).toBe(false);
        expect(store.providerId).toBe('chrome-prompt-api');
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
        mocks.sendMessage.mockImplementation((msg: unknown) => {
            const type: unknown =
                msg && typeof msg === 'object'
                    ? Reflect.get(msg, 'type')
                    : undefined;
            if (type === TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER) {
                return Promise.resolve({ ok: false, error: 'unavailable' });
            }
            return Promise.resolve({ ok: false, error: 'storage failure' });
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
            prefs: { enabled: false, providerId: 'openrouter' },
        });

        expect(store.enabled).toBe(false);
        expect(store.providerId).toBe('openrouter');

        listener({
            type: 'TOPSKIP_PREFS_UPDATED',
            prefs: { enabled: true, providerId: 'chrome-prompt-api' },
        });

        expect(store.enabled).toBe(true);
        expect(store.providerId).toBe('chrome-prompt-api');
    });

    it('updates analysis mode from the preferences port', () => {
        const store = new PreferencesStore();
        store.connectPort();
        const listener = mocks.connectOnMessage.addListener.mock
            .calls[0][0] as (msg: unknown) => void;

        listener({
            type: TOPSKIP_MESSAGE.PREFS_UPDATED,
            prefs: {
                enabled: true,
                providerId: 'openrouter',
                activeModelId: 'openrouter:test',
                analysisMode: ANALYSIS_MODE.Byok,
            },
        });

        expect(store.analysisMode).toBe(ANALYSIS_MODE.Byok);
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

    it('load populates providerDisplayName and modelDisplayName', async () => {
        const store = new PreferencesStore();
        await store.load();
        expect(store.providerDisplayName).toBe('OpenRouter');
        expect(store.modelDisplayName).toBe('google/gemini-2.0-flash');
        expect(mocks.sendMessage).toHaveBeenCalledWith({
            type: TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER,
        });
    });

    it('load sets empty display names when GET_ACTIVE_PROVIDER fails', async () => {
        mocks.sendMessage.mockImplementation((msg: unknown) => {
            const type: unknown =
                msg && typeof msg === 'object'
                    ? Reflect.get(msg, 'type')
                    : undefined;
            if (type === TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER) {
                return Promise.resolve({ ok: false, error: 'unavailable' });
            }
            return Promise.resolve({
                ok: true,
                prefs: { enabled: true, providerId: 'openrouter' },
            });
        });
        const store = new PreferencesStore();
        await store.load();
        expect(store.providerDisplayName).toBe('');
        expect(store.modelDisplayName).toBe('');
    });

    it('port message with changed providerId triggers refreshProviderDisplay', async () => {
        const store = new PreferencesStore();
        await store.load();

        // Seed refresh response for the provider change
        mocks.sendMessage.mockImplementation((msg: unknown) => {
            const type: unknown =
                msg && typeof msg === 'object'
                    ? Reflect.get(msg, 'type')
                    : undefined;
            if (type === TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER) {
                return Promise.resolve({
                    ok: true,
                    providerId: 'chrome-prompt-api',
                    displayName: 'Chrome Built-in',
                    modelName: 'Gemini Nano',
                });
            }
            return Promise.resolve({ ok: true });
        });

        store.connectPort();

        const listener = mocks.connectOnMessage.addListener.mock
            .calls[0][0] as (msg: unknown) => void;

        // Simulate provider change arriving on port
        listener({
            type: 'TOPSKIP_PREFS_UPDATED',
            prefs: { enabled: true, providerId: 'chrome-prompt-api' },
        });

        // refreshProviderDisplay is async — flush microtasks
        await Promise.resolve();
        await Promise.resolve();

        expect(store.providerDisplayName).toBe('Chrome Built-in');
        expect(store.modelDisplayName).toBe('Gemini Nano');
    });

    it('port message with same providerId does NOT call GET_ACTIVE_PROVIDER', async () => {
        const store = new PreferencesStore();
        await store.load();
        const callsBefore = mocks.sendMessage.mock.calls.length;

        store.connectPort();
        const listener = mocks.connectOnMessage.addListener.mock
            .calls[0][0] as (msg: unknown) => void;

        // Same provider as loaded ('openrouter')
        listener({
            type: 'TOPSKIP_PREFS_UPDATED',
            prefs: { enabled: false, providerId: 'openrouter' },
        });

        await Promise.resolve();

        // No extra sendMessage call for GET_ACTIVE_PROVIDER
        expect(mocks.sendMessage.mock.calls.length).toBe(callsBefore);
    });

    it('load fetches chrome model availability for chrome provider', async () => {
        mocks.sendMessage.mockImplementation((msg: unknown) => {
            const type: unknown =
                msg && typeof msg === 'object'
                    ? Reflect.get(msg, 'type')
                    : undefined;

            if (type === TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER) {
                return Promise.resolve({
                    ok: true,
                    providerId: 'chrome-prompt-api',
                    displayName: 'Chrome Built-in',
                    modelName: 'Gemini Nano',
                });
            }
            if (type === TOPSKIP_MESSAGE.GET_CHROME_PROMPT_API_STATUS) {
                return Promise.resolve({
                    ok: true,
                    availability: 'downloading',
                    downloadProgress: 25,
                });
            }
            return Promise.resolve({
                ok: true,
                prefs: { enabled: true, providerId: 'chrome-prompt-api' },
            });
        });

        const store = new PreferencesStore();
        await store.load();

        expect(store.chromeModelAvailability).toBe('downloading');
        expect(mocks.sendMessage).toHaveBeenCalledWith({
            type: TOPSKIP_MESSAGE.GET_CHROME_PROMPT_API_STATUS,
        });
    });

    it('load skips chrome model availability for openrouter', async () => {
        const store = new PreferencesStore();
        await store.load();

        expect(store.chromeModelAvailability).toBeNull();
        expect(mocks.sendMessage).not.toHaveBeenCalledWith({
            type: TOPSKIP_MESSAGE.GET_CHROME_PROMPT_API_STATUS,
        });
    });

    it('provider switch to chrome refreshes model availability', async () => {
        const store = new PreferencesStore();
        await store.load();

        mocks.sendMessage.mockImplementation((msg: unknown) => {
            const type: unknown =
                msg && typeof msg === 'object'
                    ? Reflect.get(msg, 'type')
                    : undefined;

            if (type === TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER) {
                return Promise.resolve({
                    ok: true,
                    providerId: 'chrome-prompt-api',
                    displayName: 'Chrome Built-in',
                    modelName: 'Gemini Nano',
                });
            }
            if (type === TOPSKIP_MESSAGE.GET_CHROME_PROMPT_API_STATUS) {
                return Promise.resolve({
                    ok: true,
                    availability: 'downloadable',
                    downloadProgress: null,
                });
            }
            return Promise.resolve({ ok: true });
        });

        store.connectPort();
        const listener = mocks.connectOnMessage.addListener.mock
            .calls[0][0] as (msg: unknown) => void;

        listener({
            type: TOPSKIP_MESSAGE.PREFS_UPDATED,
            prefs: { enabled: true, providerId: 'chrome-prompt-api' },
        });

        await Promise.resolve();
        await Promise.resolve();

        expect(store.chromeModelAvailability).toBe('downloadable');
    });
});
