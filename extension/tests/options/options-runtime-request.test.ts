import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { requestOptionsRuntimeMessage } from '@/options/options-runtime-request';
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

const TIMEOUT_MS = 1_234;
const MESSAGE = { type: TOPSKIP_MESSAGE.GET_DEBUG_LOG_STATUS } as const;

describe('requestOptionsRuntimeMessage', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        mocks.sendMessage.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns the worker response and cancels the timeout', async () => {
        const response = { ok: true };
        mocks.sendMessage.mockResolvedValue(response);

        await expect(
            requestOptionsRuntimeMessage(MESSAGE, TIMEOUT_MS),
        ).resolves.toBe(response);
        expect(mocks.sendMessage).toHaveBeenCalledWith(MESSAGE);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('cancels the timeout when the runtime promise rejects', async () => {
        mocks.sendMessage.mockRejectedValue(new Error('worker unavailable'));

        await expect(
            requestOptionsRuntimeMessage(MESSAGE, TIMEOUT_MS),
        ).rejects.toThrow('worker unavailable');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('cancels the timeout when sendMessage throws synchronously', async () => {
        mocks.sendMessage.mockImplementation(() => {
            throw new Error('runtime unavailable');
        });

        await expect(
            requestOptionsRuntimeMessage(MESSAGE, TIMEOUT_MS),
        ).rejects.toThrow('runtime unavailable');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects a lost reply only after the given bound', async () => {
        mocks.sendMessage.mockImplementation(
            () =>
                new Promise<unknown>(() => {
                    // A killed service worker may never deliver its reply.
                }),
        );
        let settled = false;
        const request = requestOptionsRuntimeMessage(MESSAGE, TIMEOUT_MS);
        void request.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );

        await vi.advanceTimersByTimeAsync(TIMEOUT_MS - 1);
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await expect(request).rejects.toThrow(
            'Options runtime request timed out.',
        );
        expect(settled).toBe(true);
    });
});
