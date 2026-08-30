import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    OPTIONS_DIAGNOSTICS_BUNDLE_TIMEOUT_MS,
    OPTIONS_DIAGNOSTICS_REQUEST_TIMEOUT_MS,
} from '@/options/constants';
import {
    requestDebugLogBundle,
    requestDebugLogPreview,
    requestDebugLogStatus,
    requestSetDebugLogging,
} from '@/options/diagnostics-request';
import { TOPSKIP_MESSAGE, type DebugLogStatusPayload } from '@/shared/messages';

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

const STATUS: DebugLogStatusPayload = {
    enabled: true,
    hasLog: true,
    enabledAtMs: 1_755_856_800_000,
    disabledAtMs: null,
    eventCount: 42,
    sizeBytes: 6_144,
    capBytes: 5 * 1024 * 1024,
    evictedCount: 0,
    oldestRetainedMs: 1_755_856_800_000,
    dropped: { incognito: 1, coalesced: 2, ceiling: 0, unreachable: 0, lost: 0 },
    revision: 7,
};

/**
 * Leaves a request pending so the bound is the only way out.
 *
 * @returns Promise that never settles.
 */
function neverReplies(): Promise<unknown> {
    return new Promise<unknown>(() => {
        // A killed service worker may never deliver its reply.
    });
}

describe('diagnostics requests', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        mocks.sendMessage.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns the parsed status payload for an ok reply', async () => {
        mocks.sendMessage.mockResolvedValue({ ok: true, status: STATUS });

        await expect(requestDebugLogStatus()).resolves.toEqual(STATUS);
        expect(mocks.sendMessage).toHaveBeenCalledWith({
            type: TOPSKIP_MESSAGE.GET_DEBUG_LOG_STATUS,
        });
        expect(vi.getTimerCount()).toBe(0);
    });

    it('rejects refused and malformed status replies without raw error text', async () => {
        mocks.sendMessage.mockResolvedValueOnce({
            ok: false,
            error: 'Untrusted sender.',
        });
        await expect(requestDebugLogStatus()).rejects.toThrow(
            'Debug log reply was invalid.',
        );

        mocks.sendMessage.mockResolvedValueOnce({
            ok: true,
            status: { ...STATUS, eventCount: 'many' },
        });
        await expect(requestDebugLogStatus()).rejects.toThrow(
            'Debug log reply was invalid.',
        );

        mocks.sendMessage.mockResolvedValueOnce(undefined);
        await expect(requestDebugLogStatus()).rejects.toThrow(
            'Debug log reply was invalid.',
        );
    });

    it('times out a lost status reply after the request bound', async () => {
        mocks.sendMessage.mockImplementation(neverReplies);
        const request = requestDebugLogStatus();
        void request.catch(() => undefined);

        await vi.advanceTimersByTimeAsync(
            OPTIONS_DIAGNOSTICS_REQUEST_TIMEOUT_MS,
        );
        await expect(request).rejects.toThrow(
            'Options runtime request timed out.',
        );
    });

    it('returns the preview tail with its revision', async () => {
        mocks.sendMessage.mockResolvedValue({
            ok: true,
            text: 'line-1\nline-2\n',
            shownBytes: 14,
            totalBytes: 14,
            revision: 7,
        });

        await expect(requestDebugLogPreview()).resolves.toEqual({
            text: 'line-1\nline-2\n',
            shownBytes: 14,
            totalBytes: 14,
            revision: 7,
        });
        expect(mocks.sendMessage).toHaveBeenCalledWith({
            type: TOPSKIP_MESSAGE.GET_DEBUG_LOG_PREVIEW,
        });
    });

    it('returns the bundle text and snapshot instant', async () => {
        mocks.sendMessage.mockResolvedValue({
            ok: true,
            text: '# TopSkip debug log\n',
            exportedAtMs: 1_755_856_900_000,
        });

        await expect(requestDebugLogBundle()).resolves.toEqual({
            text: '# TopSkip debug log\n',
            exportedAtMs: 1_755_856_900_000,
        });
        expect(mocks.sendMessage).toHaveBeenCalledWith({
            type: TOPSKIP_MESSAGE.GET_DEBUG_LOG_BUNDLE,
        });
    });

    it('bounds the bundle read by the shorter export timeout', async () => {
        mocks.sendMessage.mockImplementation(neverReplies);
        let settled = false;
        const request = requestDebugLogBundle();
        void request.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );

        await vi.advanceTimersByTimeAsync(
            OPTIONS_DIAGNOSTICS_BUNDLE_TIMEOUT_MS - 1,
        );
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await expect(request).rejects.toThrow(
            'Options runtime request timed out.',
        );
    });

    it('sends the switch state and returns the authoritative status', async () => {
        mocks.sendMessage.mockResolvedValue({
            ok: true,
            status: { ...STATUS, enabled: false, disabledAtMs: 1_755_857_000_000 },
        });

        const status = await requestSetDebugLogging(false);
        expect(status.enabled).toBe(false);
        expect(mocks.sendMessage).toHaveBeenCalledWith({
            type: TOPSKIP_MESSAGE.SET_DEBUG_LOGGING,
            enabled: false,
        });
    });
});
