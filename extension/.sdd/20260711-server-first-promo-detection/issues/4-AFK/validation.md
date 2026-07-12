# Issue Validation Report: Cold analysis job lifecycle and polling

- **Validated**: 2026-07-07
- **Model**: GPT-5 Codex
- **Issue**: `.sdd/.current/issues/4-AFK/issue.md`
- **Plan**: `.sdd/.current/issues/4-AFK/plan.md`
- **Validation attempt**: 1

## Summary

| Category | Pass | Partial | Fail | Total |
| --- | --- | --- | --- | --- |
| Tasks | 11 | 0 | 0 | 11 |
| Acceptance Criteria | 4 | 0 | 0 | 4 |
| Entities | 4 | 0 | 0 | 4 |
| Contracts | 4 | 0 | 0 | 4 |
| Guidelines | 11 | 0 | 0 | 11 |

**Overall Status**: COMPLETE

All issue-scoped implementation tasks are present and verified. The normal `pnpm run ...` entrypoints are blocked before script execution by the unrelated untracked `pnpm-workspace.yaml` / `esbuild` approval state, so validation used the underlying local tool binaries to verify the implementation without mutating workspace approval configuration.

## Task Status

- [x] **Task 1**: Extend shared server response contracts - PASS. `src/shared/server-analysis-contract.ts` exports `noPromoResponseSchema`, `unavailableResponseSchema`, `terminalErrorResponseSchema`, adds them to `serverAnalysisResponseSchema`, and includes typed `job_not_found`; `tests/shared/server-analysis-contract.test.ts` covers union parsing.
- [x] **Task 2**: Add the in-memory backend job store - PASS. `src/backend/analysis-jobs.ts` stores jobs by deterministic job id and by `videoId:algorithmVersion`, returns existing active or terminal responses, supports all fixture terminal states, and is covered by `tests/backend/analysis-jobs.test.ts`.
- [x] **Task 3**: Wire jobs into the backend API - PASS. `src/backend/analysis-api.ts` creates pollable cold-miss jobs, keeps ready fixture cache priority, maps processing to `202`, maps terminal duplicates to `200`, and returns typed `job_not_found`; `tests/backend/analysis-api.test.ts` verifies those paths.
- [x] **Task 4**: Add HTTP job status and fixture routes - PASS. `src/backend/server.ts` routes `GET /v1/analysis/jobs/{jobId}` and `POST /v1/analysis/jobs/{jobId}/fixture-result` through the API layer; `tests/backend/server.test.ts` verifies polling, fixture completion, and unknown-job responses.
- [x] **Task 5**: Add background job status client - PASS. `src/background/server-analysis-client.ts` adds `requestJobStatus(jobId)` with URL encoding, shared timeout policy, and Valibot response parsing; `tests/background/server-analysis-client.test.ts` covers status fetches.
- [x] **Task 6**: Add runtime status refresh messages - PASS. `src/shared/messages.ts` defines `REFRESH_SERVER_ANALYSIS_STATUS`, refresh payloads, `inactive`, and terminal acknowledgements; `src/content/server-analysis-request.ts` builds the refresh message; `tests/content/server-analysis-request.test.ts` covers it.
- [x] **Task 7**: Map status refreshes in background runtime - PASS. `src/background/messaging/server-analysis-runtime-messages.ts` reloads current prefs before backend access, returns `inactive` outside server mode, maps all terminal states, saves ready responses non-fatally, and delivers ready blocks through `PROMO_BLOCKS_DETECTED`; `register-runtime-messages.ts` dispatches refresh messages; `tests/background/messaging/server-analysis-runtime-messages.test.ts` covers the guard and mappings.
- [x] **Task 8**: Poll from the watch content script - PASS. `src/content/youtube-watch.ts` owns the polling timer, checks current video and server-mode prefs before refresh, clears polling on navigation, terminal/inactive responses, errors, and `PREFS_UPDATED` outside server mode; `e2e/extension.spec.ts` covers polling to fixture-ready and prefs-update cancellation.
- [x] **Task 9**: Preserve late-arriving block semantics - PASS. `tests/content/youtube-watch-skip-integration.test.ts` includes the server-ready late-result regression proving already-passed starts do not fire while future crossings still skip.
- [x] **Task 10**: Surface server terminal states in popup - PASS. `src/popup/PopupApp.tsx` renders server `no_promo` and `unavailable` before Chrome provider setup branches; all locale files include the new keys; `tests/popup/popup-view-model.test.ts` covers precedence over Chrome availability states.
- [x] **Task 11**: Run focused and full verification - PASS. Focused Vitest, full Vitest, coverage, build, lint components, and Playwright E2E pass when run through direct local tool binaries. The pnpm script wrapper remains blocked by unrelated esbuild approval state before it can run the same commands.

