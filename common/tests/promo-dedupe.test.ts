import { describe, expect, it } from 'vitest';

import { sortAndDedupePromoBlocks } from '@topskip/common/promo-dedupe';

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

    it('returns an empty array for no blocks', () => {
        expect(sortAndDedupePromoBlocks([])).toEqual([]);
    });

    it('chain-merges three overlapping blocks into one span', () => {
        const r = sortAndDedupePromoBlocks([
            { startSec: 20, endSec: 30 },
            { startSec: 0, endSec: 12 },
            { startSec: 10, endSec: 22 },
        ]);
        expect(r).toEqual([{ startSec: 0, endSec: 30 }]);
    });

    it('does not merge adjacent blocks that only touch at the boundary', () => {
        const r = sortAndDedupePromoBlocks([
            { startSec: 0, endSec: 5 },
            { startSec: 5, endSec: 10 },
        ]);
        expect(r).toEqual([
            { startSec: 0, endSec: 5 },
            { startSec: 5, endSec: 10 },
        ]);
    });

    // BUG: unlike its sibling `mergePromoBlocksWithGap` (which sets
    // `last.confidence = maxConfidence(...)`), the merge branch here only
    // ever updates `endSec` and keeps the earliest-starting block's own
    // confidence — so a later, higher-confidence overlapping block silently
    // loses its confidence label on merge. Reachable from the extension's
    // Private BYOK path (parse-llm-promo-response.ts -> refinePromoBlocks),
    // which calls this function directly on a single un-chunked LLM response
    // with no prior gap-merge pass. Flips to green once the merge branch
    // also does `last.confidence = maxConfidence(last.confidence, b.confidence)`.
    it.fails(
        'keeps the higher confidence when merging overlapping blocks',
        () => {
            const r = sortAndDedupePromoBlocks([
                { startSec: 0, endSec: 10, confidence: 'low' },
                { startSec: 5, endSec: 20, confidence: 'high' },
            ]);
            expect(r).toEqual([
                { startSec: 0, endSec: 20, confidence: 'high' },
            ]);
        },
    );
});
