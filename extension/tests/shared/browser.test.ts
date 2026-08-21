import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

type NativeListener = (
    message: unknown,
    sender: unknown,
    sendResponse: (response?: unknown) => void,
) => unknown;

const nativeListeners: NativeListener[] = [];

// The polyfill reads `chrome.runtime.id` at import time and registers its
// wrapped listener on the native event, so the fake must exist before the
// module graph loads it.
vi.stubGlobal('chrome', {
    runtime: {
        id: 'topskip-test',
        onMessage: {
            addListener: (listener: NativeListener): void => {
                nativeListeners.push(listener);
            },
            removeListener: vi.fn(),
            hasListener: vi.fn(() => false),
        },
    },
});

const { default: browser } = await import('@/shared/browser');

/**
 * Delivers one message the way Chrome would and reports whether the wrapped
 * listener kept the channel open and what it replied.
 *
 * @param listener - Native listener registered by the polyfill wrapper.
 * @returns Channel flag returned to Chrome and the captured reply.
 */
async function deliver(
    listener: NativeListener | undefined,
): Promise<{ keptOpen: unknown; reply: unknown }> {
    if (listener === undefined) {
        throw new Error('The polyfill did not register a native listener.');
    }
    let reply: unknown = 'no-reply';
    const keptOpen = listener({ type: 'probe' }, {}, (response) => {
        reply = response;
    });
    await new Promise((resolve) => {
        setTimeout(resolve, 0);
    });
    return { keptOpen, reply };
}

describe('webextension-polyfill onMessage reply contract', () => {
    afterEach(() => {
        nativeListeners.length = 0;
    });

    afterAll(() => {
        vi.unstubAllGlobals();
    });

    it('forwards a Promise return value as the reply', async () => {
        browser.runtime.onMessage.addListener(
            (): unknown => Promise.resolve({ ok: true }),
        );

        const delivered = await deliver(nativeListeners[0]);

        expect(delivered.keptOpen).toBe(true);
        expect(delivered.reply).toEqual({ ok: true });
    });

    it('drops a plain-object return value, so content replies must be Promises', async () => {
        browser.runtime.onMessage.addListener((): unknown => ({ ok: true }));

        const delivered = await deliver(nativeListeners[0]);

        expect(delivered.keptOpen).toBe(false);
        expect(delivered.reply).toBe('no-reply');
    });
});
