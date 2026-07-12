# Issue Validation Report: Local backend handshake and API contract

- **Validated**: 2026-07-06
- **Model**: GPT-5 Codex
- **Issue**: `.sdd/.current/issues/1-AFK/issue.md`
- **Plan**: `.sdd/.current/issues/1-AFK/plan.md`
- **Validation attempt**: 1

## Summary

| Category | Pass | Partial | Fail | Total |
| --- | --- | --- | --- | --- |
| Tasks | 11 | 0 | 0 | 11 |
| Acceptance Criteria | 4 | 0 | 0 | 4 |
| Entities | 4 | 0 | 0 | 4 |
| Contracts | 3 | 0 | 0 | 3 |
| Guidelines | 8 | 0 | 0 | 8 |

**Overall Status**: COMPLETE

## Task Status

- [x] **Task 1: Shared Server Analysis Contract** - PASS: `src/shared/server-analysis-contract.ts` defines strict request, processing response, and error schemas with YouTube ID validation, unique client capabilities, and integer `pollAfterSec`; `tests/shared/server-analysis-contract.test.ts` covers valid metadata, malformed IDs, duplicate capabilities, fractional poll intervals, and absence of caption/transcript fields.
- [x] **Task 2: Persist Analysis Mode in Preferences** - PASS: `src/shared/constants.ts` adds `ANALYSIS_MODE`, `AnalysisMode`, `analysisModeSchema`, and `UserPreferences.analysisMode`; `src/background/storage/prefs-sync.ts` defaults and repairs legacy rows to `server`; `tests/background/storage/prefs-sync.test.ts` covers legacy migration.
- [x] **Task 3: Minimal Local Backend** - PASS: `src/backend/analysis-api.ts` returns health metadata, typed 400 errors, and deterministic 202 processing responses without extraction, transcription, or LLM work; `src/backend/server.ts` bounds request bodies, handles malformed JSON, and exposes the local HTTP server; backend tests cover health, processing, invalid video IDs, malformed JSON, and oversized bodies.
- [x] **Task 4: Dev-Only Backend Host Permission** - PASS: `rspack.config.ts` adds the local backend host only for dev builds; explicit dev and release manifest checks passed.
- [x] **Task 5: Background Server Client** - PASS: `src/background/server-analysis-client.ts` builds a validated metadata-only request, posts to `http://127.0.0.1:8787/v1/analysis`, validates the processing response, and aborts hung requests with a stable timeout error; `tests/background/server-analysis-client.test.ts` covers request shape, no transcript fields, and timeout abort behavior.
- [x] **Task 6: Runtime Message for Server Analysis** - PASS: `src/shared/messages.ts` adds `REQUEST_SERVER_ANALYSIS`, request/response types, and detection `source`; `src/background/messaging/server-analysis-runtime-messages.ts` maps processing responses to `{ status: 'analyzing', source: 'server' }` and failures to `{ status: 'error', source: 'server' }`; routing is wired in `register-runtime-messages.ts`.
- [x] **Task 7: Content-Side Server Route** - PASS: `src/content/server-analysis-request.ts` selects server mode only when enabled and configured for `server`; `src/content/page-guards.ts` returns an 11-character fixture ID; `src/content/youtube-watch.ts` waits for prefs, sends one server request per video ID, and leaves caption capture on the BYOK path.
- [x] **Task 8: Guard Caption Handler from Provider Analysis in Server Mode** - PASS: `src/background/messaging/caption-runtime-messages.ts` loads prefs and returns before `PromoAnalysis.onCaptionsReady` unless `analysisMode === 'byok'`; tests cover server bypass and BYOK invocation.
- [x] **Task 9: Server Popup Status States** - PASS: `src/popup/PopupApp.tsx` renders server pending and server error states before local provider status handling; all locale files contain the required server pending/error keys; popup view-model tests assert server-specific copy and no API-key guidance on server errors.
- [x] **Task 10: End-to-End Server Pending Flow** - PASS: `e2e/extension.spec.ts` starts a local backend, asserts the extension posts metadata for `e2eFixture1` without transcript text, and verifies the popup shows `Server analysis pending`.
- [x] **Task 11: Final Validation** - PASS: Focused tests, lint, build, full unit tests, coverage, e2e, and dev/release manifest checks all passed with the repository-pinned pnpm via Corepack.

## Acceptance Criteria Status

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Given server mode is active and a current video ID exists, when the extension requests analysis, then it sends a validated analysis request to the configured local backend endpoint. | MET | `YoutubeWatch.requestServerAnalysis` sends `REQUEST_SERVER_ANALYSIS`; `ServerAnalysisClient.requestProcessing` calls `buildServerAnalysisRequest` before `fetch`; `tests/background/server-analysis-client.test.ts` verifies URL, headers, payload, and no transcript fields; e2e verifies the backend receives `e2eFixture1`. |
| 2 | Given the local backend receives a valid analysis request, when no cached result is available in this slice, then it returns a typed `processing` response without performing extraction, transcription, or LLM work. | MET | `BackendAnalysisApi.handleAnalysisRequest` validates the body and returns a deterministic `ProcessingResponse`; no extraction, transcription, or LLM modules are imported by `src/backend/*`; backend tests verify 202 processing and typed 400/413 guard responses. |
| 3 | Given the backend response is `processing`, when the extension updates detection state, then the popup/status path can report that server analysis is pending. | MET | `ServerAnalysisRuntimeMessages.handleRequest` writes `{ status: 'analyzing', source: 'server' }` to `PromoDetectionStore`; `PopupApp` renders server pending copy; popup tests and e2e verify `Server analysis pending`. |
| 4 | Given server mode is active, when the server request path runs, then the existing direct provider analysis path is not invoked for that request. | MET | Content routing sends the server request instead of scheduling captions in server mode; `CaptionRuntimeMessages.handle` returns unless mode is BYOK; `tests/background/messaging/caption-runtime-messages.test.ts` verifies `PromoAnalysis.onCaptionsReady` is not called in server mode. |

