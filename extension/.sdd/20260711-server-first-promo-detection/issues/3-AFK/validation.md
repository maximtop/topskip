# Issue Validation Report: Extension local result cache

- **Validated**: 2026-07-06
- **Model**: GPT-5 Codex
- **Issue**: `.sdd/.current/issues/3-AFK/issue.md`
- **Plan**: `.sdd/.current/issues/3-AFK/plan.md`
- **Validation attempt**: 1

## Summary

| Category | Pass | Partial | Fail | Total |
| --- | --- | --- | --- | --- |
| Tasks | 5 | 0 | 0 | 5 |
| Acceptance Criteria | 4 | 0 | 0 | 4 |
| Entities | 3 | 0 | 0 | 3 |
| Contracts | 1 | 0 | 0 | 1 |
| Guidelines | 8 | 1 | 0 | 9 |

**Overall Status**: COMPLETE

Issue-scoped implementation and behavior are complete. The formal `pnpm run *`
entrypoints are currently blocked before script execution by unrelated workspace
dependency-approval state for `esbuild@0.27.7`; direct execution of the same
underlying tools passed except `oxfmt --check .`, which reports only the
untracked `pnpm-workspace.yaml` placeholder.

## Task Status

- [x] **Task 1: Extend Ready Responses With Cache Metadata** - PASS
  - Evidence: `readyResponseSchema` now requires `sourceResultId` and
    `freshness` in `src/shared/server-analysis-contract.ts:103-121`;
    backend fixtures include deterministic cache metadata in
    `src/backend/cache-fixtures.ts:17-24`; contract/backend/client tests passed
    in the focused Vitest suite.
- [x] **Task 2: Add Background Local Result Cache Storage** - PASS
  - Evidence: `STORAGE_KEY_SERVER_RESULT_CACHE` exists in
    `src/shared/constants.ts:33-36`; `ServerResultCacheStorage` validates,
    loads, expires, repairs, and saves cache rows in
    `src/background/storage/server-result-cache.ts:23-141`; storage tests cover
    fresh hit, stale miss, corrupt miss, version mismatch, read failure, repair
    failure, and save in
    `tests/background/storage/server-result-cache.test.ts:36-173`.
- [x] **Task 3: Use Cache Before Backend Requests And Save Ready Results** - PASS
  - Evidence: runtime lookup happens before backend request in
    `src/background/messaging/server-analysis-runtime-messages.ts:78-97`; fresh
    local hits deliver `PROMO_BLOCKS_DETECTED` with source `local_cache` at
    `src/background/messaging/server-analysis-runtime-messages.ts:83-90`;
    video/version guards run before ready save/delivery at
    `src/background/messaging/server-analysis-runtime-messages.ts:99-122`; ready
    save failures are non-fatal at
    `src/background/messaging/server-analysis-runtime-messages.ts:124-137`.
- [x] **Task 4: Add No-Backend Fixture Coverage For Fresh Local Cache** - PASS
  - Evidence: e2e seeds a fresh storage row in
    `e2e/extension.spec.ts:124-175`; the no-backend test verifies playback skips
    beyond the cached block without starting a backend in
    `e2e/extension.spec.ts:511-570`; Playwright passed all 11 extension tests.
- [x] **Task 5: Run Focused Regression Checks** - PASS
  - Evidence: direct focused Vitest suite passed 9 files / 61 tests; direct full
    Vitest suite passed 65 files / 402 tests; coverage passed; direct Rspack
    build passed with existing bundle-size warnings; Playwright passed 11 tests.
    Formal `pnpm run test`, `pnpm run build`, and `pnpm run lint` are blocked by
    unrelated pnpm esbuild approval state before invoking project scripts.

## Acceptance Criteria Status

| # | Criterion | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Given a fresh local cache entry for the current video and algorithm version, server mode applies cached promo blocks without a backend request. | MET | Runtime checks `ServerResultCacheStorage.loadFresh` before `ServerAnalysisClient.requestAnalysis` in `src/background/messaging/server-analysis-runtime-messages.ts:78-97`; test asserts no backend call and `local_cache` delivery in `tests/background/messaging/server-analysis-runtime-messages.test.ts:97-128`; e2e no-backend path passes in `e2e/extension.spec.ts:511-570`. |
| 2 | Given a stale local cache entry, server mode ignores it and requests a fresh backend result. | MET | Storage treats `freshness.expiresAtMs <= nowMs` as miss and removes the row in `src/background/storage/server-result-cache.ts:105-113`; stale-miss test verifies `null` plus `storageRemove` in `tests/background/storage/server-result-cache.test.ts:61-80`; runtime miss path continues to backend in `src/background/messaging/server-analysis-runtime-messages.ts:93-97`. |
| 3 | Given ready server blocks with freshness metadata, the extension stores a validated local cache entry. | MET | Ready response schema requires metadata in `src/shared/server-analysis-contract.ts:103-121`; runtime saves accepted ready responses in `src/background/messaging/server-analysis-runtime-messages.ts:124-129`; storage revalidates and writes rows in `src/background/storage/server-result-cache.ts:125-140`; save test verifies row shape in `tests/background/storage/server-result-cache.test.ts:149-173`. |
| 4 | Given a corrupt cache entry or another algorithm/cache version, reads do not apply the entry. | MET | Storage parses untrusted rows and removes corrupt/mismatched rows in `src/background/storage/server-result-cache.ts:97-113`; tests cover corrupt rows and algorithm-version mismatches in `tests/background/storage/server-result-cache.test.ts:83-118`. |

