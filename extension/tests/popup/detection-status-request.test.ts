import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POPUP_DETECTION_REQUEST_TIMEOUT_MS } from '@/popup/constants';
import { requestDetectionStatusWithTimeout } from '@/popup/detection-status-request';

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

describe('detection status request', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        mocks.sendMessage.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns a background response and cancels the timeout', async () => {
        const response = { ok: true, tabId: 42, state: null };
        mocks.sendMessage.mockResolvedValue(response);

        await expect(requestDetectionStatusWithTimeout()).resolves.toBe(
            response,
        );
        expect(vi.getTimerCount()).toBe(0);
    });

    it('cancels the timeout when the runtime promise rejects', async () => {
        mocks.sendMessage.mockRejectedValue(new Error('worker unavailable'));

        await expect(requestDetectionStatusWithTimeout()).rejects.toThrow(
            'worker unavailable',
        );
        expect(vi.getTimerCount()).toBe(0);
    });

    it('cancels the timeout when sendMessage throws synchronously', async () => {
        mocks.sendMessage.mockImplementation(() => {
            throw new Error('runtime unavailable');
        });

        await expect(requestDetectionStatusWithTimeout()).rejects.toThrow(
            'runtime unavailable',
        );
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects a lost reply only after the five-second bound', async () => {
        mocks.sendMessage.mockImplementation(
            () =>
                new Promise<unknown>(() => {
                    // A killed service worker may never deliver its reply.
                }),
        );
        let settled = false;
        const request = requestDetectionStatusWithTimeout();
        void request.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );

        await vi.advanceTimersByTimeAsync(
            POPUP_DETECTION_REQUEST_TIMEOUT_MS - 1,
        );
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await expect(request).rejects.toThrow(
            'Detection status request timed out.',
        );
        expect(settled).toBe(true);
    });
});
