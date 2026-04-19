# Issue 6 — Chrome Prompt API adapter

**Type**: Feature / Backend
**Priority**: P1
**Status**: Validated
**Blocked by**: Issues 1, 3
**User Stories**: US-1, US-6
**Success Criteria**: SC-001, SC-004, SC-008

## Goal

Implement `ChromePromptApiAdapter` — the concrete adapter wrapping Chrome's `LanguageModel` API for free on-device promo detection.

## Scope

### New files

| File | Purpose |
|------|---------|
| `src/background/providers/chrome-prompt-api-adapter.ts` | `ChromePromptApiAdapter implements LlmProviderAdapter` |
| `src/background/providers/chrome-prompt-api-types.ts` | TypeScript declarations for `LanguageModel` API surface (Chrome 138+, not yet in standard lib types) |
| `tests/background/providers/chrome-prompt-api-adapter.test.ts` | Unit tests with fully mocked `LanguageModel` |

### Modified files

| File | Change |
|------|--------|
| `src/background/providers/provider-registry.ts` | Register `ChromePromptApiAdapter` alongside `OpenRouterAdapter` |

## Adapter behavior

### `availability()`

1. Check if `globalThis.LanguageModel` exists → if not, return `'unavailable'`.
2. Call `LanguageModel.availability()` → map `'available'` / `'downloadable'` / `'downloading'` / `'unavailable'` directly to `ProviderAvailability`.

### `analyzeTranscript(params)`

1. Call `LanguageModel.create({ systemPrompt, signal })` → get `session`.
2. Read `session.contextWindow` — estimate token budget as `contextWindow - systemPromptTokenEstimate - responseTokenReserve`.
3. If transcript exceeds budget (chars ÷ 4 heuristic), truncate from the **start** (keep most recent captions) and log warning.
4. Call `session.prompt(truncatedTranscript, { responseConstraint, signal })`.
   - `responseConstraint` is the JSON Schema matching `LlmPromoDetection`.
5. Parse response via existing `parseLlmPromoResponse()`.
6. Destroy session.
7. Return `{ ok: true, detection, providerMeta: { id: 'chrome-prompt-api', model: 'gemini-nano' } }`.
8. On error: return `{ ok: false, error: message }`.

### `displayName`

`"Chrome Built-in"`.

## Acceptance criteria

- [x] `ChromePromptApiAdapter` is registered in `ProviderRegistry`
- [x] `availability()` correctly maps all four Chrome states
- [x] `availability()` returns `'unavailable'` when `LanguageModel` is not in global scope
- [x] `analyzeTranscript()` creates a session, sends prompt, and returns parsed result
- [x] Transcript truncation fires when content exceeds `session.contextWindow` budget
- [x] Truncation removes from the start (oldest captions)
- [x] `responseConstraint` JSON Schema is included in `prompt()` call
- [x] Session is destroyed after each analysis
- [x] AbortSignal is forwarded to both `create()` and `prompt()`
- [x] `pnpm run lint` passes

## Testing

- Unit: `availability()` with mocked `LanguageModel.availability()` returning each of the four states
- Unit: `availability()` when `LanguageModel` is undefined → `'unavailable'`
- Unit: `analyzeTranscript()` happy path — creates session, prompts, parses, destroys
- Unit: transcript truncation — long transcript is trimmed from start, log warning emitted
- Unit: abort signal forwarded — `session.prompt()` receives the signal
- Unit: `analyzeTranscript()` error path — `session.prompt()` throws → `{ ok: false }`

## Open questions (from PRD)

- Does `responseConstraint` reliably produce valid JSON for our schema? Prototype during implementation; fall back to raw parse if needed.
- Exact context window size — read dynamically from `session.contextWindow`, do not hardcode.