## Entity Status

| Entity | Fields | Relationships | Validation | Status |
| --- | --- | --- | --- | --- |
| Ready Response Freshness | `expiresAtMs` present and finite positive integer in `readyResponseFreshnessSchema`. | Nested in ready backend responses and local cache entries. | Valibot strict object in `src/shared/server-analysis-contract.ts:93-108`; non-finite rejection tested. | PASS |
| Ready Response | `status`, `videoId`, `algorithmVersion`, `source`, `sourceResultId`, `freshness`, `promoBlocks` present. | Returned by backend/client, guarded by runtime, saved by cache storage, delivered to content. | Schema validation plus runtime video/version guards in `src/background/messaging/server-analysis-runtime-messages.ts:99-122`. | PASS |
| Local Server Result Cache Entry | `videoId`, `algorithmVersion`, `sourceResultId`, `freshness`, `promoBlocks`, `storedAtMs` present. | Stored in `browser.storage.local`, loaded by background runtime before backend request. | Strict schema and freshness/version checks in `src/background/storage/server-result-cache.ts:23-113`. | PASS |

## Contract Status

| Endpoint | Method | Status | Notes |
| --- | --- | --- | --- |
| `/v1/analysis` | POST | PASS | OpenAPI `ReadyResponse` requires `sourceResultId`, `freshness`, and `promoBlocks` at `.sdd/.current/issues/3-AFK/contracts/openapi.yaml:83-117`; implementation schema and tests match. |

## Guidelines Compliance

| Guideline | Status | Notes |
| --- | --- | --- |
| Background-only storage ownership | COMPLIANT | New cache storage lives under `src/background/storage/server-result-cache.ts`; content/popup use runtime messaging, with e2e-only direct storage seeding confined to test code. |
| Valibot validation at boundaries | COMPLIANT | Ready responses and stored rows are validated with strict Valibot schemas before use or persistence. |
| Shared module boundaries | COMPLIANT | Shared changes are constants, runtime message types, and pure schemas; storage I/O stays in background. |
| `browser.*` abstraction | COMPLIANT | Implementation imports `browser` from `@/shared/browser`, not global `chrome`, outside test-only e2e seeding. |
| Static-only background module style | COMPLIANT | `ServerResultCacheStorage` and `ServerAnalysisRuntimeMessages` use class static APIs and no empty constructors. |
| TypeScript strict / no unsafe assertions in source | COMPLIANT | Source avoids `any`; dynamic storage access uses `unknown` plus validation and `Reflect.get`. |
| JSDoc and comments | COMPLIANT | New exported schema/type/class/methods include JSDoc, and comments explain cache failure constraints. |
| Focused tests for new behavior | COMPLIANT | Unit and e2e tests cover all issue-listed automated cases. |
| Repository command gates | PARTIAL | Direct tools passed for tests, coverage, build, TypeScript, ESLint, oxlint, and markdownlint. Formal `pnpm run *` scripts are blocked before execution by unrelated `esbuild@0.27.7` approval state; direct `oxfmt --check .` fails only on untracked `pnpm-workspace.yaml`. |

## Issues Found

None caused by the 3-AFK implementation.

Unrelated workspace blockers:

1. **pnpm approval state blocks formal script entrypoints**
   - Location: workspace dependency state / untracked `pnpm-workspace.yaml`
   - Description: `pnpm run test`, `pnpm run build`, and `pnpm run lint` stop
     before invoking project scripts with `[ERR_PNPM_IGNORED_BUILDS] Ignored
     build scripts: esbuild@0.27.7`.
   - Impact: Formal repository commands cannot currently be used as written,
     but direct underlying commands validate the issue implementation.
   - Recommendation: Resolve the pending `pnpm approve-builds` decision for
     `esbuild@0.27.7` and replace or remove the placeholder
     `pnpm-workspace.yaml`.

2. **Formatting check fails on unrelated untracked workspace file**
   - Location: `pnpm-workspace.yaml`
   - Description: `./node_modules/.bin/oxfmt --check .` reports formatting only
     for `pnpm-workspace.yaml`.
   - Impact: The repository-wide formatting check is red independent of 3-AFK
     implementation files.
   - Recommendation: Format or remove the untracked workspace approval file when
     resolving the pnpm approval state.

## Recommendations

- No implementation changes are required for 3-AFK.
- Resolve the unrelated pnpm/esbuild approval state before relying on formal
  `pnpm run *` gates in subsequent pipeline stages.