## Acceptance Criteria Status

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Given the backend has no valid result for a video, When the extension requests analysis, Then the backend creates or returns a job and responds with `processing`. | MET | `BackendAnalysisJobs.start`, `BackendAnalysisApi.handleAnalysisRequest`, `BackendHttpServer` job routes, and tests in `tests/backend/analysis-jobs.test.ts`, `tests/backend/analysis-api.test.ts`, and `tests/backend/server.test.ts`. |
| 2 | Given the extension receives `processing`, When the popup/status path renders, Then it shows an analyzing-on-server state. | MET | `ServerAnalysisRuntimeMessages.applyServerResponse` sets `PromoDetectionStore` to `{ status: 'analyzing', source: 'server' }`; the existing server analyzing popup branch is exercised by the local-backend pending E2E flow in `e2e/extension.spec.ts`. |
| 3 | Given a processing job later becomes ready, When the extension refreshes job status, Then it receives normalized blocks and applies them through the server-result path. | MET | `ServerAnalysisClient.requestJobStatus`, `ServerAnalysisRuntimeMessages.handleRefreshStatus`, `ServerResultCacheStorage.saveReadyResponse`, and `PROMO_BLOCKS_DETECTED` delivery are covered by unit tests and the `server processing job polls fixture completion and skips only future blocks` E2E test. |
| 4 | Given ready blocks arrive after playback has already passed an early block start, When the content script receives them, Then it does not jump backward and only applies future block crossings. | MET | `tests/content/youtube-watch-skip-integration.test.ts` pins the late-result rule, and the E2E polling test confirms the early fixture block is ignored while the later block skips. |

## Entity Status

| Entity | Fields | Relationships | Validation | Status |
| --- | --- | --- | --- | --- |
| Analysis Job | OK | OK | OK | PASS |
| Server Analysis Response | OK | OK | OK | PASS |
| Fixture Completion Request | OK | OK | OK | PASS |
| Server Polling State | OK | OK | OK | PASS |

## Contract Status

| Endpoint | Method | Status | Notes |
| --- | --- | --- | --- |
| `/v1/analysis` | POST | PASS | Contract and implementation support cache-hit `200`, active-job `202`, and existing terminal duplicate `200`. |
| `/v1/analysis/jobs/{jobId}` | GET | PASS | Returns `202 processing`, terminal `200`, or typed `404 job_not_found`. |
| `/v1/analysis/jobs/{jobId}/fixture-result` | POST | PASS | Completes deterministic local jobs as `ready`, `no_promo`, `unavailable`, or `error`. |
| `ErrorResponse.error.code` | N/A | PASS | Contract and Valibot schema include `job_not_found`. |

## Guidelines Compliance

