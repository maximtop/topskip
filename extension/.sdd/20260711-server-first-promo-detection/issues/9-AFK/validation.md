# Issue Validation Report: Failure and no-promo states end-to-end

- **Validated**: 2026-07-08
- **Model**: GPT-5 Codex
- **Issue**: `.sdd/.current/issues/9-AFK/issue.md`
- **Plan**: `.sdd/.current/issues/9-AFK/plan.md`
- **Validation attempt**: 1

## Summary

| Category | Pass | Partial | Fail | Total |
| --- | --- | --- | --- | --- |
| Tasks | 8 | 0 | 0 | 8 |
| Acceptance Criteria | 4 | 0 | 0 | 4 |
| Entities | 2 | 0 | 0 | 2 |
| Contracts | 1 | 0 | 0 | 1 |
| Guidelines | 8 | 0 | 0 | 8 |

**Overall Status**: COMPLETE

## Task Status

- [x] **Task 1**: Shared Rate-Limited Contract - PASS. `rateLimitedResponseSchema` validates positive retry metadata and participates in `serverAnalysisResponseSchema` at `src/shared/server-analysis-contract.ts:191` and `src/shared/server-analysis-contract.ts:203`. Contract tests cover valid union parsing and malformed retry metadata.
- [x] **Task 2**: Client 429 Parsing and Invalid Response Failures - PASS. `ServerAnalysisClient` parses HTTP 429 JSON through the validated server response union and still rejects non-OK non-429 responses and malformed bodies at `src/background/server-analysis-client.ts:86`. Focused client tests passed.
- [x] **Task 3**: Backend Rate-Limit Regression - PASS. Backend tests assert a third cold start returns HTTP 429 `rate_limited` and leaves job count at 2 in `tests/backend/analysis-api.test.ts:376` and `tests/backend/analysis-api.test.ts:420`.
- [x] **Task 4**: Runtime Mapping for All Non-Ready Server States - PASS. `rate_limited` is mapped before metadata reads and sets server `unavailable` popup state without content delivery at `src/background/messaging/server-analysis-runtime-messages.ts:83`. Request and refresh tests cover `no_promo`, `unavailable`, `error`, and `rate_limited` without delivering blocks at `tests/background/messaging/server-analysis-runtime-messages.test.ts:420` and `tests/background/messaging/server-analysis-runtime-messages.test.ts:507`.
- [x] **Task 5**: Network and Invalid Backend Response No-Fallback Behavior - PASS. Request failures set server error state and assert no `tabs.sendMessage` or ready-cache write at `tests/background/messaging/server-analysis-runtime-messages.test.ts:523`.
- [x] **Task 6**: Popup Server Failure Copy Regression - PASS. Popup view-model tests cover rate-limit state copy, preserving server-only wording and avoiding API-key setup copy at `tests/popup/popup-view-model.test.ts:215`.
- [x] **Task 7**: Content No-Skip Invariant for Server Terminal States - PASS. Content skip integration tests assert `no_promo`, `unavailable`, `error`, and `rate_limited` with no blocks leave playback unaltered at `tests/content/youtube-watch-skip-integration.test.ts:115`.
- [x] **Task 8**: Focused Verification - PASS. Focused Vitest, oxfmt, oxlint, and ESLint commands all passed for the planned files.

## Acceptance Criteria Status

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Given the backend returns `no_promo`, when the extension receives the result, then it shows a no-promo state and does not send promo blocks to the content script. | MET | Runtime request and refresh tests assert `no_promo` state and no `tabs.sendMessage` at `tests/background/messaging/server-analysis-runtime-messages.test.ts:439` and `tests/background/messaging/server-analysis-runtime-messages.test.ts:507`. |
| 2 | Given subtitle extraction is unavailable, when the job reaches a terminal state, then the backend returns an unavailable state with a stage-specific reason and the extension does not skip. | MET | Runtime maps `unavailable` to server unavailable popup state without block delivery at `src/background/messaging/server-analysis-runtime-messages.ts:155`, with regression coverage in `tests/background/messaging/server-analysis-runtime-messages.test.ts:456`. |
| 3 | Given backend analysis fails or returns invalid output, when the extension receives the terminal state, then it shows an error/unavailable state and playback is not altered. | MET | Terminal `error` maps to server error state without block delivery; invalid backend response rejection maps to no-delivery server error at `tests/background/messaging/server-analysis-runtime-messages.test.ts:523`. |
| 4 | Given the backend request fails due to network or rate-limit conditions, when server mode handles the failure, then playback continues without automatic local fallback and without server-detected skips. | MET | Network failure tests assert no content delivery and server error state at `tests/background/messaging/server-analysis-runtime-messages.test.ts:523`; rate-limit tests assert server unavailable state and no delivery at `tests/background/messaging/server-analysis-runtime-messages.test.ts:490`. |

## Entity Status

| Entity | Fields | Relationships | Validation | Status |
| --- | --- | --- | --- | --- |
| ServerAnalysisResponse | OK: includes `rate_limited`, retry metadata, and terminal/error fields. | OK: produced by backend and consumed by client/runtime. | OK: Valibot validates the expanded union at `src/shared/server-analysis-contract.ts:203`. | PASS |
| PromoDetectionStatePayload | OK: non-ready server states use `status`, `source`, and optional `error`; `promoBlocks` remains ready-only. | OK: runtime stores popup-visible state and sends content blocks only for ready responses. | OK: focused runtime tests assert no blocks for all terminal non-ready states. | PASS |

## Contract Status

| Endpoint | Method | Status | Notes |
| --- | --- | --- | --- |
| Local backend server-analysis response contract | POST/GET | PASS | The shared Valibot response union accepts `rate_limited` and rejects malformed retry metadata; HTTP 429 bodies are parsed through the same validation path. |

## Guidelines Compliance

| Guideline | Status | Notes |
| --- | --- | --- |
| Background-owned storage and runtime messaging boundaries | COMPLIANT | Server response handling stays in background messaging/client modules; content receives blocks only through runtime messages. |
| Shared modules remain pure contracts/types/helpers | COMPLIANT | `src/shared/server-analysis-contract.ts` contains schemas/types and no ambient I/O. |
| Use `browser.*` wrapper, not global `chrome` | COMPLIANT | Runtime delivery uses `@/shared/browser`. |
| Valibot at untrusted boundaries | COMPLIANT | Backend JSON is parsed as `unknown` and validated before runtime use. |
| Static namespace classes for background messaging concerns | COMPLIANT | `ServerAnalysisClient` and `ServerAnalysisRuntimeMessages` follow existing static API style. |
| Guard clauses and shallow control flow | COMPLIANT | `rate_limited` is handled before metadata-dependent logic; error cases return early. |
| User-visible popup copy from i18n-backed helpers | COMPLIANT | Popup failure copy uses existing translator-backed view-model branches. |
| Focused tests for changed behavior | COMPLIANT | Contract, client, backend, runtime, popup, and content no-skip tests cover the issue scope. |

## Issues Found

None.

## Recommendations

- No implementation fixes are required for issue `9-AFK`.
