# Issue Validation Report: Job dedupe, validation, and local rate limits

- **Validated**: 2026-07-07
- **Model**: GPT-5 Codex
- **Issue**: `.sdd/.current/issues/5-AFK/issue.md`
- **Plan**: `.sdd/.current/issues/5-AFK/plan.md`
- **Validation attempt**: 1

## Summary

| Category | Pass | Partial | Fail | Total |
| --- | --- | --- | --- | --- |
| Tasks | 5 | 0 | 0 | 5 |
| Acceptance Criteria | 4 | 0 | 0 | 4 |
| Entities | 4 | 0 | 0 | 4 |
| Contracts | 3 | 0 | 0 | 3 |
| Guidelines | 12 | 0 | 0 | 12 |

**Overall Status**: COMPLETE

## Task Status

- [x] **Task 1: Shared Rate-Limit Contract** - PASS: `rateLimitedResponseSchema` and `RateLimitedResponse` exist in `src/shared/server-analysis-contract.ts`, stay separate from `serverAnalysisResponseSchema`, and are covered by strict parsing/non-positive retry metadata tests in `tests/shared/server-analysis-contract.test.ts`.
- [x] **Task 2: Backend API Protection Module** - PASS: `src/backend/api-protection.ts` defines separate `cache_lookup`, `job_join`, and `cold_job_start` classes, fixed-window cold-start limiting, retry metadata, reset helpers, and snapshots. `tests/backend/api-protection.test.ts` covers cheap accounting, denied cold starts, and window rollover.
- [x] **Task 3: Read-Only Job Lookup** - PASS: `BackendAnalysisJobs.findExisting` returns active or terminal responses without creating records, while `start` remains idempotent. `tests/backend/analysis-jobs.test.ts` verifies no-record lookup, active lookup, terminal lookup, and duplicate terminal reuse.
- [x] **Task 4: Enforce Request Ordering in BackendAnalysisApi** - PASS: `BackendAnalysisApi.handleAnalysisRequest` rejects invalid input before cache/job/protection work, classifies cache hits as cheap, classifies existing jobs as joins, rate-limits only cold starts, and creates jobs only after an allow decision. `tests/backend/analysis-api.test.ts` covers invalid/missing IDs, duplicate active/terminal joins, cheap cache hits, and `429` without a third job.
- [x] **Task 5: HTTP Boundary and Focused Verification** - PASS: `BackendHttpServer.handleAnalysis` returns the API result status/body unchanged, so `429` is exposed over HTTP. `tests/backend/server.test.ts` validates HTTP `429` shape through `rateLimitedResponseSchema` and proves no third job is created. The exact `pnpm` commands were blocked before running by unrelated esbuild approval state; equivalent local binaries passed as recorded below.

## Acceptance Criteria Status

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Given a request has an invalid or missing video ID, when the backend receives it, then it rejects the request without starting extraction, transcription, or LLM work. | MET | `BackendAnalysisApi.handleAnalysisRequest` returns `400` before cache lookup, protection accounting, or job creation for malformed string IDs and failed schema parses. Tests assert invalid IDs return `invalid_video_id`, missing IDs leave `BackendAnalysisJobs.snapshotForTests().jobCount` and all `BackendApiProtection` counters at `0`. |
| 2 | Given an active job already exists for the same video ID and algorithm version, when another request arrives, then the backend joins or returns the existing job rather than creating a duplicate. | MET | `BackendAnalysisJobs.findExisting` looks up the `videoId:algorithmVersion` key and returns the active or terminal response without mutation. API tests assert duplicate active requests return identical `202` bodies and duplicate terminal requests return the existing terminal `200` body. |
| 3 | Given repeated cold-analysis requests exceed the local rate-limit policy, when another cold request arrives, then the backend returns a retryable rate-limit response and does not enqueue expensive work. | MET | `BackendApiProtection.evaluate` denies the third cold start in the local window with `retryAfterSec`. API and HTTP tests assert `429`/`rate_limited` response bodies and `BackendAnalysisJobs.snapshotForTests().jobCount === 2`. |
| 4 | Given a request is a cheap cache lookup, when local limits are evaluated, then it is accounted separately from an expensive cold job start. | MET | Cache hits call `BackendApiProtection.evaluate` with `CacheLookup`; existing jobs use `JobJoin`; cold misses use `ColdJobStart`. Unit tests assert snapshots of `{ cacheLookups: 1, jobJoins: 1, coldJobStarts: 1 }` after one cold request, one duplicate join, and one seeded cache hit. |

