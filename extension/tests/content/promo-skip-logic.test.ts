import { describe, expect, it } from 'vitest';

import {
  computePromoBlockTargetTime,
  evaluatePromoBlocksSkip,
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
});

describe('evaluatePromoBlocksSkip', () => {
  it('skips when crossing start naturally', () => {
    const d = evaluatePromoBlocksSkip({
      prevTime: 9,
      currentTime: 11,
      duration: 120,
      isSeeking: false,
      firedIndices: new Set(),
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
      firedIndices: new Set([0]),
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
      firedIndices: new Set(),
      blocks: [{ startSec: 10, endSec: 20 }],
    });
    expect(d.action).toBe('none');
  });
});
