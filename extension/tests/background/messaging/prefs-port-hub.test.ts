import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PREFS_PORT_NAME } from '@/shared/constants';
import { TOPSKIP_MESSAGE } from '@/shared/messages';

/**
 * Builds a fake Port with the same listener surface as
 * `browser.runtime.Port` so PrefsPortHub can be tested
 * without the real extension runtime.
 */
function createMockPort(name: string = PREFS_PORT_NAME) {
    const onDisconnectListeners: Array<(port: unknown) => void> = [];
    const onMessageListeners: Array<(msg: unknown, port: unknown) => void> = [];
    const port = {
        name,
        postMessage: vi.fn(),
        disconnect: vi.fn(),
        onDisconnect: {
            addListener: vi.fn((fn: (port: unknown) => void) => {
                onDisconnectListeners.push(fn);
            }),
            removeListener: vi.fn(),
        },
        onMessage: {
            addListener: vi.fn((fn: (msg: unknown, port: unknown) => void) => {
                onMessageListeners.push(fn);
            }),
            removeListener: vi.fn(),
        },
    };
    return {
        port,
        /**
         * Triggers stored onDisconnect listeners so tests can verify
         * cleanup behavior without a real browser runtime.
         */
        simulateDisconnect: () => {
            for (const fn of onDisconnectListeners) {
                fn(port);
            }
        },
        /**
         * Triggers stored onMessage listeners so tests can inject
         * arbitrary payloads without a real browser runtime.
         */
        simulateMessage: (msg: unknown) => {
            for (const fn of onMessageListeners) {
                fn(msg, port);
            }
        },
    };
}

const onConnectListeners: Array<(port: unknown) => void> = [];

vi.mock('@/shared/browser', () => ({
    default: {
        runtime: {
            onConnect: {
                addListener: vi.fn((fn: (port: unknown) => void) => {
                    onConnectListeners.push(fn);
                }),
            },
        },
    },
}));

// Must import after vi.mock so the module picks up the mocked
// browser.runtime.onConnect instead of the real one.
import { PrefsPortHub } from '@/background/messaging/prefs-port-hub';

describe('PrefsPortHub', () => {
    beforeEach(() => {
        onConnectListeners.length = 0;
        PrefsPortHub.register();
    });

    afterEach(() => {
        // Each test starts fresh — clear leftover ports so state
        // from one test does not leak into the next.
        PrefsPortHub.disconnectAll();
        vi.clearAllMocks();
    });

    it('register() adds an onConnect listener', () => {
        expect(onConnectListeners.length).toBe(1);
    });

    it('accepts a port with the correct name', () => {
        const { port } = createMockPort(PREFS_PORT_NAME);
        // Trigger the listener that register() stored, as if
        // the browser just opened a new port connection.
        onConnectListeners[0](port);
        expect(port.onDisconnect.addListener).toHaveBeenCalledOnce();
        expect(PrefsPortHub.connectedCount()).toBe(1);
    });

    it('ignores a port with the wrong name', () => {
        const { port } = createMockPort('some-other-port');
        onConnectListeners[0](port);
        expect(port.onDisconnect.addListener).not.toHaveBeenCalled();
        expect(PrefsPortHub.connectedCount()).toBe(0);
    });

    it('removes a port on disconnect', () => {
        const { port, simulateDisconnect } = createMockPort();
        onConnectListeners[0](port);
        expect(PrefsPortHub.connectedCount()).toBe(1);
        simulateDisconnect();
        expect(PrefsPortHub.connectedCount()).toBe(0);
    });

    it('broadcastPrefsUpdate posts to all connected ports', () => {
        const m1 = createMockPort();
        const m2 = createMockPort();
        onConnectListeners[0](m1.port);
        onConnectListeners[0](m2.port);

        PrefsPortHub.broadcastPrefsUpdate({
            enabled: false,
            providerId: 'openrouter',
            activeModelId: 'openrouter:test/model',
            analysisMode: 'server',
        });

        const expected = {
            type: TOPSKIP_MESSAGE.PREFS_UPDATED,
            prefs: {
                enabled: false,
                providerId: 'openrouter',
                activeModelId: 'openrouter:test/model',
                analysisMode: 'server',
            },
        };
        expect(m1.port.postMessage).toHaveBeenCalledWith(expected);
        expect(m2.port.postMessage).toHaveBeenCalledWith(expected);
    });

    it('broadcastPrefsUpdate skips disconnected ports gracefully', () => {
        const m1 = createMockPort();
        const m2 = createMockPort();
        onConnectListeners[0](m1.port);
        onConnectListeners[0](m2.port);
        m2.simulateDisconnect();

        PrefsPortHub.broadcastPrefsUpdate({
            enabled: true,
            providerId: 'openrouter',
            activeModelId: 'openrouter:test/model',
            analysisMode: 'server',
        });
        expect(m1.port.postMessage).toHaveBeenCalledOnce();
        expect(m2.port.postMessage).not.toHaveBeenCalled();
    });

    it('disconnectAll clears all ports', () => {
        const m1 = createMockPort();
        const m2 = createMockPort();
        onConnectListeners[0](m1.port);
        onConnectListeners[0](m2.port);
        expect(PrefsPortHub.connectedCount()).toBe(2);

        PrefsPortHub.disconnectAll();
        expect(PrefsPortHub.connectedCount()).toBe(0);
    });
});
