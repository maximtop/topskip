import { describe, expect, it } from 'vitest';

import {
    parseLlmPromoResponse,
    refinePromoBlocks,
} from '@/background/openrouter/parse-llm-promo-response';

describe('refinePromoBlocks', () => {
    it('rejects a negative startSec', () => {
        const r = refinePromoBlocks([{ startSec: -1, endSec: 10 }], undefined);
        expect(r).toEqual({
            ok: false,
            error: 'Invalid startSec in promoBlocks',
        });
    });

    it('rejects a non-finite startSec', () => {
        const r = refinePromoBlocks(
            [{ startSec: Number.NaN, endSec: 10 }],
            undefined,
        );
        expect(r).toEqual({
            ok: false,
            error: 'Invalid startSec in promoBlocks',
        });
    });

    it('rejects endSec equal to startSec (zero-length block)', () => {
        const r = refinePromoBlocks([{ startSec: 5, endSec: 5 }], undefined);
        expect(r).toEqual({
            ok: false,
            error: 'Invalid endSec in promoBlocks',
        });
    });

    it('rejects endSec before startSec (inverted block)', () => {
        const r = refinePromoBlocks([{ startSec: 10, endSec: 5 }], undefined);
        expect(r).toEqual({
            ok: false,
            error: 'Invalid endSec in promoBlocks',
        });
    });

    it('rejects a non-finite endSec', () => {
        const r = refinePromoBlocks(
            [{ startSec: 5, endSec: Number.POSITIVE_INFINITY }],
            undefined,
        );
        expect(r).toEqual({
            ok: false,
            error: 'Invalid endSec in promoBlocks',
        });
    });

    it('keeps an open-ended block unmodified when duration is unknown', () => {
        const r = refinePromoBlocks([{ startSec: 5 }], undefined);
        expect(r).toEqual({ ok: true, blocks: [{ startSec: 5 }] });
    });

    it('drops a block that starts at or after the known duration', () => {
        const r = refinePromoBlocks(
            [
                { startSec: 5, endSec: 10 },
                { startSec: 120, endSec: 130 },
            ],
            120,
        );
        expect(r).toEqual({ ok: true, blocks: [{ startSec: 5, endSec: 10 }] });
    });

    it('clamps endSec to the known duration instead of dropping the block', () => {
        const r = refinePromoBlocks([{ startSec: 100, endSec: 200 }], 120);
        expect(r).toEqual({
            ok: true,
            blocks: [{ startSec: 100, endSec: 120 }],
        });
    });

    it('does not clamp or drop when durationSec is non-finite', () => {
        const r = refinePromoBlocks(
            [{ startSec: 100, endSec: 200 }],
            Number.NaN,
        );
        expect(r).toEqual({
            ok: true,
            blocks: [{ startSec: 100, endSec: 200 }],
        });
    });

    it('sorts and merges overlapping blocks via sortAndDedupePromoBlocks', () => {
        const r = refinePromoBlocks(
            [
                { startSec: 20, endSec: 30 },
                { startSec: 5, endSec: 22 },
            ],
            undefined,
        );
        expect(r).toEqual({
            ok: true,
            blocks: [{ startSec: 5, endSec: 30 }],
        });
    });
});

describe('parseLlmPromoResponse', () => {
    it('parses plain JSON', () => {
        const r = parseLlmPromoResponse(
            JSON.stringify({
                hasPromo: true,
                promoBlocks: [{ startSec: 1, endSec: 2 }],
            }),
            undefined,
        );
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.hasPromo).toBe(true);
            if (r.hasPromo) {
                expect(r.blocks).toHaveLength(1);
                expect(r.blocks[0]?.startSec).toBe(1);
            }
        }
    });

    it('parses fenced JSON', () => {
        const r = parseLlmPromoResponse(
            '```json\n{"hasPromo":false}\n```',
            undefined,
        );
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.hasPromo).toBe(false);
        }
    });

    it('rejects invalid JSON', () => {
        const r = parseLlmPromoResponse('not json', undefined);
        expect(r.ok).toBe(false);
    });

    it('surfaces a refinePromoBlocks rejection through the top-level result', () => {
        const r = parseLlmPromoResponse(
            JSON.stringify({
                hasPromo: true,
                promoBlocks: [{ startSec: 10, endSec: 5 }],
            }),
            undefined,
        );
        expect(r).toEqual({
            ok: false,
            error: 'Invalid endSec in promoBlocks',
        });
    });

    it('drops an out-of-range block through the full pipeline when duration is known', () => {
        const r = parseLlmPromoResponse(
            JSON.stringify({
                hasPromo: true,
                promoBlocks: [
                    { startSec: 5, endSec: 10 },
                    { startSec: 200, endSec: 210 },
                ],
            }),
            120,
        );
        expect(r).toEqual({
            ok: true,
            hasPromo: true,
            blocks: [{ startSec: 5, endSec: 10 }],
        });
    });
});
