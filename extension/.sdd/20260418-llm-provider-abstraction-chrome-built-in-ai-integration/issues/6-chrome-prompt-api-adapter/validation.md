# Issue Validation Report: Chrome Prompt API adapter

**Validated**: 2026-04-17
**Model**: Claude Opus 4.6 (copilot) high
**Issue**: `.sdd/.current/issues/6-chrome-prompt-api-adapter/issue.md`
**Plan**: `.sdd/.current/issues/6-chrome-prompt-api-adapter/plan.md`

## Summary

| Category | Pass | Partial | Fail | Total |
| --- | --- | --- | --- | --- |
| Tasks | 4 | 0 | 0 | 4 |
| Acceptance Criteria | 10 | 0 | 0 | 10 |
| Entities | 1 | 0 | 0 | 1 |
| Contracts | N/A | N/A | N/A | N/A |
| Guidelines | 8 | 0 | 0 | 8 |

**Overall Status**: COMPLETE

## Task Status

- [x] **Task 1**: Adapter skeleton — properties and availability - PASS
- [x] **Task 2**: `analyzeTranscript` — happy path, truncation, and error handling - PASS
- [x] **Task 3**: Register adapter in `ProviderRegistry` - PASS
- [x] **Task 4**: Final validation - PASS

## Acceptance Criteria Status

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | `ChromePromptApiAdapter` is registered in `ProviderRegistry` | MET | `default-registry.ts` line 13: `new ChromePromptApiAdapter()` in registry array; `default-registry.test.ts` passes |
| 2 | `availability()` correctly maps all four Chrome states | MET | Tests: "returns available/downloadable/downloading/unavailable when Chrome reports…" — 4 tests pass |
| 3 | `availability()` returns `'unavailable'` when `LanguageModel` is not in global scope | MET | Test: "returns unavailable when LanguageModel is not on globalThis" passes; implementation guards via `Reflect.get(globalThis, 'LanguageModel')` |
| 4 | `analyzeTranscript()` creates a session, sends prompt, and returns parsed result | MET | Test: "creates session with system prompt and returns parsed result" — verifies `create()` called, `prompt()` called, `destroy()` called, result parsed correctly |
| 5 | Transcript truncation fires when content exceeds `session.contextWindow` budget | MET | Test: "truncates transcript from start when it exceeds context budget" — `contextWindow: 64` with 2000-char transcript triggers truncation; `console.warn` emitted |
| 6 | Truncation removes from the start (oldest captions) | MET | Test asserts `longTranscript.endsWith(promptArg) === true` — tail preserved; implementation uses `transcript.slice(transcript.length - maxChars)` |
| 7 | `responseConstraint` JSON Schema is included in `prompt()` call | MET | Test: "passes responseConstraint JSON Schema to prompt()" — inspects `session.prompt.mock.calls[0][1].responseConstraint`; `PROMO_DETECTION_RESPONSE_SCHEMA` is a `oneOf` JSON Schema |
| 8 | Session is destroyed after each analysis | MET | Test: "creates session…" asserts `session.destroy` called once; test: "returns error and destroys session when prompt() throws" confirms cleanup on error; implementation uses `finally { session.destroy() }` |
| 9 | AbortSignal is forwarded to both `create()` and `prompt()` | MET | Test: "forwards the AbortSignal to create() and prompt()" — asserts signal in both `lmGlobal.create` and `session.prompt` call args |
| 10 | `pnpm run lint` passes | MET | ESLint + markdownlint + `tsc --noEmit` all pass with zero errors |

## Entity Status

| Entity | Fields | Relationships | Validation | Status |
| --- | --- | --- | --- | --- |
| `ChromePromptApiAdapter` | `id = 'chrome-prompt-api'`, `displayName = 'Chrome Built-in'` — OK | Implements `LlmProviderAdapter` interface — OK | `availability()` returns `'unavailable'` when global absent; `analyzeTranscript()` returns `{ ok: false }` on error — OK | PASS |

## Contract Status

N/A — no API endpoints required. The adapter uses Chrome's in-process `LanguageModel` API.

## Guidelines Compliance

| Guideline | Status | Notes |
| --- | --- | --- |
| TypeScript strict, avoid `any` | COMPLIANT | All types explicit; `unknown` used for `LanguageModel` global access with narrowing |
| Avoid `as` (type assertions) | COMPLIANT | Two `as` casts unavoidable for untyped `Reflect.get` results (`availFn as () => Promise<unknown>`, `createFn as (opts: LanguageModelCreateOptions) => Promise<LanguageModel>`); `Reflect.get` returns `unknown`, narrowing done before cast |
| Classes as namespaces / grouping | COMPLIANT | `ChromePromptApiAdapter` is a class implementing the adapter interface |
| JSDoc multi-line blocks with `@param`/`@returns` | COMPLIANT | Both `availability()` and `analyzeTranscript()` have full JSDoc blocks with `@returns`; class-level JSDoc present |
| `@/…` import alias | COMPLIANT | All imports use `@/background/…` paths |
| Shared modules — no I/O in `src/shared/` | COMPLIANT | Adapter lives in `src/background/providers/`, not `shared/` |
| MobX / React conventions | N/A | No UI components in this issue |
| Vitest test patterns | COMPLIANT | Tests in `tests/background/providers/`, use `vi.stubGlobal`/`vi.restoreAllMocks`/`afterEach` cleanup; 18 tests covering happy path, error paths, edge cases |

## Issues Found

None.

## Recommendations

- Run `prd-validate-issue` for dependent issues (7-chrome-builtin-onboarding, 8-popup-chrome-readiness) when they reach "Implemented" status, as they build on this adapter.
