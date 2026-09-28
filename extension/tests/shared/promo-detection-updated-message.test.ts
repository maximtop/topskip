import { describe, expect, it } from 'vitest';

import {
    TOPSKIP_MESSAGE,
    pickMessage,
    type TopSkipRuntimeMessage,
} from '@/shared/messages';

describe('promo detection updated message', () => {
    it('preserves the source tab for two independent runtime pushes', () => {
        const first = {
            type: TOPSKIP_MESSAGE.PROMO_DETECTION_UPDATED,
            tabId: 41,
            payload: { videoId: 'firstVideo', status: 'no_promo' },
        } satisfies TopSkipRuntimeMessage;
        const second = {
            type: TOPSKIP_MESSAGE.PROMO_DETECTION_UPDATED,
            tabId: 82,
            payload: { videoId: 'secondVideo', status: 'no_promo' },
        } satisfies TopSkipRuntimeMessage;

        expect(
            pickMessage(TOPSKIP_MESSAGE.PROMO_DETECTION_UPDATED, first),
        ).toEqual(first);
        expect(
            pickMessage(TOPSKIP_MESSAGE.PROMO_DETECTION_UPDATED, second),
        ).toEqual(second);
        expect(first.tabId).not.toBe(second.tabId);
    });

    it('returns undefined when the message type does not match', () => {
        const other = {
            type: TOPSKIP_MESSAGE.GET_PREFS,
        } satisfies TopSkipRuntimeMessage;

        expect(
            pickMessage(TOPSKIP_MESSAGE.PROMO_DETECTION_UPDATED, other),
        ).toBeUndefined();
    });

    it('returns undefined for non-object and null input', () => {
        expect(
            pickMessage(TOPSKIP_MESSAGE.PROMO_DETECTION_UPDATED, null),
        ).toBeUndefined();
        expect(
            pickMessage(TOPSKIP_MESSAGE.PROMO_DETECTION_UPDATED, 'not-an-object'),
        ).toBeUndefined();
        expect(
            pickMessage(TOPSKIP_MESSAGE.PROMO_DETECTION_UPDATED, undefined),
        ).toBeUndefined();
    });
});
