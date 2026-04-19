# Issue 3 — Wire `PromoAnalysis` pipeline to resolve adapter from registry

**Type**: Architecture / Pipeline
**Priority**: P1
**Blocked by**: Issues 1, 2
**Status**: Validated
**User Stories**: US-3, US-5, US-6, US-8
**Success Criteria**: SC-004, SC-005, SC-007

## Goal

Refactor `PromoAnalysis.run()` to resolve the active adapter via `ProviderRegistry.get(providerId)` instead of directly calling `callOpenRouterChat()`. The log bundle receives provider metadata. In-flight abort on provider change is wired.

## Scope

### Modified files

| File | Change |
|------|--------|
| `src/background/messaging/promo-analysis.ts` | Replace direct `callOpenRouterChat` + `OpenRouterStorage.load()` + `parseLlmPromoResponse()` calls with `registry.get(providerId).analyzeTranscript(...)`. Read `providerId` from prefs (issue 2). Abort in-flight if provider changes. Pass provider metadata into log bundle. |
| `src/background/messaging/register-runtime-messages.ts` | If `SET_ACTIVE_PROVIDER` arrives while analysis is in-flight, call `PromoAnalysis.abortForTab(tabId)`. (Message type itself is added in issue 4; the abort-on-change logic lives here.) |
| `src/background/providers/openrouter-adapter.ts` | Ensure `analyzeTranscript` constructs the prompt from the `transcript` param using the existing `buildSystemPrompt` + user-message pattern. |
| Log bundle types | Add `providerId` and `providerModel` fields to the log output. |
| `tests/background/messaging/promo-analysis.test.ts` | New test file: pipeline routing with mock adapters. |

### Deleted code

- Direct imports of `callOpenRouterChat`, `OpenRouterStorage`, `parseLlmPromoResponse` from `promo-analysis.ts` (these move behind the adapter).

## Key behavior changes

1. **Adapter resolution**: `PromoAnalysis.run()` reads `providerId` from prefs → calls `ProviderRegistry.get(providerId)` → calls `adapter.analyzeTranscript(...)`.
2. **Guard clause update**: Instead of checking `orConfig.enabled && apiKey && model`, the pipeline checks `adapter.availability() !== 'unavailable'`. If unavailable, sets status to `not_configured`.
3. **Abort on provider switch**: When a `SET_ACTIVE_PROVIDER` message arrives, if the new provider differs from the one used by the in-flight request, abort the in-flight via existing `AbortController`. The next caption arrival picks up the new provider.
4. **Log enrichment**: The log bundle now includes `providerId` and `providerModel` for traceability.

## Acceptance criteria

- [ ] `PromoAnalysis.run()` no longer directly imports `callOpenRouterChat`
- [ ] Pipeline resolves the adapter from `ProviderRegistry` using `providerId` from prefs
- [ ] If adapter is `undefined` or unavailable, status is set to `not_configured`
- [ ] In-flight abort fires when `SET_ACTIVE_PROVIDER` changes the provider
- [ ] Log bundle includes `providerId` and model name
- [ ] Test: set provider to `openrouter` → mock adapter A is called
- [ ] Test: set provider to `chrome-prompt-api` → mock adapter B is called
- [ ] Test: switch provider mid-flight → in-flight abort fires
- [ ] Existing E2E tests pass (OpenRouter path is unchanged behind the adapter)
- [ ] `pnpm run lint` passes

## Testing

- Unit test with two mock adapters registered. Set `providerId` → run pipeline → assert correct adapter called.
- Unit test: provider switch triggers abort of in-flight request.
- Unit test: unknown `providerId` → `not_configured` status.
- Existing E2E tests should remain green since behavior is unchanged.
