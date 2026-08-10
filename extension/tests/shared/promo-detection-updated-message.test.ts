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
    });
});
