# Issue Validation Report: Subtitle Extraction Pipeline with First Local Strategy

- **Validated**: 2026-07-07
- **Model**: GPT-5 Codex
- **Issue**: `.sdd/.current/issues/6-AFK/issue.md`
- **Plan**: `.sdd/.current/issues/6-AFK/plan.md`
- **Validation attempt**: 1

## Summary

| Category | Pass | Partial | Fail | Total |
| --- | --- | --- | --- | --- |
| Tasks | 7 | 0 | 0 | 7 |
| Acceptance Criteria | 4 | 0 | 0 | 4 |
| Entities | 5 | 0 | 0 | 5 |
| Contracts | 3 | 0 | 0 | 3 |
| Guidelines | 8 | 0 | 0 | 8 |

**Overall Status**: COMPLETE

Issue-scoped validation found no implementation defects. The pnpm package-script entrypoints are currently blocked before execution by unrelated workspace dependency approval state for `esbuild@0.27.7`; direct local tool invocations passed and are recorded below.

## Verification Results

| Command | Result | Notes |
| --- | --- | --- |
| `pnpm run test tests/shared/server-analysis-contract.test.ts tests/backend/subtitle-extraction-pipeline.test.ts tests/backend/analysis-jobs.test.ts tests/backend/analysis-api.test.ts tests/backend/server.test.ts` | BLOCKED | Did not reach Vitest; pnpm aborted with `ERR_PNPM_IGNORED_BUILDS` for `esbuild@0.27.7`. |
| `./node_modules/.bin/vitest run tests/shared/server-analysis-contract.test.ts tests/backend/subtitle-extraction-pipeline.test.ts tests/backend/analysis-jobs.test.ts tests/backend/analysis-api.test.ts tests/backend/server.test.ts` | PASS | 5 test files, 53 tests passed. |
| `./node_modules/.bin/vitest run` | PASS | 68 test files, 455 tests passed. |
| `pnpm run lint:types` | BLOCKED | Same pnpm `ERR_PNPM_IGNORED_BUILDS` blocker before `tsc` execution. |
| `./node_modules/.bin/tsc --noEmit` | PASS | TypeScript accepted the implementation. |
| `pnpm run lint:md` | BLOCKED | Same pnpm `ERR_PNPM_IGNORED_BUILDS` blocker before markdownlint execution. |
| `./node_modules/.bin/markdownlint-cli2 "**/*.md" "#node_modules" "#dist" "#coverage" "#.sdd" "#test-results" "#tmp"` | PASS | 5 markdown files checked, 0 errors. |
| `./node_modules/.bin/oxlint --jsdoc-plugin --react-plugin --vitest-plugin .` | PASS | 0 warnings, 0 errors. |
| `./node_modules/.bin/eslint .` | PASS | No errors. |
| `./node_modules/.bin/oxfmt --check src/shared/server-analysis-contract.ts src/backend/extraction/subtitle-extraction-types.ts src/backend/extraction/local-transcript-fixtures.ts src/backend/extraction/subtitle-extraction-pipeline.ts src/backend/analysis-jobs.ts src/backend/analysis-api.ts tests/shared/server-analysis-contract.test.ts tests/backend/subtitle-extraction-pipeline.test.ts tests/backend/analysis-jobs.test.ts tests/backend/analysis-api.test.ts tests/backend/server.test.ts` | PASS | All issue files use the correct format. |
| `./node_modules/.bin/oxfmt --check .` | BLOCKED | Only `pnpm-workspace.yaml` failed formatting; that file is untracked and unrelated to this issue. |
| `./node_modules/.bin/rspack build --config rspack.config.ts` | PASS | Build completed with existing bundle-size warnings for popup/options assets. |

## Task Status

