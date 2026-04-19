import { describe, expect, it } from 'vitest';

import { isValidOpenRouterModelSlug } from '@/shared/openrouter-model-presets';

describe('openrouter-model-presets', () => {
  describe('isValidOpenRouterModelSlug', () => {
    it('rejects slugs not matching owner/model format', () => {
      expect(isValidOpenRouterModelSlug('test')).toBe(false);
      expect(isValidOpenRouterModelSlug('')).toBe(false);
      expect(isValidOpenRouterModelSlug('/')).toBe(false);
      expect(isValidOpenRouterModelSlug('a/')).toBe(false);
      expect(isValidOpenRouterModelSlug('/b')).toBe(false);
      expect(isValidOpenRouterModelSlug('a/b/c')).toBe(false);
      expect(isValidOpenRouterModelSlug('a b/c-d')).toBe(false);
    });

    it('accepts valid owner/model slugs', () => {
      expect(isValidOpenRouterModelSlug('google/gemini-2.5-flash')).toBe(true);
      expect(isValidOpenRouterModelSlug('openai/gpt-4o')).toBe(true);
      expect(isValidOpenRouterModelSlug('meta-llama/llama-3-8b')).toBe(true);
      expect(isValidOpenRouterModelSlug('org_name/model-name_1')).toBe(true);
    });
  });
});
