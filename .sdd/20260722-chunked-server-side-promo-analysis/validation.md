# Quick Validation Report: Chunked server-side promo analysis with overlapping chunks

- **Validated**: 2026-07-22
- **Model**: Claude Opus 4.8
- **Spec**: `.sdd/20260722-chunked-server-side-promo-analysis/quick.md`
- **Type**: Quick Spec

> **Validation mode note**: at validation time `.sdd/.current/` also contained
> `spec.md` + `plan.md`, which would normally select Full Validation. Those two
> files describe a **different feature** ("Extension-Captured Transcripts for
> Server Analysis", created 2026-07-17) and predate this work by four days. The
> "prefer Full Validation because quick.md is likely outdated" heuristic is
> inverted here, so this validation ran against `quick.md`, the current work.
> Resolved during finalization — see Issue 2.

## Summary

| Category | Pass | Fail | Total |
| -------- | ---- | ---- | ----- |
| Affected Files | 15 | 0 | 15 |
| Tasks | 7 | 0 | 7 |
| Guidelines | 12 | 0 | 12 |
| Verification Steps | 4 | 0 | 6 (2 not verifiable) |

**Overall Status**: COMPLETE

All 7 tasks are implemented and verified; every automated gate is green
(`pnpm test` 837/837, `pnpm lint` 0 errors, `pnpm build`, format check). Two
verification steps could not be executed — one intentionally (paid API calls),
one blocked by a pre-existing environment problem unrelated to this change.
Neither indicates a defect in the implementation. See Issues 1 and 3.

## Affected Files Status

| File | Expected Change | Status |
| ---- | --------------- | ------ |
| `common/src/promo-chunking-config.ts` | Create — shared tunables | MODIFIED (created; 5 exported constants) |
| `common/src/promo-chunk-planner.ts` | Create (move) — planner with lines+options API | MODIFIED (created; exports `TimedLine`, `ChunkOverlapPolicy`, `ChunkPlanOptions`, `ChunkPlanner`) |
| `common/src/promo-chunk-merge.ts` | Create (move) — `ChunkMerge` | MODIFIED (created) |
| `extension/src/background/messaging/chunk-planner.ts` | Delete | MODIFIED (deleted) |
| `extension/src/background/messaging/chunk-merge.ts` | Delete | MODIFIED (deleted) |
| `extension/src/background/messaging/chunk-plan-config.ts` | Keep BYOK tunables; re-export shared | MODIFIED (re-exports shared; 0 local duplicate declarations) |
| `extension/src/background/messaging/promo-analysis.ts` | New planner call + common imports | MODIFIED (imports `@topskip/common/promo-chunk-planner`; call site passes lines + dynamic overlap) |
| `backend/src/analysis/promo-analysis-chunking.ts` | Create — server chunk plan | MODIFIED (created; fixed 240 s / 60k budget) |
| `backend/src/analysis/promo-analysis-worker.ts` | Chunk loop, retry, filter+merge, usage sum | MODIFIED (loop + `analyzeChunkWithRetry` + `sumUsage`) |
| `common/src/server-analysis-contract.ts` | Version → `server-v6` | MODIFIED |
| `common/tests/promo-chunk-planner.test.ts` | Create (move) + fixed-overlap cases | MODIFIED (created; 9 tests) |
| `common/tests/promo-chunk-merge.test.ts` | Create (move) | MODIFIED (created; 7 tests) |
| `backend/tests/promo-analysis-chunking.test.ts` | Create | MODIFIED (created; 2 tests) |
| `backend/tests/promo-analysis-worker-chunking.test.ts` | Create | MODIFIED (created; 4 tests) |
| 13 test files + `backend/src/cache-fixtures.ts` hardcoding `server-v5` | Bump to `server-v6` | MODIFIED (0 `server-v5` literals remain repo-wide) |

Old extension test files (`chunk-planner.test.ts`, `chunk-merge.test.ts`) were
deleted after their contents moved to `common/tests/`. No stale imports of the
deleted modules remain (`grep` for `messaging/chunk-planner|messaging/chunk-merge`
returns nothing).

## Task Status

- [x] **Task 1**: Shared chunking config in `common/` — PASS. All five constants
      present with spec values (`BLOCK_MERGE_GAP_SEC=3`,
      `CHUNK_BLOCK_TOLERANCE_SEC=5`, `SERVER_CHUNK_BUDGET_CHARS=60_000`,
      `SERVER_CHUNK_OVERLAP_SEC=240`, `SERVER_MAX_CHUNKS_PER_VIDEO=12`).
      Extension config re-exports the two shared values and no longer declares
      them locally. `tsc --noEmit` clean.
- [x] **Task 2**: Move `ChunkMerge` to `common/` — PASS. Module created,
      extension imports `@topskip/common/promo-chunk-merge`, old module and test
      deleted, moved test passes (7 tests).
- [x] **Task 3**: Move `ChunkPlanner` to `common/` with lines+options API — PASS.
      New public surface present; all 7 original assertions preserved plus the
      2 new fixed-overlap tests (9 total, passing).
- [x] **Task 4**: Switch extension call site — PASS. Call site passes
      `listTimedLinesFromMergedTranscript(merged.text)` with dynamic overlap
      options; BYOK regression tests (`promo-analysis`, `promo-detection-parity`,
      `promo-inflight-contract`) pass unchanged.
- [x] **Task 5**: Server chunk plan builder — PASS. `buildServerTranscriptChunks`
      uses the fixed 240 s / 60k-char policy and returns `ok:false` on partial
      coverage. Chunk line format is **byte-identical** to the adapter's
      `buildUserContent` (verified: both use
      `` `[${String(segment.startSec)}] ${segment.text}` ``), so the char budget
      maps 1:1 to prompt size. 2 tests pass.
- [x] **Task 6**: Chunk loop in the worker — PASS. Exactly one `adapter.analyze`
      call site, inside `analyzeChunkWithRetry`. Loop filters → merges → sums
      usage → joins raw responses. 4 tests pass, full backend suite (203) green.
- [x] **Task 7**: Bump algorithm version to `server-v6` — PASS. Constant bumped;
      all fixture literals bumped consistently; e2e
      `E2E_SERVER_ALGORITHM_VERSION` pairs correctly with
      `SEEDED_READY_SOURCE_RESULT_ID = 'result-e2eFixture1-server-v6'`.

### Deviations from the written spec (both intentional and documented)

1. **Fixed overlap kept exact.** The spec's planner pseudocode round-tripped
   overlap seconds → chars → seconds, which floating-point shrank 240 s to
   ~236 s and clipped the boundary guarantee. The implementation keeps the
   fixed window exact and only shrinks it when it would exceed half the chunk
   budget. The dynamic (BYOK) branch is byte-identical to the original.
   *This deviation strengthens the spec's core requirement rather than weakening
   it.*
2. **Edge-chunk filtering.** The spec applied the ±5 s caption-span filter to
   every chunk. The implementation leaves the first chunk's lower edge and the
   last chunk's upper edge open, filtering only interior boundaries. This was
   required to satisfy the spec's own stated invariant ("Transcript fits in one
   chunk → behavior identical to today"); the symmetric filter broke two
   pre-existing tests whose fixture adapter returns blocks past the fixture
   transcript's last caption. Out-of-video hallucinations are still rejected by
   `normalizeBackendPromoBlocks`.

Both deviations are recorded in the Implementation Notes of `quick.md`.

## Guidelines Compliance

| Guideline | Status | Notes |
| --------- | ------ | ----- |
| Imports: `@/…`, `@topskip/backend/…`, `@topskip/common/…` | COMPLIANT | All new cross-package imports use `@topskip/common/…` |
| `common/src/` holds only deterministic, side-effect-free code | COMPLIANT | No network/storage/timers/DOM/logging in the 3 new common files (the two `window` grep hits are the English word inside comments) |
| TypeScript only (no `.js`/`.mjs`) | COMPLIANT | All new files `.ts` |
| TypeScript strict; avoid `any` | COMPLIANT | `tsc --noEmit` clean; no `any` introduced |
| Avoid `as` type assertions | COMPLIANT | Zero `as <Type>` assertions in new/modified **src** files. One `as TranscriptArtifact` exists in a **test** fixture (rule scopes to `extension/src/`; this is `backend/tests/`) |
| Classes as namespaces, static API, no empty constructor | COMPLIANT | `ChunkPlanner`/`ChunkMerge` static-only; `buildServerTranscriptChunks` is a top-level function in a small single-purpose pure file (explicitly allowed) |
| Guards over nesting (`max-depth` 5, `no-else-return`) | COMPLIANT | Retry helper and chunk loop use early `continue`/`return` |
| JSDoc: multiline, summary + `@param` + `@returns`, incl. type aliases | COMPLIANT | Enforced by `oxlint --jsdoc-plugin` + eslint; lint clean |
| Comments explain *why*, not *what* | COMPLIANT | e.g. edge-chunk comment states the invariant and reason; overlap comment states the precision constraint |
| No spec paths / FR-IDs pasted into source | COMPLIANT | No `.sdd/` paths or requirement IDs in new source |
| No magic literals | COMPLIANT (1 advisory) | Tunables extracted to `promo-chunking-config.ts`. Advisory: `for (let attempt = 0; attempt < 2; …)` encodes the "one retry" policy as a literal — see Issue 3 |
| Testing: vitest, tests mirror source layout | COMPLIANT | `common/tests/**` and `backend/tests/**` mirror their `src/` |

## Verification Checklist

From `quick.md` **Final Verification**:

- [x] `pnpm test` — **PASS**: 837 tests / 100 files, 0 failures.
- [x] `pnpm lint` — **PASS**: format + oxlint + eslint + markdownlint + tsc, 0 errors.
- [x] `pnpm format` — **PASS**: `oxfmt --check .` reports all 324 files correctly formatted.
- [ ] Manual browser end-to-end on `CqXG2dg7WIY` — **SKIP (intentional)**: the
      production adapter issues real, paid OpenRouter calls. Chunking behavior is
      covered deterministically by `promo-analysis-chunking.test.ts` and
      `promo-analysis-worker-chunking.test.ts`; the full HTTP job path is
      exercised by the fixture-backed backend suite.

Additional gates from `AGENTS.md` § Contribution instructions:

- [x] `pnpm build` — **PASS**: Rspack compiled successfully.
- [x] `pnpm test:coverage` — **N/A**: coverage `include` covers only
      `skip-logic.ts`, `promo-skip-logic.ts`, `page-guards.ts`,
      `preferences-store.ts`; none were touched.
- [ ] `pnpm test:e2e` — **SKIP (environment)**: 18/18 tests fail in
      `browserType.launchPersistentContext` after 3 ms, before any assertion.
      Playwright 1.59.1 requires `chromium-1217`; the machine cache has only
      `chromium-1194` and `chromium-1228`. **Code-independent** — an unmodified
      checkout fails identically. See Issue 1.

## Issues Found

1. **E2E suite cannot run on this machine (environment, not code)** — MEDIUM
    - Description: All 18 Playwright tests fail at browser launch because the
      required Chromium build (`chromium-1217`) is not installed. This change
      edits `extension/e2e/extension.spec.ts` (the `server-v5` → `server-v6`
      fixture bump), so e2e is a genuinely relevant gate that remains
      unverified. Static verification confirms the bump is self-consistent:
      `E2E_SERVER_ALGORITHM_VERSION = 'server-v6'` matches
      `SEEDED_READY_SOURCE_RESULT_ID = 'result-e2eFixture1-server-v6'` in
      `backend/src/cache-fixtures.ts`, and the renamed `jobId` strings are
      arbitrary in-file identifiers.
    - Recommendation: run `pnpm exec playwright install chromium` (≈150 MB
      download, one-time per machine, documented in `AGENTS.md` step 3), then
      `pnpm test:e2e` before pushing.

2. **`.sdd/.current/` contained an unrelated feature's spec** — MEDIUM — **RESOLVED**
    - Description: `spec.md` and `plan.md` (created 2026-07-17) describe
      "Extension-Captured Transcripts for Server Analysis", a different feature
      from this chunking work. They were left in `.current` from an earlier
      cycle, so a plain rename of `.sdd/.current/` would have filed that
      feature's documents under a chunking-named directory, mislabeling them.
    - Resolution: `.current` was split into two directories, matching the
      repo convention of one directory per feature (quick-only directories are
      already common in `.sdd/`):
        - `.sdd/20260722-chunked-server-side-promo-analysis/` — `quick.md`,
          `validation.md` (this change).
        - `.sdd/20260717-extension-captured-transcripts-server-analysis/` —
          `spec.md`, `plan.md`, moved with `git mv` to preserve history and
          dated by their creation date. Their contents and `Status` were left
          untouched, since that feature was not validated as part of this work.
      The empty `contracts/` directory and `.sdd/.current/` were removed.

3. **`attempt < 2` encodes the retry policy as a literal** — LOW (advisory)
    - Description: `backend/src/analysis/promo-analysis-worker.ts:298` uses a
      bare `2` for "one retry, then fail", a decision the spec calls out
      explicitly. `AGENTS.md` exempts "trivial literals with a single local
      use", which arguably applies, but the number carries policy meaning.
    - Recommendation: optionally extract
      `const MAX_CHUNK_ATTEMPTS = 2;` alongside the other chunking tunables so
      the retry policy is named and greppable.

4. **Behavior-change docs not updated in existing feature specs** — LOW
    - Description: `AGENTS.md` step 1 asks that active `.sdd/yyyymmdd-…` specs be
      aligned when behavior changes. Server-route analysis behavior changed
      (single prompt → chunked, `server-v5` → `server-v6`), which touches
      `.sdd/20260715-server-gemini-promo-analysis` and relates to
      `.sdd/20260419-chunked-promo-detection-full-transcript`. Neither was
      updated; `quick.md` is currently the sole record.
    - Recommendation: acceptable if `quick.md` is finalized into its own
      `.sdd/` directory as the record for this change; otherwise add a short
      note to the server-analysis spec pointing at it.

## Recommendations

The implementation is complete and correct as specified. Before pushing:

1. Install the Playwright browser and run `pnpm test:e2e` to close the one
   relevant unverified gate (Issue 1).
2. Optional: name the retry constant (Issue 3).
3. Remember this needs a **backend deploy** to take effect — the chunk loop and
   the `server-v6` cache-key bump are server-side. After deploy, previously
   cached long-video results re-analyze on next request.

Issue 2 was resolved during finalization; Issue 4 is satisfied by this spec
directory serving as the record for the change.