| Guideline | Status | Notes |
| --- | --- | --- |
| Background owns storage and backend I/O | COMPLIANT | Content/popup use runtime messages; backend status fetches remain in background. |
| Prefs fan-out and stale-prefs behavior | COMPLIANT | Content clears polling on `PREFS_UPDATED` outside server mode; background reloads current prefs before status fetches. |
| Shared code purity boundaries | COMPLIANT | Shared additions are contracts/types/message builders; backend/client I/O stays in owning bundles. |
| Static API class pattern | COMPLIANT | New grouped concerns use static-only classes without empty constructors. |
| TypeScript strict and Valibot boundaries | COMPLIANT | Untyped JSON is parsed as `unknown` and validated before use. |
| Avoid unsafe type assertions | COMPLIANT | No issue-scoped unsafe assertions were found in `src/` additions; tests use local mock casts where appropriate. |
| Guard-style control flow | COMPLIANT | Polling, routing, and API handlers use early exits for invalid or inactive states. |
| JSDoc and comments | COMPLIANT | New `src/` functions/classes include required JSDoc; comments document constraints rather than restating basic operations. |
| UI strings through i18n | COMPLIANT | New popup server terminal strings are present in all locale files. |
| No magic semantic literals | COMPLIANT | Shared constants and local named constants are used for backend URL, algorithm version, polling units, and HTTP/body limits. |
| Tests scale with risk | COMPLIANT | Unit, integration, contract, and E2E coverage were added for the backend lifecycle, runtime polling, popup state, and late-result behavior. |

## Issues Found

None for the issue-scoped implementation.

## Unrelated Workspace Blockers

1. **pnpm approval state blocks script entrypoints before test/build commands run**
   - Location: `pnpm-workspace.yaml`
   - Description: The untracked file contains `allowBuilds: esbuild: set this to true or false`; pnpm exits with `ERR_PNPM_IGNORED_BUILDS` for `esbuild@0.27.7` before invoking `pnpm run test`, `pnpm exec serve`, or the Playwright configured webServer.
   - Impact: This blocks normal repository script wrappers and Playwright's configured webServer startup, but it is not caused by the 4-AFK implementation. Direct local tool binaries run successfully.
   - Recommendation: Resolve the pnpm approve-builds state separately, then rerun the canonical `pnpm run ...` commands.

## Verification Results

- `pnpm run test ...focused files...` - BLOCKED before Vitest by unrelated `ERR_PNPM_IGNORED_BUILDS` for `esbuild@0.27.7`.
- `node_modules/.bin/vitest run tests/shared/server-analysis-contract.test.ts tests/backend/analysis-jobs.test.ts tests/backend/analysis-api.test.ts tests/backend/server.test.ts tests/background/server-analysis-client.test.ts tests/background/messaging/server-analysis-runtime-messages.test.ts tests/content/server-analysis-request.test.ts tests/content/youtube-watch-skip-integration.test.ts tests/popup/popup-view-model.test.ts` - PASS, 9 files and 89 tests.
- `node_modules/.bin/oxfmt --check .` - FAIL only on unrelated untracked `pnpm-workspace.yaml`.
- `node_modules/.bin/oxfmt --check src tests e2e package.json rspack.config.ts` - PASS.
- `node_modules/.bin/oxlint --jsdoc-plugin --react-plugin --vitest-plugin .` - PASS.
- `node_modules/.bin/eslint .` - PASS.
- `node_modules/.bin/markdownlint-cli2 "**/*.md" "#node_modules" "#dist" "#coverage" "#.sdd" "#test-results" "#tmp"` - PASS.
- `node_modules/.bin/tsc --noEmit` - PASS.
- `node_modules/.bin/rspack build --config rspack.config.ts` - PASS with pre-existing bundle-size warnings.
- `node_modules/.bin/vitest run` - PASS, 66 files and 430 tests.
- `node_modules/.bin/vitest run --coverage` - PASS, thresholds met.
- `node_modules/.bin/playwright test` - initial run BLOCKED because configured `pnpm exec serve` webServer hit the unrelated pnpm approval state.
- `node_modules/.bin/serve e2e/fixtures -p 4173 -L` plus `node_modules/.bin/playwright test` - PASS, 13 tests.

## Recommendations

- Resolve the unrelated pnpm `esbuild` approval state so canonical `pnpm run lint`, `pnpm run build`, and `pnpm run test:e2e` can execute normally.
- Keep issue 4-AFK marked `Validated`; no implementation fixes are required from this validation pass.
