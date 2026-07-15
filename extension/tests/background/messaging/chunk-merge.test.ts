import { describe, expect, it } from 'vitest';

import { ChunkMerge } from '@/background/messaging/chunk-merge';
import { BLOCK_MERGE_GAP_SEC } from '@/background/messaging/chunk-plan-config';
import type { PromoBlock } from '@topskip/common/promo-types';
import { mergePromoBlocksWithGap } from '@topskip/common/promo-dedupe';

describe('ChunkMerge.filterPromoBlocksForChunkTimeRange', () => {
    const blocks: PromoBlock[] = [
        { startSec: 2, endSec: 4, confidence: 'high' },
        { startSec: 100, endSec: 110, confidence: 'low' },
    ];

    it('keeps blocks whose start lies inside chunk ± tolerance', () => {
        const out = ChunkMerge.filterPromoBlocksForChunkTimeRange(
            blocks,
            0,
            10,
            5,
        );
        expect(out).toEqual([blocks[0]]);
    });

    it('drops blocks whose start is outside the window', () => {
        const out = ChunkMerge.filterPromoBlocksForChunkTimeRange(
            blocks,
            0,
            10,
            1,
        );
        expect(out).toEqual([blocks[0]]);
        const far = ChunkMerge.filterPromoBlocksForChunkTimeRange(
            [{ startSec: 50, endSec: 60, confidence: 'low' }],
            0,
            10,
            5,
        );
        expect(far).toHaveLength(0);
    });
});

describe('mergePromoBlocksWithGap', () => {
    const gap = BLOCK_MERGE_GAP_SEC;

    it('merges identical spans into one block', () => {
        const a: PromoBlock[] = [
            { startSec: 10, endSec: 20, confidence: 'medium' },
            { startSec: 10, endSec: 20, confidence: 'high' },
        ];
        const out = mergePromoBlocksWithGap(a, gap);
        expect(out).toHaveLength(1);
        expect(out[0]?.startSec).toBe(10);
        expect(out[0]?.endSec).toBe(20);
        expect(out[0]?.confidence).toBe('high');
    });

    it('keeps two blocks when gap exceeds the merge threshold', () => {
        const a: PromoBlock[] = [
            { startSec: 0, endSec: 10, confidence: 'low' },
            { startSec: 20, endSec: 30, confidence: 'low' },
        ];
        const out = mergePromoBlocksWithGap(a, gap);
        expect(out).toHaveLength(2);
    });

    it('merges a chain of overlaps into one span', () => {
        const a: PromoBlock[] = [
            { startSec: 0, endSec: 5, confidence: 'low' },
            { startSec: 4, endSec: 8, confidence: 'medium' },
            { startSec: 7, endSec: 12, confidence: 'high' },
        ];
        const out = mergePromoBlocksWithGap(a, gap);
        expect(out).toHaveLength(1);
        expect(out[0]?.startSec).toBe(0);
        expect(out[0]?.endSec).toBe(12);
        expect(out[0]?.confidence).toBe('high');
    });

    it('merges nested narrower block into the wider span', () => {
        const a: PromoBlock[] = [
            { startSec: 10, endSec: 100, confidence: 'medium' },
            { startSec: 40, endSec: 50, confidence: 'high' },
        ];
        const out = mergePromoBlocksWithGap(a, gap);
        expect(out).toHaveLength(1);
        expect(out[0]?.startSec).toBe(10);
        expect(out[0]?.endSec).toBe(100);
        expect(out[0]?.confidence).toBe('high');
    });

    it('merges blocks separated by a gap ≤ gapSec', () => {
        const a: PromoBlock[] = [
            { startSec: 0, endSec: 10, confidence: 'low' },
            { startSec: 12, endSec: 20, confidence: 'high' },
        ];
        const out = mergePromoBlocksWithGap(a, gap);
        expect(out).toHaveLength(1);
        expect(out[0]?.endSec).toBe(20);
    });
});
