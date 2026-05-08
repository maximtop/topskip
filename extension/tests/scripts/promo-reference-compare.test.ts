import { describe, expect, it } from 'vitest';

import {
    compareHumanAlignedBlocks,
    intervalIoU,
    parseReferenceBundleJson,
} from '../../scripts/lib/promo-reference-compare';

describe('intervalIoU', () => {
    it('is 1 for identical intervals', () => {
        expect(intervalIoU(0, 10, 0, 10)).toBe(1);
    });

    it('is 0 for disjoint intervals', () => {
        expect(intervalIoU(0, 1, 2, 3)).toBe(0);
    });

    it('matches partial overlap', () => {
        const iou = intervalIoU(0, 10, 5, 15);
        expect(iou).toBeCloseTo(5 / 15, 5);
    });
});

describe('compareHumanAlignedBlocks', () => {
    it('reports start delta and assumes human end when pred end missing', () => {
        const human = [
            { id: 'first', startSec: 242.12, endSec: 329.44 },
            { id: 'second', startSec: 826.56, endSec: 943.519 },
        ];
        const pred = [{ startSec: 268 }, { startSec: 826, endSec: 945 }];
        const m = compareHumanAlignedBlocks(human, pred);
        expect(m).toHaveLength(2);
        expect(m[0].startDeltaSec).toBeCloseTo(268 - 242.12, 5);
        expect(m[0].predEndAssumed).toBe(true);
        expect(m[0].predEndSec).toBe(329.44);
    });
});

describe('parseReferenceBundleJson', () => {
    it('parses fixture-shaped JSON', () => {
        const j = JSON.stringify({
            videoId: 'v',
            humanBlocks: [{ id: 'a', startSec: 1, endSec: 2 }],
            firstRunModel: {
                model: 'm',
                blocks: [{ startSec: 1.5, endSec: 2.5 }],
            },
        });
        const b = parseReferenceBundleJson(j);
        expect(b.humanBlocks).toHaveLength(1);
        expect(b.firstRunModel?.model).toBe('m');
    });
});
