# Issue Validation Report: LLM Analysis Worker and Block Normalization

- **Validated**: 2026-07-08
- **Model**: GPT-5 Codex
- **Issue**: `.sdd/.current/issues/7-AFK/issue.md`
- **Plan**: `.sdd/.current/issues/7-AFK/plan.md`
- **Validation attempt**: 2

## Summary

| Category | Pass | Partial | Fail | Total |
| --- | --- | --- | --- | --- |
| Tasks | 9 | 0 | 0 | 9 |
| Acceptance Criteria | 4 | 0 | 0 | 4 |
| Entities | 6 | 0 | 0 | 6 |
| Contracts | 3 | 0 | 0 | 3 |
| Guidelines | 9 | 0 | 0 | 9 |

**Overall Status**: COMPLETE

## Task Status

- [x] **Task 1: Shared Terminal Error Codes** - PASS: `src/shared/server-analysis-contract.ts` defines `SERVER_ANALYSIS_ERROR_CODE`, includes model-analysis codes in the strict terminal error-code schema, and `src/backend/analysis-jobs.ts` uses the fixture code constant. `tests/shared/server-analysis-contract.test.ts` covers accepted model codes and unknown-code rejection.
- [x] **Task 2: Backend Analysis Entity Types** - PASS: `src/backend/analysis/promo-analysis-types.ts` defines backend-only adapter, provider id, failure reason, parsed result, and analysis run artifact schemas. `tests/backend/promo-analysis-worker.test.ts` validates retained raw output, failed artifacts, injected provider ids, and invalid provider rejection.
- [x] **Task 3: Parser and Promo Block Normalization** - PASS: `src/backend/analysis/promo-response-parser.ts` strips optional JSON fences and validates JSON with `llmPromoDetectionSchema`; `src/backend/analysis/promo-block-normalization.ts` validates raw and deduped blocks, known-duration bounds, open-ended implied ends, and full-video degenerate blocks. Tests cover fenced JSON, no-promo JSON, invalid JSON, sorting/merging, out-of-bounds blocks, open-ended overruns, and full-video rejection.
- [x] **Task 4: Deterministic Local Analysis Adapter** - PASS: `src/backend/analysis/local-analysis-fixtures.ts` provides deterministic fixture-keyed promo/no-promo adapter output and a safe no-promo fallback. Worker tests verify primary and secondary fixture outputs.
- [x] **Task 5: Promo Analysis Worker** - PASS: `src/backend/analysis/promo-analysis-worker.ts` validates provider metadata, calls adapters safely, stores raw/parsed/normalized artifacts, maps ready/no-promo/error terminal responses, and prevents unsafe blocks from being delivered. Worker tests verify ready, no-promo, invalid JSON, unsafe blocks, open-ended unsafe blocks, and injected provider metadata.
- [x] **Task 6: Integrate Worker with Job Status** - PASS: `src/backend/analysis-jobs.ts` stores `durationSec` and `analysisRun`, adds `analyzing`, runs the worker on first status poll from `awaiting_analysis`, stores terminal responses, and returns terminal responses without rerunning analysis. `tests/backend/analysis-jobs.test.ts` covers first-poll analysis, diagnostics, duplicate reads, and existing fixture completion behavior.
- [x] **Task 7: API and HTTP Status Delivery** - PASS: `src/backend/analysis-api.ts` passes request duration into job creation and forwards deterministic status options. `tests/backend/analysis-api.test.ts` and `tests/backend/server.test.ts` verify worker-backed ready/no-promo status responses and HTTP status delivery.
- [x] **Task 8: Extension Polling Path Regression** - PASS: `src/background/messaging/server-analysis-runtime-messages.ts` continues delivering blocks only for `ready` responses and maps terminal non-ready states without sending promo blocks. `tests/background/messaging/server-analysis-runtime-messages.test.ts` is included in the focused passing suite.
- [x] **Task 9: Focused Final Verification** - PASS: Direct focused Vitest suite passed with 6 files and 84 tests; direct TypeScript, oxlint, ESLint, and focused formatting checks passed. The standard `pnpm run test ...` wrapper remains blocked before Vitest by an unrelated pnpm ignored-build approval state.

## Acceptance Criteria Status

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Given extraction produces a valid transcript artifact, When backend analysis runs, Then it records the raw model response and parsed result for that transcript. | MET | `BackendPromoAnalysisWorker.buildAnalysisRun` records `rawModelResponse` and `parsedResult`; `BackendAnalysisJobs.runAnalysis` stores `analysisRun`; `tests/backend/analysis-jobs.test.ts` verifies diagnostics contain raw promo output after polling. |
| 2 | Given the model response contains valid promo blocks, When normalization completes, Then the backend stores sorted, non-overlapping blocks inside the known duration when available. | MET | `normalizeBackendPromoBlocks` validates blocks before and after `sortAndDedupePromoBlocks`; worker tests verify sorted/merged output and ready responses inside `durationSec: 120`. |
| 3 | Given the model response is no-promo, invalid JSON, out of bounds, or degenerate, When analysis completes, Then the backend stores the correct terminal state and does not deliver unsafe blocks. | MET | Parser, normalizer, and worker tests cover no-promo, invalid JSON, out-of-bounds timestamps, open-ended duration overrun, and full-video degenerate rejection; background runtime tests cover non-delivery for terminal model errors. |
| 4 | Given normalized blocks are ready, When the extension polls the job status, Then it receives ready blocks through the server-result path. | MET | `BackendAnalysisJobs.getStatus` runs analysis and returns `ready`; API/HTTP tests verify `GET /v1/analysis/jobs/{jobId}` returns ready blocks; `ServerAnalysisRuntimeMessages.applyServerResponse` delivers ready blocks via `PROMO_BLOCKS_DETECTED`. |

