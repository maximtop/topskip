import { describe, expect, it } from 'vitest';

import {
    formatPromoBlocksSummary,
    formatSecondsAsTimecode,
} from '@/shared/promo-range-format';

describe('formatSecondsAsTimecode', () => {
    it('formats under one hour as m:ss', () => {
        expect(formatSecondsAsTimecode(45)).toBe('0:45');
        expect(formatSecondsAsTimecode(125)).toBe('2:05');
    });

    it('formats one hour or more as h:mm:ss', () => {
        expect(formatSecondsAsTimecode(3600)).toBe('1:00:00');
        expect(formatSecondsAsTimecode(3725)).toBe('1:02:05');
    });
});

describe('formatPromoBlocksSummary', () => {
    it('joins multiple blocks with end times', () => {
        const s = formatPromoBlocksSummary([
            { startSec: 45, endSec: 120 },
            { startSec: 300, endSec: 360 },
        ]);
        expect(s).toContain('0:45');
        expect(s).toContain('2:00');
        expect(s).toContain(';');
    });

    it('uses default tail when endSec missing', () => {
        const s = formatPromoBlocksSummary([{ startSec: 10 }]);
        expect(s).toContain('0:10');
        expect(s).toContain('~');
    });
});
