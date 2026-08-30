import { describe, expect, it } from 'vitest';

import {
    computePromoBlockTargetTime,
    evaluatePromoBlocksSkip,
    explainSuppressedPromoSkip,
    PROMO_SKIP_SUPPRESSION_REASON,
    resetFiredIndicesOnBackwardSeek,
    type PromoBlocksSkipInput,
} from '@/content/promo-skip-logic';
import type { PromoBlock } from '@topskip/common/promo-types';

describe('computePromoBlockTargetTime', () => {
    it('uses endSec when valid', () => {
        expect(
            computePromoBlockTargetTime({ startSec: 1, endSec: 10 }, 100),
        ).toBe(10);
    });

    it('uses start + 30 when endSec missing', () => {
        expect(computePromoBlockTargetTime({ startSec: 5 }, 100)).toBe(35);
    });

    it('clamps to duration', () => {
        expect(
            computePromoBlockTargetTime({ startSec: 1, endSec: 999 }, 50),
        ).toBe(50);
    });

    it('falls back to start + 30 when endSec equals startSec (FR-012)', () => {
        expect(
            computePromoBlockTargetTime({ startSec: 100, endSec: 100 }, 200),
        ).toBe(130);
    });

    it('falls back to start + 30 when endSec < startSec (FR-012)', () => {
        expect(
            computePromoBlockTargetTime({ startSec: 100, endSec: 50 }, 200),
        ).toBe(130);
    });
});

describe('evaluatePromoBlocksSkip', () => {
    it('skips when crossing start naturally', () => {
        const d = evaluatePromoBlocksSkip({
            prevTime: 9,
            currentTime: 11,
            duration: 120,
            isSeeking: false,
            firedStartKeys: new Set(),
            blocks: [{ startSec: 10, endSec: 20 }],
        });
        expect(d).toEqual({
            action: 'skip',
            blockIndex: 0,
            targetTime: 20,
        });
    });

    it('does not refire fired index', () => {
        const d = evaluatePromoBlocksSkip({
            prevTime: 9,
            currentTime: 11,
            duration: 120,
            isSeeking: false,
            firedStartKeys: new Set([10]),
            blocks: [{ startSec: 10, endSec: 20 }],
        });
        expect(d.action).toBe('none');
    });

    it('suppresses when delta too large (seek)', () => {
        const d = evaluatePromoBlocksSkip({
            prevTime: 0,
            currentTime: 15,
            duration: 120,
            isSeeking: false,
            firedStartKeys: new Set(),
            blocks: [{ startSec: 10, endSec: 20 }],
        });
        expect(d.action).toBe('none');
    });
});

describe('resetFiredIndicesOnBackwardSeek', () => {
    it('removes fired index when currentTime is before block startSec', () => {
        const blocks = [
            { startSec: 10, endSec: 20 },
            { startSec: 50, endSec: 60 },
        ];
        const fired = new Set([10, 50]);
        resetFiredIndicesOnBackwardSeek({
            currentTime: 5,
            prevTime: 55,
            blocks,
            firedStartKeys: fired,
        });
        expect(fired.has(10)).toBe(false);
        expect(fired.has(50)).toBe(false);
    });

    it('keeps fired index when currentTime is still past block startSec', () => {
        const blocks = [
            { startSec: 10, endSec: 20 },
            { startSec: 50, endSec: 60 },
        ];
        const fired = new Set([10, 50]);
        resetFiredIndicesOnBackwardSeek({
            currentTime: 30,
            prevTime: 55,
            blocks,
            firedStartKeys: fired,
        });
        expect(fired.has(10)).toBe(true);
        expect(fired.has(50)).toBe(false);
    });

    it('is a no-op when currentTime >= prevTime (forward playback)', () => {
        const blocks = [{ startSec: 10, endSec: 20 }];
        const fired = new Set([10]);
        resetFiredIndicesOnBackwardSeek({
            currentTime: 25,
            prevTime: 20,
            blocks,
            firedStartKeys: fired,
        });
        expect(fired.has(10)).toBe(true);
    });

    it('is a no-op when firedStartKeys is empty', () => {
        const blocks = [{ startSec: 10, endSec: 20 }];
        const fired = new Set<number>();
        resetFiredIndicesOnBackwardSeek({
            currentTime: 5,
            prevTime: 25,
            blocks,
            firedStartKeys: fired,
        });
        expect(fired.size).toBe(0);
    });
});

