import { describe, expect, it } from 'vitest';

import {
    computePromoBlockTargetTime,
    evaluatePromoBlocksSkip,
    resetFiredIndicesOnBackwardSeek,
} from '@/content/promo-skip-logic';

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
