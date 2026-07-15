# Issue 1 — Adapter interface + registry + OpenRouter adapter wrap

**Type**: Architecture / Foundation
**Priority**: P1
**Blocked by**: —
**Status**: Validated
**User Stories**: US-5, US-6
**Success Criteria**: SC-005, SC-007

## Goal

Define the `LlmProviderAdapter` interface, `ProviderRegistry`, and `OpenRouterAdapter` — a thin wrapper around the existing `callOpenRouterChat()` + `parseLlmPromoResponse()`. After this issue the pipeline still calls OpenRouter directly; the types and wiring are in place for later issues to swap in.

## Scope

### New files

| File | Purpose |
|------|---------|
| `src/background/providers/llm-provider-adapter.ts` | `LlmProviderAdapter` interface + shared types (`AnalyzeTranscriptParams`, `AnalyzeTranscriptResult`, `ProviderAvailability`) |
| `src/background/providers/provider-registry.ts` | `ProviderRegistry` class — static `Map<string, LlmProviderAdapter>`, `get(id)`, `getAll()` |
| `src/background/providers/openrouter-adapter.ts` | `OpenRouterAdapter implements LlmProviderAdapter` — delegates to `callOpenRouterChat()` + `parseLlmPromoResponse()` |
| `tests/background/providers/provider-registry.test.ts` | Registry lookup, unknown ID returns `undefined`, enumeration |
| `tests/background/providers/openrouter-adapter.test.ts` | `analyzeTranscript` delegates correctly, `availability()` reflects config state |

### Existing files — no changes

`PromoAnalysis`, storage, messaging, and UI remain untouched. The adapter is wired in issue 3.

## Interface sketch

```ts
type ProviderAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable';

interface AnalyzeTranscriptParams {
  transcript: string;
  videoId: string;
  durationSec: number;
  signal?: AbortSignal;
}

type AnalyzeTranscriptResult =
  | { ok: true; detection: LlmPromoDetection; providerMeta: { id: string; model: string } }
  | { ok: false; error: string };

interface LlmProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  availability(): Promise<ProviderAvailability>;
  analyzeTranscript(params: AnalyzeTranscriptParams): Promise<AnalyzeTranscriptResult>;
}
```

## Acceptance criteria

- [x] `LlmProviderAdapter` interface and supporting types are defined
- [x] `ProviderRegistry.get('openrouter')` returns the `OpenRouterAdapter`
- [x] `ProviderRegistry.get('unknown')` returns `undefined`
- [x] `ProviderRegistry.getAll()` returns all registered adapters
- [x] `OpenRouterAdapter.analyzeTranscript()` delegates to `callOpenRouterChat` with correct args
- [x] `OpenRouterAdapter.availability()` returns `available` when API key + model present, `unavailable` otherwise
- [x] Existing unit tests and E2E tests pass without modification
- [x] `pnpm run lint` passes

## Testing

- Unit tests for `ProviderRegistry` (lookup, enumeration)
- Unit tests for `OpenRouterAdapter` with mocked `callOpenRouterChat` and `OpenRouterStorage.load`
- No E2E changes needed
