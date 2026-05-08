import { describe, expect, it } from 'vitest';

import { sortAndDedupePromoBlocks } from '@/shared/promo-dedupe';

describe('sortAndDedupePromoBlocks', () => {
    it('sorts by startSec', () => {
        const r = sortAndDedupePromoBlocks([
            { startSec: 10, endSec: 12 },
            { startSec: 2, endSec: 4 },
        ]);
        expect(r[0]?.startSec).toBe(2);
        expect(r[1]?.startSec).toBe(10);
    });

    it('merges overlapping blocks', () => {
        const r = sortAndDedupePromoBlocks([
            { startSec: 0, endSec: 5 },
            { startSec: 4, endSec: 8 },
        ]);
        expect(r).toHaveLength(1);
        expect(r[0]?.startSec).toBe(0);
        expect(r[0]?.endSec).toBe(8);
    });
});