## Entity Status

| Entity | Fields | Relationships | Validation | Status |
| --- | --- | --- | --- | --- |
| Backend Protection Decision | OK: discriminated allow/deny decision with cost class and retry metadata. | OK: produced by `BackendApiProtection.evaluate`, consumed by `BackendAnalysisApi.handleAnalysisRequest`. | OK: only cold starts can be denied; cheap classes always return allowed and are counted separately. | PASS |
| Local Rate-Limit Bucket | OK: window start, cold start, cache lookup, and job join counters are represented as static process-local state. | OK: owned by `BackendApiProtection`, reset/snapshotted by test helpers. | OK: cold-start limit and window duration are named constants; retry delay is positive. | PASS |
| Analysis Job | OK: in-memory records include job id, dedupe key, processing response, terminal response, and timestamps. | OK: existing `start`, `getStatus`, and `completeFixture` behavior is preserved; new `findExisting` is read-only. | OK: tests prove lookup does not create records and duplicate starts do not reset terminal jobs. | PASS |
| Rate-Limited Response | OK: strict schema contains `status`, `retryAfterSec`, and `error`. | OK: returned only from `POST /v1/analysis` cold-start denials. | OK: Valibot requires positive integer retry metadata and exact `rate_limited` code/status. | PASS |

## Contract Status

| Endpoint | Method | Status | Notes |
| --- | --- | --- | --- |
| `/v1/analysis` | POST | PASS | OpenAPI documents `200`, `202`, `400`, `413`, and new `429 RateLimitedResponse`. Implementation matches invalid-request, cache-hit, job-join, cold-start, and rate-limited behavior. |
| `/v1/analysis/jobs/{jobId}` | GET | PASS | Contract remains compatible with issue 4 behavior; server returns current processing/terminal state or typed `404 job_not_found`. |
| `/v1/analysis/jobs/{jobId}/fixture-result` | POST | PASS | Contract remains compatible with issue 4 behavior; server completes deterministic terminal fixture states or returns typed request/not-found errors. |

## Guidelines Compliance

| Guideline | Status | Notes |
| --- | --- | --- |
| Background/server-owned storage and side effects stay out of `shared/` | COMPLIANT | New `shared` code is schema/type/pure helper only; backend I/O and process-local state live under `src/backend`. |
| Runtime/API boundaries validate untrusted data with Valibot | COMPLIANT | Request, response, error, fixture-completion, and rate-limit shapes are parsed with Valibot schemas. |
| TypeScript strict, no `any` | COMPLIANT | Direct `tsc --noEmit` passed; reviewed issue files contain no `any`. |
| Avoid unsafe assertions | COMPLIANT | Issue-owned `src` assertions are limited to allowed `as const` and `JSON.parse(...) as unknown` at the untyped JSON boundary. |
| Static-only namespace classes for grouped backend concerns | COMPLIANT | Backend API, job store, protection, fixtures, and HTTP server use static class APIs consistent with repo style. |
| Guard clauses over deep nesting | COMPLIANT | Request handling and route handling use early returns; oxlint and ESLint pass. |
| JSDoc requirements for `src/` methods/types | COMPLIANT | Multi-line JSDoc is present on new public/private class methods, relevant type aliases, and constants; oxlint and ESLint pass. |
| Comments explain constraints rather than restating obvious code | COMPLIANT | Comments describe local capacity, cost-class separation, and boundary constraints. |
| No hardcoded user-visible UI text in UI components | N/A | This slice adds backend/server code and no UI strings. |
| No extra runtime network dependencies | COMPLIANT | The backend uses Node `http` and existing dependencies; no new runtime network dependency was added. |
| No magic literals with semantic meaning | COMPLIANT | Semantic response messages, local limits, window duration, poll interval, and fixture metadata use named constants. |
| Testing mirrors touched modules and covers behavior | COMPLIANT | Tests exist under `tests/shared` and `tests/backend` for the touched modules; full Vitest suite passes via local binary. |