- [x] **Task 1: Shared Unavailable Reason Contract** - PASS. `SERVER_ANALYSIS_UNAVAILABLE_REASON` includes `caption_extraction_failed`, `unavailableResponseSchema` accepts only named reasons, and tests cover extraction unavailable plus rejection of unknown reasons (`src/shared/server-analysis-contract.ts`, `tests/shared/server-analysis-contract.test.ts`).
- [x] **Task 2: Backend Extraction Entity Types** - PASS. Backend-local schemas and types validate attempts and selected transcript artifacts, including empty transcript rejection (`src/backend/extraction/subtitle-extraction-types.ts`, `tests/backend/subtitle-extraction-pipeline.test.ts`).
- [x] **Task 3: Deterministic Local Transcript Strategy** - PASS. `LocalTranscriptFixtureStrategy` returns deterministic transcripts for the two supported fixture video IDs and a structured `fixture_not_found` miss for unsupported videos (`src/backend/extraction/local-transcript-fixtures.ts`, `tests/backend/subtitle-extraction-pipeline.test.ts`).
- [x] **Task 4: Subtitle Extraction Pipeline Runner** - PASS. `BackendSubtitleExtractionPipeline.extract` runs strategies in order, records attempts, validates selected artifacts, maps timeout/error/invalid transcript outcomes, and stores safe diagnostics only (`src/backend/extraction/subtitle-extraction-pipeline.ts`, `tests/backend/subtitle-extraction-pipeline.test.ts`).
- [x] **Task 5: Job Store Extraction Integration** - PASS. `BackendAnalysisJobs.start` runs extraction once, stores selected transcript artifacts and attempts, exposes test diagnostics, and terminally completes extraction failures as `unavailable` without overwriting diagnostics (`src/backend/analysis-jobs.ts`, `tests/backend/analysis-jobs.test.ts`).
- [x] **Task 6: API and HTTP Behavior** - PASS. Unsupported local videos return HTTP/API `200 unavailable`, supported fixtures continue as `202 processing`, and rate-limited cold starts do not create extraction diagnostics (`src/backend/analysis-api.ts`, `tests/backend/analysis-api.test.ts`, `tests/backend/server.test.ts`).
- [x] **Task 7: Focused Verification** - PASS. Direct local equivalents of the required focused suite, typecheck, markdown lint, issue-file formatting, lint components, full Vitest suite, and build all passed. The pnpm wrapper blocker is unrelated to the issue implementation.

## Acceptance Criteria Status

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Given a video is supported by the first local extraction strategy, When a cold analysis job reaches extraction, Then the backend stores an ordered timed transcript artifact and marks that strategy as successful. | MET | Local fixture segments are deterministic and ordered; job diagnostics show `awaiting_analysis`, selected artifact segments, and a succeeded `local_transcript_fixture` attempt. Covered by `tests/backend/subtitle-extraction-pipeline.test.ts` and `tests/backend/analysis-jobs.test.ts`. |
| 2 | Given the first extraction strategy cannot produce a usable transcript, When the job runs, Then the backend records a stage-specific failure reason. | MET | Unsupported videos record `fixture_not_found`; empty transcripts record `empty_transcript`; unordered and strategy error/timeout paths map to stable failure reasons in the pipeline. Covered by `tests/backend/subtitle-extraction-pipeline.test.ts` and `tests/backend/analysis-jobs.test.ts`. |
| 3 | Given all configured extraction strategies fail in this slice, When the job completes, Then the backend stores an unavailable result and the extension does not skip for that reason. | MET | `BackendAnalysisJobs.runExtraction` stores terminal `unavailable` with `caption_extraction_failed`; API/HTTP tests assert `200 unavailable`. Extension background handling only sends `PROMO_BLOCKS_DETECTED` for `ready`, while `unavailable` updates detection state and returns a terminal ack without content delivery. |
| 4 | Given extraction diagnostics are recorded, When maintainers inspect the job, Then no cookies, account tokens, extension secrets, or unredacted credential material are present. | MET | Attempt diagnostics store stable `code` values only; thrown error text is discarded. The pipeline test throws `cookie=secret-token should not be stored` and asserts serialized results do not contain `secret-token`. |

## Entity Status

| Entity | Fields | Relationships | Validation | Status |
| --- | --- | --- | --- | --- |
| Subtitle Extraction Strategy | OK - `name` and `extract(input)` contract exist. | OK - default registry uses `LocalTranscriptFixtureStrategy`; tests inject custom strategies. | OK - strategy output is normalized and candidate artifacts are parsed before selection. | PASS |
| Extraction Attempt | OK - strategy, status, timestamps, failure reason, and diagnostics are present. | OK - stored on each job record until selection or exhaustion. | OK - Valibot schema bounds status, failure reasons, timestamps, and diagnostics. | PASS |
| Transcript Artifact | OK - artifact id, video id, version, strategy, source, language, timed segments, text, and timestamp are present. | OK - selected by extraction pipeline and stored on job diagnostics for later analysis. | OK - rejects empty text/segments and unordered starts before selection. | PASS |
| Analysis Job Record | OK - stage, attempts, selected artifact, timestamps, processing response, and terminal response are present. | OK - `start`, `findExisting`, `getStatus`, and fixture completion preserve dedupe semantics. | OK - supported extraction leaves `awaiting_analysis`; failed extraction completes terminally without promo blocks. | PASS |
| Extraction Unavailable Response | OK - status, video id, algorithm version, reason, and message are present. | OK - returned by `POST /v1/analysis` and job reads through the existing response union. | OK - `caption_extraction_failed` is allowed and unknown unavailable reasons are rejected. | PASS |

