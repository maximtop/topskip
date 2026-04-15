import { describe, expect, it } from 'vitest';

import {
  parseLlmPromoResponse,
} from '@/background/openrouter/parse-llm-promo-response';

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
});
