import { describe, expect, it } from 'vitest';

import {
  PROVIDER_AVAILABILITY,
  PROVIDER_ID,
  type AnalyzeTranscriptParams,
  type AnalyzeTranscriptResult,
  type LlmProviderAdapter,
  type ProviderId,
  type ProviderAvailability,
} from '@/background/providers/llm-provider-adapter';
import { ProviderRegistry } from '@/background/providers/provider-registry';

/**
 * Minimal stub that satisfies the adapter interface for registry tests.
 *
 * @param id - Provider identifier.
 * @param displayName - User-facing label.
 * @returns A stub adapter.
 */
function stubAdapter(
  id: ProviderId,
  displayName: string,
): LlmProviderAdapter {
  return {
    id,
    displayName,
    availability(): Promise<ProviderAvailability> {
      return Promise.resolve(PROVIDER_AVAILABILITY.Available);
    },
    analyzeTranscript(
      _params: AnalyzeTranscriptParams,
    ): Promise<AnalyzeTranscriptResult> {
      return Promise.resolve({
        ok: true,
        hasPromo: false,
        providerMeta: { id, model: 'stub' },
      });
    },
  };
}

describe('ProviderRegistry', () => {
  it('get returns a registered adapter', () => {
    const adapter = stubAdapter(PROVIDER_ID.OpenRouter, 'Test');
    const registry = new ProviderRegistry([adapter]);
    expect(registry.get(PROVIDER_ID.OpenRouter)).toBe(adapter);
  });

  it('get returns undefined for an unknown id', () => {
    const registry = new ProviderRegistry([]);
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('getAll returns all registered adapters', () => {
    const a = stubAdapter(PROVIDER_ID.OpenRouter, 'A');
    const registry = new ProviderRegistry([a]);
    expect(registry.getAll()).toEqual([a]);
  });

  it('getAll returns an empty array when no adapters are registered', () => {
    const registry = new ProviderRegistry([]);
    expect(registry.getAll()).toEqual([]);
  });

  it('last adapter wins when duplicate ids are registered', () => {
    const first = stubAdapter(PROVIDER_ID.OpenRouter, 'First');
    const second = stubAdapter(PROVIDER_ID.OpenRouter, 'Second');
    const registry = new ProviderRegistry([first, second]);
    expect(registry.get(PROVIDER_ID.OpenRouter)).toBe(second);
  });
});
