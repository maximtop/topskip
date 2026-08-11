import { describe, expect, it } from 'vitest';

import {
    areDefaultedValuesEqual,
    areOptionalOrderedValuesEqual,
    normalizeOptionalValue,
} from '@/background/lifecycle/registration-value-comparison';

describe('registration value comparison', () => {
    it('applies defaults only to omitted values', () => {
        expect(normalizeOptionalValue(undefined, false)).toBe(false);
        expect(normalizeOptionalValue(true, false)).toBe(true);
        expect(normalizeOptionalValue(null, false)).toBeNull();
    });

    it('treats omitted and explicit browser defaults as equivalent', () => {
        expect(areDefaultedValuesEqual(undefined, false, false)).toBe(true);
        expect(areDefaultedValuesEqual(true, undefined, false)).toBe(false);
        expect(
            areDefaultedValuesEqual(undefined, 'ISOLATED', 'ISOLATED'),
        ).toBe(true);
    });

    it('normalizes omitted lists without discarding declaration order', () => {
        expect(areOptionalOrderedValuesEqual(undefined, [])).toBe(true);
        expect(
            areOptionalOrderedValuesEqual(
                ['caption-page-bridge.js', 'content.js'],
                ['caption-page-bridge.js', 'content.js'],
            ),
        ).toBe(true);
        expect(
            areOptionalOrderedValuesEqual(
                ['caption-page-bridge.js', 'content.js'],
                ['content.js', 'caption-page-bridge.js'],
            ),
        ).toBe(false);
    });

    it('compares generic ordered values by identity', () => {
        const shared = { id: 'content' };

        expect(areOptionalOrderedValuesEqual([shared], [shared])).toBe(true);
        expect(
            areOptionalOrderedValuesEqual(
                [{ id: 'content' }],
                [{ id: 'content' }],
            ),
        ).toBe(false);
    });
});
