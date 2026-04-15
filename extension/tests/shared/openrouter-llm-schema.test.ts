import { describe, expect, it } from 'vitest';
import { parse } from 'valibot';

import { llmPromoDetectionSchema } from '@/shared/openrouter-llm-schema';

describe('llmPromoDetectionSchema', () => {
  it('accepts hasPromo true with non-empty promoBlocks', () => {
    const out = parse(llmPromoDetectionSchema, {
      hasPromo: true,
      promoBlocks: [{ startSec: 1, endSec: 2, confidence: 'low' }],
    });
    expect(out.hasPromo).toBe(true);
    if (out.hasPromo) {
      expect(out.promoBlocks).toHaveLength(1);
    }
  });

  it('rejects hasPromo true with empty promoBlocks', () => {
    expect(() =>
      parse(llmPromoDetectionSchema, { hasPromo: true, promoBlocks: [] }),
    ).toThrow();
  });

  it('accepts hasPromo false', () => {
    const out = parse(llmPromoDetectionSchema, {
      hasPromo: false,
      confidence: 'low',
    });
    expect(out.hasPromo).toBe(false);
  });
});
