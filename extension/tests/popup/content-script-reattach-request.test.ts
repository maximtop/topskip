import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POPUP_REATTACH_REQUEST_TIMEOUT_MS } from '@/popup/constants';
import { requestContentScriptReattachWithTimeout } from '@/popup/content-script-reattach-request';
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

describe('content script re-attach request', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        mocks.sendMessage.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('sends the payload-free re-attach message and returns the reply', async () => {
        const response = { ok: true, tabId: 42, outcome: 'reattached' };
        mocks.sendMessage.mockResolvedValue(response);

        await expect(
            requestContentScriptReattachWithTimeout(),
        ).resolves.toBe(response);
        expect(mocks.sendMessage).toHaveBeenCalledWith({
            type: TOPSKIP_MESSAGE.REATTACH_CONTENT_SCRIPT,
        });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects a lost reply only after the bounded timeout', async () => {
        mocks.sendMessage.mockImplementation(
            () =>
                new Promise<unknown>(() => {
                    // A killed service worker may never deliver its reply.
                }),
        );
        let settled = false;
        const request = requestContentScriptReattachWithTimeout();
        void request.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );

        await vi.advanceTimersByTimeAsync(POPUP_REATTACH_REQUEST_TIMEOUT_MS - 1);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await expect(request).rejects.toThrow(
            'Content script re-attach request timed out.',
        );
    });
});