describe('explainSuppressedPromoSkip', () => {
    const blocks = [{ startSec: 10, endSec: 20 }];
    const crossing: PromoBlocksSkipInput = {
        prevTime: 9,
        currentTime: 11,
        duration: 120,
        isSeeking: false,
        firedStartKeys: new Set<number>(),
        blocks,
    };

    it('returns null when no block is crossed or entered', () => {
        expect(
            explainSuppressedPromoSkip({ ...crossing, prevTime: 3, currentTime: 4 }),
        ).toBeNull();
        expect(
            explainSuppressedPromoSkip({ ...crossing, prevTime: 25, currentTime: 26 }),
        ).toBeNull();
    });

    it('returns null when evaluatePromoBlocksSkip would skip the block', () => {
        expect(evaluatePromoBlocksSkip(crossing).action).toBe('skip');
        expect(explainSuppressedPromoSkip(crossing)).toBeNull();
    });

    it('reports no-duration for a non-finite or zero duration', () => {
        expect(
            explainSuppressedPromoSkip({ ...crossing, duration: Number.NaN }),
        ).toEqual({
            blockIndex: 0,
            reason: PROMO_SKIP_SUPPRESSION_REASON.NoDuration,
        });
        expect(explainSuppressedPromoSkip({ ...crossing, duration: 0 })).toEqual({
            blockIndex: 0,
            reason: PROMO_SKIP_SUPPRESSION_REASON.NoDuration,
        });
    });

    it('reports seeking while the player scrubs through the block', () => {
        expect(
            explainSuppressedPromoSkip({ ...crossing, isSeeking: true }),
        ).toEqual({ blockIndex: 0, reason: PROMO_SKIP_SUPPRESSION_REASON.Seeking });
    });

    it('reports already-fired inside a block that skipped before', () => {
        expect(
            explainSuppressedPromoSkip({
                ...crossing,
                prevTime: 12,
                currentTime: 12.25,
                firedStartKeys: new Set([10]),
            }),
        ).toEqual({
            blockIndex: 0,
            reason: PROMO_SKIP_SUPPRESSION_REASON.AlreadyFired,
        });
    });

    it('reports not-crossed when playback is inside without crossing the start', () => {
        expect(
            explainSuppressedPromoSkip({ ...crossing, prevTime: 15, currentTime: 16 }),
        ).toEqual({
            blockIndex: 0,
            reason: PROMO_SKIP_SUPPRESSION_REASON.NotCrossed,
        });
    });

    it('reports seek-guard for a crossing larger than the playback delta', () => {
        expect(
            explainSuppressedPromoSkip({ ...crossing, prevTime: 5, currentTime: 12 }),
        ).toEqual({
            blockIndex: 0,
            reason: PROMO_SKIP_SUPPRESSION_REASON.SeekGuard,
        });
    });

    it('reports the first involved block and skips holes in the list', () => {
        const sparse: PromoBlock[] = [];
        sparse[1] = { startSec: 50, endSec: 60 };
        expect(
            explainSuppressedPromoSkip({
                ...crossing,
                prevTime: 49,
                currentTime: 55,
                firedStartKeys: new Set([50]),
                blocks: sparse,
            }),
        ).toEqual({
            blockIndex: 1,
            reason: PROMO_SKIP_SUPPRESSION_REASON.AlreadyFired,
        });
    });
});