## Issues Found

No issue-scoped implementation defects were found for `5-AFK`.

## Unrelated Workspace Blockers

1. **Unresolved pnpm/esbuild approval state blocks exact pnpm-script commands**
   - Location: `pnpm-workspace.yaml`
   - Description: Exact `pnpm run test ...` and `pnpm run lint:types` fail before running project scripts with `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: esbuild@0.27.7`. The untracked `pnpm-workspace.yaml` contains `allowBuilds: esbuild: set this to true or false`, so pnpm's approval state is unresolved.
   - Impact: This blocks exact aggregate pnpm-script verification in the current workspace, but not the `5-AFK` implementation itself.
   - Recommendation: Resolve the workspace's esbuild build-script approval state before relying on aggregate `pnpm run ...` commands.

2. **Full-tree format check is blocked by the same untracked workspace file**
   - Location: `pnpm-workspace.yaml`
   - Description: `./node_modules/.bin/oxfmt --check .` reports only `pnpm-workspace.yaml`.
   - Impact: Full `pnpm run lint` would remain blocked/failing for workspace reasons; issue-owned source, tests, and contract pass targeted `oxfmt --check`.
   - Recommendation: Fix or remove the unresolved workspace approval file separately from this issue validation.

## Verification Results

- `pnpm run test tests/shared/server-analysis-contract.test.ts tests/backend/api-protection.test.ts tests/backend/analysis-jobs.test.ts tests/backend/analysis-api.test.ts tests/backend/server.test.ts` - BLOCKED before Vitest by unrelated pnpm/esbuild approval state.
- `./node_modules/.bin/vitest run tests/shared/server-analysis-contract.test.ts tests/backend/api-protection.test.ts tests/backend/analysis-jobs.test.ts tests/backend/analysis-api.test.ts tests/backend/server.test.ts` - PASS: 5 files, 43 tests.
- `pnpm run lint:types` - BLOCKED before TypeScript by unrelated pnpm/esbuild approval state.
- `./node_modules/.bin/tsc --noEmit` - PASS.
- `./node_modules/.bin/rspack build --config rspack.config.ts` - PASS with pre-existing bundle size warnings.
- `./node_modules/.bin/vitest run` - PASS: 67 files, 441 tests.
- `./node_modules/.bin/oxfmt --check src/shared/server-analysis-contract.ts tests/shared/server-analysis-contract.test.ts src/backend/api-protection.ts tests/backend/api-protection.test.ts src/backend/analysis-jobs.ts tests/backend/analysis-jobs.test.ts src/backend/analysis-api.ts tests/backend/analysis-api.test.ts src/backend/server.ts tests/backend/server.test.ts .sdd/.current/issues/5-AFK/contracts/openapi.yaml` - PASS.
- `./node_modules/.bin/oxlint --jsdoc-plugin --react-plugin --vitest-plugin .` - PASS: 0 warnings, 0 errors.
- `./node_modules/.bin/eslint .` - PASS.
- `./node_modules/.bin/markdownlint-cli2 "**/*.md" "#node_modules" "#dist" "#coverage" "#.sdd" "#test-results" "#tmp"` - PASS: 0 errors.

## Recommendations

- No implementation fixes are required for `5-AFK`.
- Resolve the unrelated `pnpm-workspace.yaml` / esbuild approval state so exact `pnpm run ...` quality gates can run normally again.
