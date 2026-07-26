import { describe, expect, it } from 'vitest';

import {
    estimateCostFromUsageAndPricing,
    parsePricingNumber,
    rankCompareSummaryRows,
    summarizeVsHumanMetrics,
} from '../../../scripts/lib/openrouter-compare-summary';

describe('parsePricingNumber', () => {
    it('parses numeric strings and drops negative sentinels', () => {
        expect(parsePricingNumber('0.0000025')).toBe(0.0000025);
        expect(parsePricingNumber(-1)).toBeUndefined();
        expect(parsePricingNumber('nope')).toBeUndefined();
    });
});

describe('estimateCostFromUsageAndPricing', () => {
    it('matches the GPT-5.4 prompt+completion example', () => {
        const estimated = estimateCostFromUsageAndPricing(
            {
                promptTokens: 14523,
                completionTokens: 71,
                totalTokens: 14594,
            },
            {
                prompt: 0.0000025,
                completion: 0.000015,
            },
        );

        expect(estimated?.totalUsd).toBeCloseTo(0.0373725, 8);
    });
});

describe('summarizeVsHumanMetrics', () => {
    it('aggregates IoU and boundary deltas', () => {
        const summary = summarizeVsHumanMetrics([
            {
                id: 'first',
                humanStartSec: 0,
                humanEndSec: 10,
                predStartSec: 1,
                predEndSec: 11,
                predEndAssumed: false,
                startDeltaSec: 1,
                endDeltaSec: 1,
                iouWithHuman: 0.8,
            },
            {
                id: 'second',
                humanStartSec: 20,
                humanEndSec: 30,
                predStartSec: 18,
                predEndSec: 31,
                predEndAssumed: false,
                startDeltaSec: -2,
                endDeltaSec: 1,
                iouWithHuman: 0.7,
            },
        ]);

        expect(summary?.matchedBlocks).toBe(2);
        expect(summary?.meanIoU).toBeCloseTo(0.75, 8);
        expect(summary?.meanAbsStartDeltaSec).toBeCloseTo(1.5, 8);
        expect(summary?.meanAbsEndDeltaSec).toBeCloseTo(1, 8);
        expect(summary?.maxAbsStartDeltaSec).toBe(2);
        expect(summary?.maxAbsEndDeltaSec).toBe(1);
    });
});

describe('rankCompareSummaryRows', () => {
    it('prefers higher IoU, then smaller boundary errors', () => {
        const ranked = rankCompareSummaryRows([
            {
                model: 'fast-cheap',
                ms: 1000,
                reportedCost: 0.01,
                vsHuman: [
                    {
                        id: 'first',
                        humanStartSec: 0,
                        humanEndSec: 10,
                        predStartSec: 3,
                        predEndSec: 11,
                        predEndAssumed: false,
                        startDeltaSec: 3,
                        endDeltaSec: 1,
                        iouWithHuman: 0.6,
                    },
                ],
            },
            {
                model: 'closer-to-human',
                ms: 2000,
                reportedCost: 0.03,
                vsHuman: [
                    {
                        id: 'first',
                        humanStartSec: 0,
                        humanEndSec: 10,
                        predStartSec: 0.5,
                        predEndSec: 10.5,
                        predEndAssumed: false,
                        startDeltaSec: 0.5,
                        endDeltaSec: 0.5,
                        iouWithHuman: 0.9,
                    },
                ],
            },
        ]);

        expect(ranked.map((row) => row.model)).toEqual([
            'closer-to-human',
            'fast-cheap',
        ]);
    });
});
