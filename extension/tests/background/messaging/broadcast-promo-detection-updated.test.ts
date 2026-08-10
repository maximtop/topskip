import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    TOPSKIP_MESSAGE,
    type PromoDetectionStatePayload,
} from '@/shared/messages';

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

import { PromoDetectionBroadcast } from '@/background/messaging/broadcast-promo-detection-updated';

describe('PromoDetectionBroadcast', () => {
    beforeEach(() => {
        mocks.sendMessage.mockReset();
        mocks.sendMessage.mockResolvedValue(undefined);
    });

    it('keeps two tab updates distinguishable in the global runtime channel', () => {
        const first = {
            videoId: 'firstVideo',
            status: 'no_promo',
        } satisfies PromoDetectionStatePayload;
        const second = {
            videoId: 'secondVideo',
            status: 'detected',
            promoBlocks: [{ startSec: 12, endSec: 18 }],
        } satisfies PromoDetectionStatePayload;

        PromoDetectionBroadcast.notify(41, first);
        PromoDetectionBroadcast.notify(82, second);

        expect(mocks.sendMessage.mock.calls).toEqual([
            [
                {
                    type: TOPSKIP_MESSAGE.PROMO_DETECTION_UPDATED,
                    tabId: 41,
                    payload: first,
                },
            ],
            [
                {
                    type: TOPSKIP_MESSAGE.PROMO_DETECTION_UPDATED,
                    tabId: 82,
                    payload: second,
                },
            ],
        ]);
    });

    it('keeps a tab-scoped reset when popup is closed', async () => {
        mocks.sendMessage.mockRejectedValue(new Error('no receiver'));

        expect(() => {
            PromoDetectionBroadcast.notify(41, null);
        }).not.toThrow();
        await Promise.resolve();

        expect(mocks.sendMessage).toHaveBeenCalledWith({
            type: TOPSKIP_MESSAGE.PROMO_DETECTION_UPDATED,
            tabId: 41,
            payload: null,
        });
    });
});
