# Issue Validation Report: Issue 3 — Wire `PromoAnalysis` pipeline to resolve adapter from registry

**Validated**: 2026-04-17
**Model**: GPT-5.4
**Issue**: `.sdd/.current/issues/3-wire-pipeline-to-registry/issue.md`
**Plan**: `.sdd/.current/issues/3-wire-pipeline-to-registry/plan.md`

## Summary

| Category | Pass | Partial | Fail | Total |
| --- | --- | --- | --- | --- |
| Tasks | 8 | 0 | 0 | 8 |
| Acceptance Criteria | 10 | 0 | 0 | 10 |
| Entities | 0 | 0 | 0 | 0 |
| Contracts | 0 | 0 | 0 | 0 |
| Guidelines | 5 | 0 | 0 | 5 |

**Overall Status**: COMPLETE

## Task Status

- [x] **Task 1**: Write failing test — pipeline calls adapter from registry - PASS. `tests/background/messaging/promo-analysis.test.ts` contains a passing adapter-routing test, and `pnpm run test` passed.
- [x] **Task 2**: Remove direct OpenRouter imports from `promo-analysis.ts` - PASS. `src/background/messaging/promo-analysis.ts` no longer imports `callOpenRouterChat`, `OpenRouterStorage`, or `parseLlmPromoResponse`, and instead resolves the adapter from `defaultRegistry`.
- [x] **Task 3**: Add `providerId` to log bundle - PASS. `src/background/openrouter/log-promo-analysis.ts` accepts `providerId`, includes it in bundle output, and `tests/background/openrouter/log-promo-analysis.test.ts` fixtures include it.
- [x] **Task 4**: Wire `defaultRegistry` into `Background.init()` and `registerRuntimeMessages()` - PASS. `src/background/messaging/register-runtime-messages.ts` now accepts a registry, configures provider-aware handlers with it, and `src/background/background.ts` passes `defaultRegistry` at startup.
- [x] **Task 5**: Pipeline resolves adapter for each run, not cached - PASS. `src/background/messaging/promo-analysis.ts` resolves the adapter inside `run()` from the configured registry after reading prefs.
- [x] **Task 6**: Test unknown `providerId` → `not_configured` - PASS. `tests/background/messaging/promo-analysis.test.ts` now asserts the emitted `not_configured` status payload when `registry.get()` returns `undefined`.
- [x] **Task 7**: Test adapter availability unavailable → `not_configured` - PASS. `tests/background/messaging/promo-analysis.test.ts` now asserts the emitted `not_configured` status payload when the adapter reports `unavailable`.
- [x] **Task 8**: Full test + lint verification - PASS. `pnpm run lint`, `pnpm run test`, `pnpm run build`, and `pnpm run test:e2e` all passed during validation. Build produced only existing size warnings.

## Acceptance Criteria Status

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | `PromoAnalysis.run()` no longer directly imports `callOpenRouterChat` | MET | `src/background/messaging/promo-analysis.ts` uses adapter resolution only; OpenRouter-specific imports are absent. |
| 2 | Pipeline resolves the adapter from `ProviderRegistry` using `providerId` from prefs | MET | `src/background/messaging/promo-analysis.ts` reads prefs, then resolves through the configured registry via `PromoAnalysis.registry.get(providerId)`. |
| 3 | If adapter is `undefined` or unavailable, status is set to `not_configured` | MET | `src/background/messaging/promo-analysis.ts` sets `status: 'not_configured'` for both missing and unavailable adapters. |
| 4 | In-flight abort fires when `SET_ACTIVE_PROVIDER` changes the provider | MET | `src/background/messaging/provider-runtime-messages.ts` handles `SET_ACTIVE_PROVIDER` and calls `PromoAnalysis.abortForProviderChange(...)`; `tests/background/messaging/promo-analysis.test.ts` asserts the abort signal flips to `aborted`. |
| 5 | Log bundle includes `providerId` and model name | MET | `src/background/openrouter/log-promo-analysis.ts` emits `providerId` and `model`; tests in `tests/background/openrouter/log-promo-analysis.test.ts` cover the updated shape. |
| 6 | Test: set provider to `openrouter` → mock adapter A is called | MET | `tests/background/messaging/promo-analysis.test.ts` verifies registry lookup with `openrouter` and asserts the adapter analysis mock is called. |
| 7 | Test: set provider to `chrome-prompt-api` → mock adapter B is called | MET | `tests/background/messaging/promo-analysis.test.ts` now loads `chrome-prompt-api` from prefs, returns a second mock adapter from the registry, and asserts that adapter is called. |
| 8 | Test: switch provider mid-flight → in-flight abort fires | MET | `tests/background/messaging/promo-analysis.test.ts` covers a pending analysis that is aborted by `SET_ACTIVE_PROVIDER`. |
| 9 | Existing E2E tests pass (OpenRouter path is unchanged behind the adapter) | MET | `pnpm run test:e2e` passed on 2026-04-17 with 4/4 tests green. |
| 10 | `pnpm run lint` passes | MET | `pnpm run lint` passed on 2026-04-17. |

## Entity Status

This issue does not introduce or modify persistent data entities. Entity verification was skipped.

| Entity | Fields | Relationships | Validation | Status |
| --- | --- | --- | --- | --- |
| None | N/A | N/A | N/A | SKIP |

## Contract Status

No contract files exist under `.sdd/.current/issues/3-wire-pipeline-to-registry/contracts/`, and the plan marks contracts as N/A.

| Endpoint | Method | Status | Notes |
| --- | --- | --- | --- |
| None | N/A | SKIP | No API contracts are defined for this issue. |

## Guidelines Compliance

| Guideline | Status | Notes |
| --- | --- | --- |
| Use the standardized `browser.*` surface from `src/shared/browser.ts` | COMPLIANT | `src/background/messaging/promo-analysis.ts` uses `browser` from `@/shared/browser`. |
| Keep provider interfaces and registry code in the background bundle, not `src/shared/` | COMPLIANT | Adapter, registry, and pipeline code remain under `src/background/providers/` and `src/background/messaging/`. |
| Prefer static-only classes / namespace-style organization for non-trivial background logic | COMPLIANT | `PromoAnalysis`, `Background`, and `LogPromoAnalysis` follow the established static-class pattern. |
| TypeScript strict / no `any` in source implementation | COMPLIANT | Inspected source files are TypeScript-only and passed `pnpm run lint` plus `tsc --noEmit`. |
| Tests should mirror `src/**` and mock `@/shared/browser` where appropriate | COMPLIANT | `tests/background/messaging/promo-analysis.test.ts` mirrors the source area and mocks `@/shared/browser`. |

## Issues Found

No issue-specific implementation gaps remain.

## Recommendations

- No additional issue-specific follow-up is required.