## Entity Status

| Entity | Fields | Relationships | Validation | Status |
| --- | --- | --- | --- | --- |
| Backend LLM Analysis Adapter | OK | OK | OK | PASS |
| Analysis Run Artifact | OK | OK | OK | PASS |
| Parsed Model Promo Result | OK | OK | OK | PASS |
| Normalized Promo Blocks | OK | OK | OK | PASS |
| Analysis Job Record | OK | OK | OK | PASS |
| Terminal Analysis Response | OK | OK | OK | PASS |

## Contract Status

| Endpoint | Method | Status | Notes |
| --- | --- | --- | --- |
| `/v1/analysis` | POST | PASS | Existing endpoint returns `202 processing` for supported uncached cold jobs, carrying `durationSec` into the job record. |
| `/v1/analysis/jobs/{jobId}` | GET | PASS | Existing status endpoint runs pending analysis and returns worker-produced `ready` or `no_promo` responses. |
| `/v1/analysis/jobs/{jobId}/fixture-result` | POST | PASS | Existing fixture override remains available and does not replace an already completed worker result. |

## Guidelines Compliance

| Guideline | Status | Notes |
| --- | --- | --- |
| TypeScript strict and `.ts`/`.tsx` source files | COMPLIANT | New implementation files are TypeScript; direct `tsc --noEmit` passed. |
| Use Valibot at untrusted boundaries | COMPLIANT | Request/response, provider metadata, raw model output, terminal responses, and analysis run artifacts are validated with Valibot schemas. |
| Keep I/O out of `src/shared/` | COMPLIANT | Backend worker, adapter, parser, and normalizer live under `src/backend/analysis`; shared changes are limited to serialized response contract values. |
| Use `browser.*` through shared browser wrapper | N/A | Backend analysis code does not call extension APIs; runtime-message code continues importing `@/shared/browser`. |
| Runtime messaging/storage separation | COMPLIANT | Extension status delivery remains in background runtime messaging; no content/popup direct storage was added for this issue. |
| Static-only classes for grouped concerns | COMPLIANT | `BackendPromoAnalysisWorker`, `BackendAnalysisJobs`, and `BackendAnalysisApi` use the repository's static class pattern where appropriate. |
| Guard-style control flow and shallow nesting | COMPLIANT | Direct ESLint passed for the issue-owned backend/shared/background files and related tests. |
| JSDoc requirements under `src/` | COMPLIANT | Direct ESLint passed with the repository JSDoc rules. |
| No hardcoded UI strings introduced | N/A | This issue does not add user-visible UI text in React/content UI. |

## Issues Found

None for issue `7-AFK`.

Unrelated workspace blocker observed during validation:

1. **pnpm command path is blocked by ignored build approval**
   - Location: package manager state, not issue code.
   - Description: `pnpm run test ...` failed before Vitest with `ERR_PNPM_IGNORED_BUILDS` for `esbuild@0.27.7`.
   - Impact: Standard `pnpm run ...` commands cannot be used until build approval state is resolved.
   - Recommendation: Resolve the package-manager approval state separately; validation used direct local binaries without changing approval state.

## Verification Results

- `pnpm run test tests/shared/server-analysis-contract.test.ts tests/backend/promo-analysis-worker.test.ts tests/backend/analysis-jobs.test.ts tests/backend/analysis-api.test.ts tests/backend/server.test.ts tests/background/messaging/server-analysis-runtime-messages.test.ts` - BLOCKED before tests by unrelated `ERR_PNPM_IGNORED_BUILDS` for `esbuild@0.27.7`.
- `./node_modules/.bin/vitest run tests/shared/server-analysis-contract.test.ts tests/backend/promo-analysis-worker.test.ts tests/backend/analysis-jobs.test.ts tests/backend/analysis-api.test.ts tests/backend/server.test.ts tests/background/messaging/server-analysis-runtime-messages.test.ts` - PASS, 6 files / 84 tests.
- `./node_modules/.bin/tsc --noEmit` - PASS.
- `./node_modules/.bin/oxlint --jsdoc-plugin --react-plugin --vitest-plugin src/backend/analysis src/backend/analysis-jobs.ts src/backend/analysis-api.ts src/shared/server-analysis-contract.ts src/background/messaging/server-analysis-runtime-messages.ts tests/backend tests/shared/server-analysis-contract.test.ts tests/background/messaging/server-analysis-runtime-messages.test.ts` - PASS.
- `./node_modules/.bin/eslint src/backend/analysis src/backend/analysis-jobs.ts src/backend/analysis-api.ts src/shared/server-analysis-contract.ts src/background/messaging/server-analysis-runtime-messages.ts tests/backend tests/shared/server-analysis-contract.test.ts tests/background/messaging/server-analysis-runtime-messages.test.ts` - PASS.
- `./node_modules/.bin/oxfmt --check src/backend/analysis/promo-analysis-types.ts src/backend/analysis/promo-response-parser.ts src/backend/analysis/promo-block-normalization.ts src/backend/analysis/local-analysis-fixtures.ts src/backend/analysis/promo-analysis-worker.ts src/backend/analysis-jobs.ts src/backend/analysis-api.ts src/shared/server-analysis-contract.ts src/background/messaging/server-analysis-runtime-messages.ts tests/backend/promo-analysis-worker.test.ts tests/backend/analysis-jobs.test.ts tests/backend/analysis-api.test.ts tests/backend/server.test.ts tests/shared/server-analysis-contract.test.ts tests/background/messaging/server-analysis-runtime-messages.test.ts` - PASS.

## Recommendations

- Proceed with issue `7-AFK` as validated.
- Resolve the unrelated pnpm approval state outside this issue so normal `pnpm run ...` gates are usable again.