## Contract Status

| Endpoint | Method | Status | Notes |
| --- | --- | --- | --- |
| Shared `ServerAnalysisResponse` union | N/A | PASS | The union accepts `unavailable` responses with `caption_extraction_failed` and rejects unknown unavailable reasons. |
| `/v1/analysis` | POST | PASS | Supported fixture videos return `202 processing`; unsupported videos with no transcript return `200 unavailable`; rate-limited requests return `429` without creating extraction diagnostics. |
| `/v1/analysis/jobs/{jobId}` | GET | PASS | Polling returns existing processing or terminal responses through the unchanged job response mapping. |

## Guidelines Compliance

| Guideline | Status | Notes |
| --- | --- | --- |
| Keep backend-owned I/O and extraction concerns outside `src/shared/`. | COMPLIANT | Extraction types, fixtures, and pipeline live under `src/backend/extraction`; only serialized response reasons remain in `src/shared/server-analysis-contract.ts`. |
| Validate boundaries with Valibot and keep TypeScript strict. | COMPLIANT | Request/response, attempt, and artifact schemas parse untrusted data; `./node_modules/.bin/tsc --noEmit` passed. |
| Use static API classes for multi-step backend orchestration modules. | COMPLIANT | `BackendSubtitleExtractionPipeline`, `BackendAnalysisJobs`, and `BackendAnalysisApi` follow the existing static API pattern. |
| Prefer guard clauses and shallow control flow. | COMPLIANT | Pipeline, job, and API paths use early returns for existing jobs, invalid requests, cache hits, rate limits, and terminal states. |
| Store safe diagnostics and avoid secrets in logs/artifacts. | COMPLIANT | Extraction attempts persist stable codes, not thrown messages, stack traces, cookies, or tokens. |
| Use `@/...` imports and TypeScript source files only. | COMPLIANT | New source and tests are `.ts` files and use the project alias. |
| Cover backend/shared behavior with mirrored Vitest tests. | COMPLIANT | Focused tests cover contract, extraction, job store, API, and HTTP behavior. Full local Vitest suite passed. |
| Formatting and linting remain clean for issue files. | COMPLIANT | Issue files pass `oxfmt --check`; direct `oxlint`, `eslint`, `tsc`, and markdownlint passed. Whole-repo `oxfmt --check .` is blocked only by unrelated untracked `pnpm-workspace.yaml`. |

## Issues Found

No issue-caused findings.

## Unrelated Workspace Blockers

1. **pnpm package-script preflight is blocked by ignored build approval**
   - Location: pnpm dependency state, `esbuild@0.27.7`
   - Description: `pnpm run test`, `pnpm run lint:types`, and `pnpm run lint:md` abort before running their target scripts with `ERR_PNPM_IGNORED_BUILDS`.
   - Impact: Package-script quality gates cannot be observed through pnpm until the workspace approval state is resolved. Direct local binaries passed.
   - Recommendation: Resolve dependency approval separately with the repository's intended `pnpm approve-builds` workflow; do not treat this as a `6-AFK` implementation failure.

2. **Untracked workspace file fails whole-repo format check**
   - Location: `pnpm-workspace.yaml`
   - Description: `./node_modules/.bin/oxfmt --check .` reports formatting only for the untracked file containing `allowBuilds` placeholder text.
   - Impact: Whole-repo format check fails, but all issue files pass formatting.
   - Recommendation: Decide separately whether to remove, format, or complete this workspace approval file.

## Recommendations

- Keep `6-AFK` marked as validated.
- Resolve the unrelated pnpm/esbuild approval and untracked `pnpm-workspace.yaml` state before relying on pnpm package-script gates for later pipeline stages.