## Entity Status

| Entity | Fields | Relationships | Validation | Status |
| --- | --- | --- | --- | --- |
| Analysis Mode | OK: `analysisMode: 'server' | 'byok'` on `UserPreferences`. | OK: read by content routing and background guards. | OK: Valibot picklist with fallback to `server`. | PASS |
| Server Analysis Request | OK: `videoId`, optional positive `durationSec`, `extensionVersion`, `algorithmVersion`, and `client`. | OK: built in background client from content metadata. | OK: strict Valibot schema rejects malformed IDs, duplicate capabilities, non-positive duration, and extra fields. | PASS |
| Processing Response | OK: `status`, `videoId`, `algorithmVersion`, `jobId`, `pollAfterSec`. | OK: backend response is validated by background client and mapped to detection state. | OK: strict Valibot schema enforces integer `pollAfterSec >= 1`. | PASS |
| Promo Detection State Payload | OK: optional `source` supports `server`, `local_provider`, `local_cache`, and `server_cache`. | OK: background store is read by existing popup status path. | OK: TypeScript payload types and tests cover server pending and error states. | PASS |

## Contract Status

| Endpoint | Method | Status | Notes |
| --- | --- | --- | --- |
| `/v1/health` | GET | PASS | OpenAPI defines `HealthResponse`; `BackendAnalysisApi.health` returns matching metadata and is unit-tested. |
| `/v1/analysis` | POST | PASS | OpenAPI defines `AnalysisRequest`, 202 `ProcessingResponse`, and typed error responses; shared Valibot schemas enforce the non-trivial OpenAPI constraints used in this slice. |
| `/v1/analysis` request errors | POST | PASS | Malformed JSON returns 400 `invalid_request`; oversized bodies return 413 `request_body_too_large`; invalid video IDs return 400 `invalid_video_id`. |

## Guidelines Compliance

| Guideline | Status | Notes |
| --- | --- | --- |
| Background-only storage for prefs | COMPLIANT | `analysisMode` is persisted through `PrefsSyncStorage`; content and popup use runtime messaging. |
| `browser.*` through shared polyfill | COMPLIANT | New extension runtime code imports `browser` from `@/shared/browser`. |
| Shared modules remain pure | COMPLIANT | `src/shared/server-analysis-contract.ts` contains schemas, constants, and pure builders only; HTTP and fetch code are in backend/background modules. |
| Server mode bypasses direct provider path | COMPLIANT | Content routing and background caption guard both prevent provider analysis in server mode. |
| TypeScript strict and JSDoc requirements | COMPLIANT | `corepack pnpm run lint` passed, including oxlint, ESLint, markdownlint, and `tsc --noEmit`. |
| UI text from locales | COMPLIANT | New popup server pending/error strings are looked up through `translator.getMessage`; every locale file has the required keys. |
| Dev-only local backend host | COMPLIANT | Dev build includes `http://127.0.0.1:8787/*`; release build excludes it. |
| Test coverage for touched behavior | COMPLIANT | Focused unit tests, full unit suite, coverage, and Playwright e2e all passed. |

## Issues Found

None.

## Recommendations

- Use `corepack pnpm ...` for local verification in this workspace. The direct `pnpm` on this verifier shell resolved to `pnpm@11.7.0` and stopped on build-script approval before running tests, while the repository-pinned `pnpm@10.33.0` via Corepack passed all gates.

## Verification Commands

- `corepack pnpm run test tests/shared/server-analysis-contract.test.ts tests/backend/analysis-api.test.ts tests/backend/server.test.ts tests/background/server-analysis-client.test.ts tests/background/messaging/server-analysis-runtime-messages.test.ts tests/background/messaging/caption-runtime-messages.test.ts tests/content/server-analysis-request.test.ts tests/content/page-guards.test.ts tests/popup/popup-view-model.test.ts tests/background/storage/prefs-sync.test.ts` - PASS, 10 files, 43 tests.
- `corepack pnpm run lint` - PASS.
- `corepack pnpm run build` - PASS with existing Rspack bundle-size warnings for popup/options.
- `corepack pnpm run test` - PASS, 64 files, 378 tests.
- `corepack pnpm run test:coverage` - PASS, all configured thresholds met.
- `corepack pnpm run test:e2e` - PASS, 9 tests.
- `TOPSKIP_BUILD=dev corepack pnpm run build` plus manifest assertion - PASS, backend host permission present.
- `TOPSKIP_BUILD=release corepack pnpm run build` plus manifest assertion - PASS, backend host permission absent.
