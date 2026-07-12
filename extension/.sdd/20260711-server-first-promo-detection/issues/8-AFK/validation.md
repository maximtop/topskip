# Issue Validation Report: Artifact store for success and failure history

- **Validated**: 2026-07-08
- **Model**: GPT-5 Codex
- **Issue**: `.sdd/.current/issues/8-AFK/issue.md`
- **Plan**: `.sdd/.current/issues/8-AFK/plan.md`
- **Validation attempt**: 1

## Summary

| Category | Pass | Partial | Fail | Total |
| --- | --- | --- | --- | --- |
| Tasks | 7 | 0 | 0 | 7 |
| Acceptance Criteria | 4 | 0 | 0 | 4 |
| Entities | 4 | 0 | 0 | 4 |
| Contracts | 0 | 0 | 0 | 0 |
| Guidelines | 7 | 0 | 0 | 7 |

**Overall Status**: COMPLETE

## Task Status

- [x] **Task 1**: Artifact Record Schema and Redaction - PASS. `src/backend/analysis-artifact-store.ts` defines `analysisArtifactRecordSchema`, `analysisOperationalMetadataSchema`, redaction, and ready-record cross-field validation; `tests/backend/analysis-artifact-store.test.ts` verifies redaction and rejects ready records without transcript and analysis artifacts.
- [x] **Task 2**: In-Memory Repository Interface - PASS. `AnalysisArtifactStore.save`, `findHistory`, `findLatestReady`, `snapshotForTests`, and `resetForTests` are implemented with defensive clones and exact algorithm-version lookup; tests verify versioned history and defensive copies.
- [x] **Task 3**: Persist Extraction Failure History - PASS. `BackendAnalysisJobs.runExtraction` persists terminal unavailable records with extraction attempts, retry/join metadata, and final status; `tests/backend/analysis-jobs.test.ts` verifies extraction failure history.
- [x] **Task 4**: Persist Ready, No-Promo, and Error Analysis History - PASS. `BackendAnalysisJobs.runAnalysis` persists completed worker records including transcript and analysis run artifacts; tests verify ready and no-promo worker history with raw/parsed/normalized output.
- [x] **Task 5**: Persist Only Debug-Safe Fixture Completion Overrides - PASS. `persistArtifactRecordIfValid` stores non-ready fixture completions and skips fixture `ready` completions without an analysis run; tests verify both paths and cache ineligibility.
- [x] **Task 6**: Serve Ready Cache Hits from Artifact History - PASS. `BackendAnalysisApi.handleAnalysisRequest` checks `AnalysisArtifactStore.findLatestReady` after fixture cache and before job join/cold start; API and HTTP tests verify worker-backed cache hits and fixture-ready misses.
- [x] **Task 7**: Full Focused Verification - PASS. Focused backend tests, TypeScript, oxlint, ESLint, markdownlint, and issue-scoped formatting passed. Repository-wide `pnpm run lint` currently stops on formatting for untracked `pnpm-workspace.yaml`, which is outside this issue's implementation files.

## Acceptance Criteria Status

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Given a server analysis succeeds, When the job completes, Then the artifact store records video metadata, transcript source, transcript text, prompt/model versions, raw model response, parsed blocks, normalized blocks, and timing/cost metadata. | MET | `src/backend/analysis-jobs.ts` persists worker completions through `AnalysisArtifactStore.save`; `src/backend/analysis-artifact-store.ts` stores video/job/extraction/transcript/analysis/terminal/metadata fields and enforces ready artifact integrity. `tests/backend/analysis-jobs.test.ts` verifies successful analysis artifacts with transcript and model output. |
| 2 | Given a server analysis fails, When the job completes, Then the artifact store records extraction attempts, failure reasons, provider/model errors when applicable, retry metadata, and final user-facing status. | MET | Extraction failures are persisted from `runExtraction`; worker terminal failures are represented by `analysisRun.failureReason` and terminal responses. Tests cover extraction failure history, no-promo history, and non-ready fixture completion history. |
| 3 | Given a new algorithm version analyzes the same video, When the result is stored, Then it is recorded alongside version metadata rather than destructively overwriting the previous version. | MET | `AnalysisArtifactStore.findHistory` filters by video and optional algorithm version while storing records by record ID. `tests/backend/analysis-artifact-store.test.ts` verifies multiple algorithm versions are preserved and `findLatestReady` returns the requested version. |
| 4 | Given stored artifacts include operational metadata, When redaction rules are applied, Then secrets, cookies, extension-local API keys, and YouTube account tokens are not persisted. | MET | `AnalysisArtifactStore.redactOperationalMetadata` redacts sensitive diagnostic keys and token-shaped values before validation/storage. Tests verify bearer/API-key and cookie-like values are replaced with `[REDACTED]`. |

## Entity Status

| Entity | Fields | Relationships | Validation | Status |
| --- | --- | --- | --- | --- |
| Analysis Artifact Repository | OK | Called by `BackendAnalysisJobs`; queried by `BackendAnalysisApi` | Valibot parse on save and defensive clone on read | PASS |
| Analysis Artifact Record | OK | Combines job, extraction, transcript, analysis, terminal response, and metadata | Ready records require transcript plus analysis run and matching normalized blocks | PASS |
| Operational Metadata | OK | Stored inside artifact records | Redacts sensitive keys and values before persistence | PASS |
| Artifact Cache Lookup | OK | Reads latest ready artifacts for API cache hits | Exact video/version match and only validated ready records are returned | PASS |

## Contract Status

| Endpoint | Method | Status | Notes |
| --- | --- | --- | --- |
| N/A | N/A | N/A | No new public HTTP or extension API contract files are required for this issue. Existing `/v1/analysis` behavior is covered by API and server tests. |

## Guidelines Compliance

| Guideline | Status | Notes |
| --- | --- | --- |
| Backend ownership | COMPLIANT | Artifact store and persistence live under `src/backend/`; no extension-facing storage or API contract changes were added. |
| Structured validation | COMPLIANT | Valibot schemas validate artifact records, metadata, terminal responses, transcript artifacts, and analysis runs at boundaries. |
| Static API class pattern | COMPLIANT | `AnalysisArtifactStore`, `BackendAnalysisJobs`, and `BackendAnalysisApi` use static APIs consistent with repository style. |
| TypeScript strict and no unsafe assertions | COMPLIANT | `pnpm run lint:types` passed, and lint checks reported no assertion/style violations in the implementation. |
| Secret redaction | COMPLIANT | Store-level redaction covers sensitive diagnostic keys and token-shaped values before persistence. |
| Scoped implementation | COMPLIANT | Changes are limited to backend artifact storage, job completion persistence, API cache lookup, and focused backend tests. |
| Formatting and linting | COMPLIANT | Issue files pass `oxfmt --check`; `lint:ox`, `lint:eslint`, `lint:md`, and `lint:types` pass. Full `pnpm run lint` is blocked by unrelated untracked `pnpm-workspace.yaml` formatting. |

## Issues Found

1. **Repository-wide lint is blocked outside the issue scope**
   - Location: `pnpm-workspace.yaml`
   - Description: `pnpm run lint` stops during `format:check` because untracked `pnpm-workspace.yaml` is not formatted according to `oxfmt`.
   - Impact: This prevents a clean repository-wide lint result in the current worktree, but the issue implementation files and all remaining lint components pass.
   - Recommendation: Format or remove the unrelated untracked workspace file before relying on a full-worktree lint signal.

## Recommendations

- No issue implementation fixes are required.
- Before final PR handoff, clean up or format the unrelated `pnpm-workspace.yaml` worktree item so `pnpm run lint` can complete end to end.
