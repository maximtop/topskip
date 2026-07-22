# Implementation Plan: Chunked server-side promo analysis with overlapping chunks

- **Created**: 2026-07-21
- **Status**: Validated
- **Model**: Claude Fable 5
- **Implemented by**: Claude Opus 4.8
- **Validated by**: Claude Opus 4.8 (see [validation.md](./validation.md))
- **Type**: Refactoring + behavior change
- **Input**: Перевести серверный анализ на чанкинг с перекрытием чанков, чтобы
  не терять промоблоки в длинных видео; перекрытие должно покрывать всё время
  типичного промоблока.

## Implementation Notes

- All 7 tasks implemented; `pnpm test` (837 passed, 100 files) and `pnpm lint`
  (0 errors) are green.
- **Overlap precision fix**: the shared planner keeps the fixed overlap exact
  (e.g. 240 s stays 240 s) instead of round-tripping seconds→chars→seconds,
  which was shrinking it to ~236 s and could clip a block at the boundary. It
  only shrinks the fixed overlap if it would exceed half the chunk budget. The
  dynamic (BYOK) branch is byte-identical to the original, so BYOK behavior is
  unchanged.
- **Edge-chunk filtering**: the worker filters a chunk's blocks against its
  caption span only on *interior* boundaries. The first chunk's lower edge and
  the last chunk's upper edge stay open, so a single chunk (first == last) is
  never filtered — honoring the spec invariant "one chunk ⇒ identical to
  whole-transcript analysis" and keeping fixture adapters (which return blocks
  past the fixture transcript's last caption) working. Hallucinated
  out-of-video blocks are still rejected by `normalizeBackendPromoBlocks`.
- Manual browser E2E from Final Verification was **not run**: the production
  adapter makes real paid OpenRouter calls. Chunking is covered deterministically
  by `promo-analysis-chunking.test.ts` and `promo-analysis-worker-chunking.test.ts`,
  and the full HTTP job path is exercised by the fixture-backed backend suite.

## Problem

The server analysis route sends the **entire transcript in one Gemini prompt**
(`OpenRouterGeminiAnalysisAdapter.analyze`). For the 3h46m video `CqXG2dg7WIY`
this produced a 120,906-input-token prompt. Long single-prompt analysis risks
missed mid/late-video promo blocks (long-context attention decay). The BYOK
route already chunks (`ChunkPlanner`, 8 chunks max, 30–90s dynamic overlap),
but the server route does not.

Goal: chunk the server analysis with **overlapping chunks** so a promo block
crossing a chunk boundary is not lost. Decisions confirmed with the user:

- Overlap: **fixed 240 s** — any block ≤ 4 min lands fully inside at least one
  chunk (model sees exact boundaries); longer blocks are stitched by the merge
  step, same as BYOK.
- Chunk budget: **60,000 transcript chars** per Gemini call (≈35–40k tokens
  for Russian; the 3h46m video becomes ~4 chunks).
- Reuse: **move `ChunkPlanner`/`ChunkMerge` from the extension to `common/`**
  and use them in both routes (DRY).
- Chunk failure: **one retry, then fail the whole job** (server results cache
  for 30 days; a partial result must not stick).

## Research Findings

### Root Cause / Current State

- `backend/src/analysis/promo-analysis-worker.ts:111` — one
  `adapter.analyze({transcriptArtifact})` call for the whole transcript.
- `backend/src/analysis/openrouter-gemini-analysis-adapter.ts:190-203`
  (`buildUserContent`) — builds `[startSec] text` lines from
  `artifact.segments`; exactly the line format the extension's chunk planner
  operates on.
- Extension BYOK chunking: `extension/src/background/messaging/chunk-planner.ts`
  (line-aligned overlapping plan over `{sec, line}` rows, overlap shrinks when
  the plan exceeds `MAX_CHUNKS_PER_VIDEO`),
  `chunk-merge.ts` (drop blocks whose `startSec` is outside chunk range ±5 s),
  cross-chunk merge via `mergePromoBlocksWithGap(…, 3)` from
  `common/src/promo-dedupe.ts:78`. Call site:
  `promo-analysis.ts:294` `ChunkPlanner.buildChunkPlan(merged.text, budget)`.
- Budget: one `reserveModelBudget` (`MODEL_RESERVATION_USD = 1`,
  `backend/src/public-state.ts:24`) wraps the whole
  `BackendPromoAnalysisWorker.analyze` call (`analysis-jobs.ts:623-651`) and is
  settled with actual summed usage — chunking inside the worker needs **no
  budget-flow change**. Worst case ~9 chunks ≈ same input tokens + ~15–20%
  overlap duplication; observed full-video call cost $0.199, so the $1
  reserve covers it comfortably.
- Artifact schema (`promo-analysis-types.ts`): `rawModelResponse` is a single
  nullable string, `usage` is `{inputTokens, outputTokens, costUsd?}`,
  `parsedResult` is `{hasPromo, promoBlocks}` — chunked run joins raw
  responses into one string and sums usage; **no schema change**.
- Contract limits guarantee bounded plans: transcript ≤ 500,000 chars
  (`MAX_TRANSCRIPT_CHARACTER_COUNT`), ≤ 10,000 segments, ≤ 5 h. With a 60k
  budget and 240 s overlap the worst case is ~9 chunks → server cap 12 never
  truncates coverage.
- `SERVER_ANALYSIS_ALGORITHM_VERSION = 'server-v5'`
  (`common/src/server-analysis-contract.ts:13`) keys the server result cache,
  the client local cache, and response identity checks. Chunking changes the
  algorithm → bump to `server-v6` so stale single-prompt results (like
  `CqXG2dg7WIY`) re-analyze. 142 usages import the constant (auto-updated);
  13 test files hardcode `'server-v5'` literals and need a mechanical update.

### Patterns to Follow

- Static-class modules with JSDoc on every member (see `ChunkPlanner`,
  `BackendPromoAnalysisWorker`).
- `common/` files are flat (`promo-dedupe.ts`, `promo-types.ts`) and imported
  as `@topskip/common/<file>`.
- Tests: vitest, `common/tests/**` for common code, `backend/tests/**` for
  backend; worker tests inject a fake adapter via `input.adapter`.
- Format/lint: `pnpm format`, `pnpm lint` (oxfmt + oxlint + eslint + tsc).

### Edge Cases

- Promo block **longer than 240 s** crossing a boundary → each chunk reports
  its part; `filterPromoBlocksForChunkTimeRange` keeps blocks whose `startSec`
  is in-range (endSec may extend past the chunk), `mergePromoBlocksWithGap`
  stitches overlapping/adjacent parts (gap ≤ 3 s).
- Transcript **fits in one chunk** (≤ 60k chars) → plan has 1 chunk; behavior
  and prompt content identical to today.
- Single segment **longer than the budget** → planner emits it as its own
  chunk (existing `oneLineLen > budgetChars` branch) — never an infinite loop.
- Chunk returns `hasPromo: false` → contributes no blocks; overall
  `no_promo` only when **all** chunks are empty after merge.
- Model hallucinates block timestamps outside its chunk → dropped by the ±5 s
  `startSec` filter (`CHUNK_BLOCK_TOLERANCE_SEC`).
- Fixed 240 s overlap on a dense transcript could exceed 50% of the chunk
  budget → planner clamps overlap chars to 50% of budget (existing logic,
  preserved).
- Adapter throw or unparsable response → one retry for that chunk, then the
  job fails terminally (`ModelProviderError` / parse failure reason); nothing
  is cached.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `common/src/promo-chunking-config.ts` | Create | Shared chunking tunables: merge gap, tolerance, server budget/overlap/cap |
| `common/src/promo-chunk-planner.ts` | Create (move) | `ChunkPlanner` with lines+options API (fixed or dynamic overlap) |
| `common/src/promo-chunk-merge.ts` | Create (move) | `ChunkMerge.filterPromoBlocksForChunkTimeRange` (verbatim move) |
| `extension/src/background/messaging/chunk-planner.ts` | Delete | Superseded by common module |
| `extension/src/background/messaging/chunk-merge.ts` | Delete | Superseded by common module |
| `extension/src/background/messaging/chunk-plan-config.ts` | Modify | Keep BYOK-only tunables; re-export shared ones from common |
| `extension/src/background/messaging/promo-analysis.ts` | Modify | New planner call (lines + dynamic-overlap options), common imports |
| `backend/src/analysis/promo-analysis-chunking.ts` | Create | Segments → server chunk plan (fixed 240 s overlap, 60k budget) |
| `backend/src/analysis/promo-analysis-worker.ts` | Modify | Chunk loop: per-chunk adapter calls, retry, filter+merge, usage sum |
| `common/src/server-analysis-contract.ts` | Modify | `SERVER_ANALYSIS_ALGORITHM_VERSION` → `'server-v6'` |
| `common/tests/promo-chunk-planner.test.ts` | Create (move) | Planner tests adapted to new API + fixed-overlap cases |
| `common/tests/promo-chunk-merge.test.ts` | Create (move) | Moved merge tests |
| `backend/tests/promo-analysis-chunking.test.ts` | Create | Server chunk plan: coverage, overlap, 1-chunk case |
| `backend/tests/promo-analysis-worker-chunking.test.ts` | Create | Worker chunk loop: merge, boundary stitch, retry/failure, usage sum |
| 13 test files hardcoding `'server-v5'` | Modify | Mechanical literal bump to `server-v6` |

## Solution

1. Move the chunk planner and merge filter to `common/` with a generalized
   API: input is `TimedLine[]` (`{sec, line}`) plus
   `{budgetChars, maxChunks, overlap}` where `overlap` is
   `{kind:'fixed', sec}` (server) or
   `{kind:'dynamic', floorSec, ceilingSec, fraction}` (BYOK, current
   behavior). All slicing/overlap/shrink internals move unchanged.
2. Backend builds `TimedLine[]` from `artifact.segments` using the **same**
   `[startSec] text` format the adapter sends, so the char budget maps 1:1 to
   prompt size. Chunk plan line indexes map 1:1 to segment indexes → each
   chunk becomes a sliced `TranscriptArtifact`.
3. `BackendPromoAnalysisWorker.analyze` loops chunks sequentially: per-chunk
   adapter call (one retry), parse, filter blocks to the chunk window ±5 s,
   merge into the running list with 3 s gap, sum usage, join raw responses.
   Empty merged list → `no_promo`; otherwise normalize once and build `ready`.
4. Bump algorithm version to `server-v6` so cached single-prompt results
   re-analyze and client caches roll over.

### Alternatives Considered

- **Backend-local chunker** (no extension churn) — rejected: duplicates
  planning/merge logic already tested in the extension.
- **Overlap = dynamic 30–90 s as BYOK** — rejected per user decision: blocks
  longer than 90 s crossing a boundary would rely on stitching only.
- **Parallel chunk calls** — YAGNI for now; sequential keeps provider rate
  behavior predictable (typical 4–5 chunks × ~15 s ≈ ≤ 75 s per job; polling
  already handles multi-minute jobs).

## Tasks

### [x] Task 1: Shared chunking config in common/

**Files:**

- Create: `common/src/promo-chunking-config.ts`
- Modify: `extension/src/background/messaging/chunk-plan-config.ts`

- [x] **Step 1: Create the shared config module**

```ts
// common/src/promo-chunking-config.ts
/**
 * Chunking tunables shared by the BYOK (extension) and server (backend)
 * promo-analysis routes. Change only with evaluation data.
 */

/**
 * Merge adjacent LLM-reported blocks when the gap is at most this (seconds).
 */
export const BLOCK_MERGE_GAP_SEC = 3;

/**
 * Drop blocks whose `startSec` is farther than this outside the chunk range.
 */
export const CHUNK_BLOCK_TOLERANCE_SEC = 5;

/**
 * Server route: transcript character budget per model call.
 */
export const SERVER_CHUNK_BUDGET_CHARS = 60_000;

/**
 * Server route: fixed overlap so a typical promo block fits fully inside at
 * least one chunk; longer blocks are stitched by the cross-chunk merge.
 */
export const SERVER_CHUNK_OVERLAP_SEC = 240;

/**
 * Server route: chunk cap. With the 500k-char contract limit and the 60k
 * budget the worst case is ~9 chunks, so coverage is never truncated.
 */
export const SERVER_MAX_CHUNKS_PER_VIDEO = 12;
```

- [x] **Step 2: Re-export shared values from the extension config**

In `extension/src/background/messaging/chunk-plan-config.ts` delete the
`BLOCK_MERGE_GAP_SEC` and `CHUNK_BLOCK_TOLERANCE_SEC` declarations (lines
27–36) and add at the top:

```ts
export {
    BLOCK_MERGE_GAP_SEC,
    CHUNK_BLOCK_TOLERANCE_SEC,
} from '@topskip/common/promo-chunking-config';
```

- [x] **Step 3: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: PASS (import sites in `promo-analysis.ts` are unchanged).

**Verification**: `pnpm exec tsc --noEmit` passes.

### [x] Task 2: Move ChunkMerge to common/

**Files:**

- Create: `common/src/promo-chunk-merge.ts`
- Delete: `extension/src/background/messaging/chunk-merge.ts`
- Create: `common/tests/promo-chunk-merge.test.ts` (move of
  `extension/tests/background/messaging/chunk-merge.test.ts`)
- Modify: `extension/src/background/messaging/promo-analysis.ts` (import)

- [x] **Step 1: Move the module verbatim**

Copy `extension/src/background/messaging/chunk-merge.ts` (all 30 lines) to
`common/src/promo-chunk-merge.ts`, changing only the import:

```ts
import type { PromoBlock } from '@topskip/common/promo-types';
```

(This import specifier already works from `common/` — see
`common/src/server-analysis-contract.ts` imports.) If the common package uses
relative imports internally (check neighboring files, e.g.
`common/src/promo-dedupe.ts`), use `./promo-types` instead — follow whichever
style `common/src` uses.

- [x] **Step 2: Move the test**

Move `extension/tests/background/messaging/chunk-merge.test.ts` to
`common/tests/promo-chunk-merge.test.ts`; update the import to
`@topskip/common/promo-chunk-merge`. Delete the old test file.

- [x] **Step 3: Update the extension import and delete the old module**

In `extension/src/background/messaging/promo-analysis.ts` replace

```ts
import { ChunkMerge } from '@/background/messaging/chunk-merge';
```

with

```ts
import { ChunkMerge } from '@topskip/common/promo-chunk-merge';
```

Delete `extension/src/background/messaging/chunk-merge.ts`.

- [x] **Step 4: Run the moved test**

Run: `pnpm vitest run common/tests/promo-chunk-merge.test.ts`
Expected: PASS.

**Verification**: test passes; `pnpm exec tsc --noEmit` passes.

### [x] Task 3: Move ChunkPlanner to common/ with lines + options API

**Files:**

- Create: `common/src/promo-chunk-planner.ts`
- Delete: `extension/src/background/messaging/chunk-planner.ts`
- Create: `common/tests/promo-chunk-planner.test.ts` (move+adapt of
  `extension/tests/background/messaging/chunk-planner.test.ts`)

- [x] **Step 1: Write failing tests for the new API (moved file)**

Move the existing planner test to `common/tests/promo-chunk-planner.test.ts`.
Add a helper and rewrite call sites to the new signature, keeping every
existing assertion; parse merged text into lines with a local copy of the
regex the extension logger uses:

```ts
import { describe, expect, it } from 'vitest';
import {
    ChunkPlanner,
    type TimedLine,
} from '@topskip/common/promo-chunk-planner';

/**
 * Parses `[sec] text` merged-transcript lines for planner tests.
 */
function toLines(mergedText: string): TimedLine[] {
    const rows: TimedLine[] = [];
    for (const raw of mergedText.split('\n')) {
        const line = raw.trimEnd();
        const m = /^\[(\d+(?:\.\d+)?)\]\s*(.*)$/.exec(line);
        if (!m) {
            continue;
        }
        const sec = Number(m[1]);
        if (Number.isFinite(sec)) {
            rows.push({ sec, line });
        }
    }
    return rows;
}

const DYNAMIC = {
    kind: 'dynamic',
    floorSec: 30,
    ceilingSec: 90,
    fraction: 0.15,
} as const;

// Existing assertions, e.g.:
//   ChunkPlanner.buildChunkPlan('', 500)
// becomes:
//   ChunkPlanner.buildChunkPlan(toLines(''), {
//       budgetChars: 500, maxChunks: 8, overlap: DYNAMIC,
//   })
```

Add two new fixed-overlap tests at the end:

```ts
it('fixed overlap: adjacent chunks share at least the requested window', () => {
    const lines: TimedLine[] = [];
    for (let sec = 0; sec < 3600; sec += 4) {
        lines.push({ sec, line: `[${sec}] word word word word word` });
    }
    const plan = ChunkPlanner.buildChunkPlan(lines, {
        budgetChars: 8_000,
        maxChunks: 12,
        overlap: { kind: 'fixed', sec: 240 },
    });
    expect(plan.chunks.length).toBeGreaterThan(1);
    expect(plan.partialCoverage).toBe(false);
    for (let i = 1; i < plan.chunks.length; i++) {
        const prev = plan.chunks[i - 1];
        const next = plan.chunks[i];
        expect(next.startSec).toBeLessThanOrEqual(prev.endSec - 239);
    }
});

it('fixed overlap: single chunk when the transcript fits the budget', () => {
    const lines = toLines('[0] hello\n[5] world');
    const plan = ChunkPlanner.buildChunkPlan(lines, {
        budgetChars: 60_000,
        maxChunks: 12,
        overlap: { kind: 'fixed', sec: 240 },
    });
    expect(plan.chunks).toHaveLength(1);
    expect(plan.overlapSec).toBe(240);
});
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm vitest run common/tests/promo-chunk-planner.test.ts`
Expected: FAIL — module `@topskip/common/promo-chunk-planner` does not exist.

- [x] **Step 3: Create the common planner**

Create `common/src/promo-chunk-planner.ts`. Move the private methods
`sliceLines`, `sliceCharLen`, `findEndIdxForBudget`, `nextChunkStartIdx`,
`tryPlan` and the `ChunkPlanItem`/`ChunkPlan` types **verbatim** from
`extension/src/background/messaging/chunk-planner.ts:12-244` (drop the
`chunk-plan-config` and `log-promo-analysis` imports). Add the new public
surface:

```ts
/**
 * Timestamped transcript row: `line` is the exact prompt line, `sec` its
 * caption start time.
 */
export type TimedLine = { sec: number; line: string };

/**
 * Overlap policy: fixed seconds (server route) or dynamic from the chunk
 * budget (BYOK route, historical behavior).
 */
export type ChunkOverlapPolicy =
    | { kind: 'fixed'; sec: number }
    | {
          kind: 'dynamic';
          floorSec: number;
          ceilingSec: number;
          fraction: number;
      };

/**
 * Planner inputs; `maxChunks` bounds adapter calls per video.
 */
export type ChunkPlanOptions = {
    budgetChars: number;
    maxChunks: number;
    overlap: ChunkOverlapPolicy;
};

/**
 * Overlap can shrink to this floor before the planner truncates coverage.
 */
const OVERLAP_SHRINK_FLOOR_SEC = 30;
```

Replace the old `buildChunkPlan(mergedText, budgetChars)` (lines 255–330)
with:

```ts
    /**
     * Builds a deterministic overlapping chunk plan (overlap shrinks when the
     * plan would exceed `maxChunks`).
     *
     * @param lines - Timed transcript lines (`[sec] text` per row)
     * @param options - Budget, chunk cap, and overlap policy
     * @returns Chunk plan and coverage metadata
     */
    static buildChunkPlan(
        lines: readonly TimedLine[],
        options: ChunkPlanOptions,
    ): ChunkPlan {
        const { budgetChars, maxChunks, overlap } = options;
        if (lines.length === 0 || budgetChars <= 0) {
            return {
                chunks: [],
                overlapSec: OVERLAP_SHRINK_FLOOR_SEC,
                partialCoverage: false,
                plannedChunkCount: 0,
                coverageFraction: 0,
            };
        }

        const totalChars = ChunkPlanner.sliceCharLen(
            lines,
            0,
            lines.length - 1,
        );
        const firstSec = lines[0].sec;
        const lastSec = lines[lines.length - 1].sec;
        const durationSec = Math.max(lastSec - firstSec, 1e-6);
        const charsPerSec = totalChars / durationSec;

        let overlapSec: number;
        if (overlap.kind === 'fixed') {
            overlapSec = overlap.sec;
        } else {
            overlapSec = Math.min(
                overlap.ceilingSec,
                Math.max(
                    overlap.floorSec,
                    (budgetChars * overlap.fraction) /
                        Math.max(charsPerSec, 1e-6),
                ),
            );
        }

        const maxOverlapChars = Math.floor(budgetChars * 0.5);
        const overlapChars = Math.min(
            maxOverlapChars,
            overlapSec * charsPerSec,
        );
        overlapSec = Math.max(
            OVERLAP_SHRINK_FLOOR_SEC,
            overlapChars / Math.max(charsPerSec, 1e-6),
        );
        if (overlap.kind === 'fixed') {
            overlapSec = Math.min(overlapSec, overlap.sec);
        } else {
            overlapSec = Math.min(overlapSec, overlap.ceilingSec);
        }

        let chunks = ChunkPlanner.tryPlan(lines, budgetChars, overlapSec);
        let partialCoverage = false;

        while (
            chunks.length > maxChunks &&
            overlapSec > OVERLAP_SHRINK_FLOOR_SEC
        ) {
            overlapSec = Math.max(
                OVERLAP_SHRINK_FLOOR_SEC,
                overlapSec * 0.75,
            );
            chunks = ChunkPlanner.tryPlan(lines, budgetChars, overlapSec);
        }

        if (chunks.length > maxChunks) {
            chunks = chunks.slice(0, maxChunks);
            partialCoverage = true;
        }

        chunks.forEach((c, i) => {
            c.index = i;
        });

        let coverageFraction = 1;
        if (partialCoverage && chunks.length > 0) {
            const lastLine = Math.max(...chunks.map((c) => c.lineEndIndex));
            const coveredLen = ChunkPlanner.sliceCharLen(lines, 0, lastLine);
            coverageFraction = Math.min(
                1,
                coveredLen / Math.max(totalChars, 1),
            );
        }

        return {
            chunks,
            overlapSec,
            partialCoverage,
            plannedChunkCount: chunks.length,
            coverageFraction,
        };
    }
```

Note the one intentional behavior difference: `totalChars` is computed from
the joined lines instead of the raw merged string — for the extension these
are identical because `merged.text` is exactly the joined `[sec] text` lines.
The internal `TimedLine` type alias previously declared in the extension file
(line 43) is replaced by the exported `TimedLine`.

- [x] **Step 4: Run the tests**

Run: `pnpm vitest run common/tests/promo-chunk-planner.test.ts`
Expected: PASS (all moved assertions plus the two fixed-overlap tests).

**Verification**: planner tests pass; old extension planner file still exists
(deleted in Task 4 after the call site moves).

### [x] Task 4: Switch the extension call site to the common planner

**Files:**

- Modify: `extension/src/background/messaging/promo-analysis.ts:294`
- Delete: `extension/src/background/messaging/chunk-planner.ts`
- Delete: `extension/tests/background/messaging/chunk-planner.test.ts` (moved
  in Task 3)

- [x] **Step 1: Update imports and the call site**

In `promo-analysis.ts` replace

```ts
import { ChunkPlanner } from '@/background/messaging/chunk-planner';
```

with

```ts
import { ChunkPlanner } from '@topskip/common/promo-chunk-planner';
import { listTimedLinesFromMergedTranscript } from '@/background/openrouter/log-promo-analysis';
```

(`listTimedLinesFromMergedTranscript` may already be imported — check the
existing import list and merge.) Replace line 294:

```ts
            const plan = ChunkPlanner.buildChunkPlan(merged.text, budget);
```

with:

```ts
            const plan = ChunkPlanner.buildChunkPlan(
                listTimedLinesFromMergedTranscript(merged.text),
                {
                    budgetChars: budget,
                    maxChunks: MAX_CHUNKS_PER_VIDEO,
                    overlap: {
                        kind: 'dynamic',
                        floorSec: OVERLAP_FLOOR_SEC,
                        ceilingSec: OVERLAP_CEILING_SEC,
                        fraction: OVERLAP_FRACTION,
                    },
                },
            );
```

`MAX_CHUNKS_PER_VIDEO`, `OVERLAP_FLOOR_SEC`, `OVERLAP_CEILING_SEC`,
`OVERLAP_FRACTION` come from `@/background/messaging/chunk-plan-config`
(check the existing import there and extend it — the file keeps these
BYOK-only tunables).

- [x] **Step 2: Delete the superseded files**

Delete `extension/src/background/messaging/chunk-planner.ts` and (if not
already removed in Task 3) the old planner test.

- [x] **Step 3: Run the BYOK regression tests**

Run: `pnpm vitest run extension/tests/background/messaging/promo-analysis.test.ts extension/tests/background/messaging/promo-detection-parity.test.ts`
Expected: PASS — BYOK chunking behavior is unchanged.

**Verification**: full `pnpm exec tsc --noEmit` passes; no references to the
deleted modules remain (`grep -rn "messaging/chunk-planner\|messaging/chunk-merge" extension/src` → empty).

### [x] Task 5: Server chunk plan builder

**Files:**

- Create: `backend/src/analysis/promo-analysis-chunking.ts`
- Test: `backend/tests/promo-analysis-chunking.test.ts`

- [x] **Step 1: Write the failing test**

```ts
// backend/tests/promo-analysis-chunking.test.ts
import { describe, expect, it } from 'vitest';
import { buildServerTranscriptChunks } from '@topskip/backend/analysis/promo-analysis-chunking';
import type { CaptionSegment } from '@topskip/common/caption-types';

/**
 * Builds a uniform transcript: one segment every 4 s, ~26 chars per line.
 */
function makeSegments(totalSec: number): CaptionSegment[] {
    const segments: CaptionSegment[] = [];
    for (let sec = 0; sec < totalSec; sec += 4) {
        segments.push({
            startSec: sec,
            durationSec: 4,
            text: 'promo talk sample words here',
        });
    }
    return segments;
}

describe('buildServerTranscriptChunks', () => {
    it('returns one chunk for a short transcript', () => {
        const segments = makeSegments(600);
        const result = buildServerTranscriptChunks(segments);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.chunks).toHaveLength(1);
        expect(result.chunks[0].segments).toHaveLength(segments.length);
    });

    it('splits a long transcript into overlapping chunks covering every segment', () => {
        const segments = makeSegments(13_600);
        const result = buildServerTranscriptChunks(segments);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.chunks.length).toBeGreaterThan(1);
        // Adjacent chunks overlap by at least ~240s of video time.
        for (let i = 1; i < result.chunks.length; i++) {
            const prev = result.chunks[i - 1];
            const next = result.chunks[i];
            expect(next.startSec).toBeLessThanOrEqual(prev.endSec - 239);
        }
        // Every source segment appears in at least one chunk.
        const covered = new Set<number>();
        for (const chunk of result.chunks) {
            for (const s of chunk.segments) {
                covered.add(s.startSec);
            }
        }
        expect(covered.size).toBe(segments.length);
        // Chunk segment slices align with the reported time range.
        for (const chunk of result.chunks) {
            expect(chunk.segments[0]?.startSec).toBe(chunk.startSec);
            expect(chunk.segments.at(-1)?.startSec).toBe(chunk.endSec);
        }
    });
});
```

- [x] **Step 2: Run to verify failure**

Run: `pnpm vitest run backend/tests/promo-analysis-chunking.test.ts`
Expected: FAIL — module does not exist.

- [x] **Step 3: Implement the builder**

```ts
// backend/src/analysis/promo-analysis-chunking.ts
import { ChunkPlanner } from '@topskip/common/promo-chunk-planner';
import {
    SERVER_CHUNK_BUDGET_CHARS,
    SERVER_CHUNK_OVERLAP_SEC,
    SERVER_MAX_CHUNKS_PER_VIDEO,
} from '@topskip/common/promo-chunking-config';
import type { CaptionSegment } from '@topskip/common/caption-types';

/**
 * One transcript slice for one model call, with its caption time range.
 */
export type ServerTranscriptChunk = {
    index: number;
    startSec: number;
    endSec: number;
    segments: CaptionSegment[];
};

/**
 * Failure means the plan could not cover the transcript within the chunk cap;
 * contract limits make this unreachable, so callers treat it as an internal
 * error rather than truncating coverage silently.
 */
export type ServerChunkPlanResult =
    | { ok: true; chunks: ServerTranscriptChunk[] }
    | { ok: false };

/**
 * Plans fixed-overlap transcript chunks whose line format matches the
 * adapter's prompt lines, so the char budget maps 1:1 to prompt size.
 *
 * @param segments - Canonical transcript segments (already validated).
 * @returns Chunk slices, or `ok: false` when coverage would be partial.
 */
export function buildServerTranscriptChunks(
    segments: readonly CaptionSegment[],
): ServerChunkPlanResult {
    const lines = segments.map((segment) => ({
        sec: segment.startSec,
        line: `[${String(segment.startSec)}] ${segment.text}`,
    }));
    const plan = ChunkPlanner.buildChunkPlan(lines, {
        budgetChars: SERVER_CHUNK_BUDGET_CHARS,
        maxChunks: SERVER_MAX_CHUNKS_PER_VIDEO,
        overlap: { kind: 'fixed', sec: SERVER_CHUNK_OVERLAP_SEC },
    });
    if (plan.chunks.length === 0 || plan.partialCoverage) {
        return { ok: false };
    }
    return {
        ok: true,
        chunks: plan.chunks.map((chunk) => ({
            index: chunk.index,
            startSec: chunk.startSec,
            endSec: chunk.endSec,
            segments: segments.slice(
                chunk.lineStartIndex,
                chunk.lineEndIndex + 1,
            ),
        })),
    };
}
```

The line format string must stay byte-identical to
`OpenRouterGeminiAnalysisAdapter.buildUserContent`
(`openrouter-gemini-analysis-adapter.ts:193-195`):
`` `[${String(segment.startSec)}] ${segment.text}` ``.

- [x] **Step 4: Run the test**

Run: `pnpm vitest run backend/tests/promo-analysis-chunking.test.ts`
Expected: PASS.

**Verification**: both tests pass.

### [x] Task 6: Chunk loop in the analysis worker

**Files:**

- Modify: `backend/src/analysis/promo-analysis-worker.ts:97-209` (`analyze`)
- Test: `backend/tests/promo-analysis-worker-chunking.test.ts`

- [x] **Step 1: Write the failing tests**

```ts
// backend/tests/promo-analysis-worker-chunking.test.ts
import { describe, expect, it } from 'vitest';
import { BackendPromoAnalysisWorker } from '@topskip/backend/analysis/promo-analysis-worker';
import type {
    BackendLlmAnalysisAdapter,
    BackendLlmAnalysisAdapterInput,
} from '@topskip/backend/analysis/promo-analysis-types';
import type { TranscriptArtifact } from '@topskip/backend/extraction/subtitle-extraction-types';

const TOTAL_SEC = 13_600;

/**
 * Uniform long transcript: one segment every 4 s (multi-chunk at 60k chars).
 */
function makeArtifact(): TranscriptArtifact {
    const segments = [];
    for (let sec = 0; sec < TOTAL_SEC; sec += 4) {
        segments.push({
            startSec: sec,
            durationSec: 4,
            text: 'promo talk sample words here',
        });
    }
    return {
        artifactId: 'transcript-test',
        videoId: 'dQw4w9WgXcQ',
        algorithmVersion: 'server-v6',
        strategy: 'extension_caption_upload',
        videoDurationSec: TOTAL_SEC,
        acquiredAtMs: 0,
        segments,
        transcriptText: '',
        sourceType: 'extension_caption_upload',
        languageCode: 'en',
        transcriptHash: 'a'.repeat(64),
    } as TranscriptArtifact;
}

/**
 * Fake adapter recording per-call chunk ranges and returning canned blocks.
 */
function makeAdapter(
    respond: (
        input: BackendLlmAnalysisAdapterInput,
        call: number,
    ) => string | Error,
): BackendLlmAnalysisAdapter & {
    calls: Array<{ firstSec: number; lastSec: number }>;
} {
    const calls: Array<{ firstSec: number; lastSec: number }> = [];
    let n = 0;
    return {
        providerId: 'openrouter',
        model: 'test/model',
        promptVersion: '4',
        calls,
        async analyze(input: BackendLlmAnalysisAdapterInput) {
            const segs = input.transcriptArtifact.segments;
            calls.push({
                firstSec: segs[0].startSec,
                lastSec: segs[segs.length - 1].startSec,
            });
            n += 1;
            const out = respond(input, n);
            if (out instanceof Error) {
                throw out;
            }
            return {
                rawModelResponse: out,
                model: 'test/model',
                usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.01 },
            };
        },
    };
}

describe('BackendPromoAnalysisWorker chunked analysis', () => {
    it('calls the adapter once per chunk and merges blocks across chunks', async () => {
        const adapter = makeAdapter((input) => {
            const firstSec =
                input.transcriptArtifact.segments[0]?.startSec ?? 0;
            // Only the first chunk reports a block, in its own window.
            if (firstSec === 0) {
                return JSON.stringify({
                    hasPromo: true,
                    promoBlocks: [
                        { startSec: 20, endSec: 60, confidence: 'high' },
                    ],
                });
            }
            return JSON.stringify({ hasPromo: false });
        });
        const result = await BackendPromoAnalysisWorker.analyze({
            transcriptArtifact: makeArtifact(),
            durationSec: TOTAL_SEC,
            nowMs: 1_000,
            adapter,
            clock: () => 2_000,
        });
        expect(adapter.calls.length).toBeGreaterThan(1);
        // Adjacent chunk calls overlap by ~240s.
        for (let i = 1; i < adapter.calls.length; i++) {
            expect(adapter.calls[i].firstSec).toBeLessThanOrEqual(
                adapter.calls[i - 1].lastSec - 239,
            );
        }
        expect(result.terminalResponse.status).toBe('ready');
        if (result.terminalResponse.status !== 'ready') return;
        expect(result.terminalResponse.promoBlocks).toEqual([
            { startSec: 20, endSec: 60, confidence: 'high' },
        ]);
        // Usage is summed across chunk calls.
        expect(result.analysisRun.usage?.inputTokens).toBe(
            100 * adapter.calls.length,
        );
        expect(result.analysisRun.usage?.costUsd).toBeCloseTo(
            0.01 * adapter.calls.length,
        );
    });

    it('stitches one block reported by two overlapping chunks', async () => {
        // Probe run first: discover where the first chunk ends with this
        // transcript shape, so the real adapter can place a promo block that
        // straddles that boundary.
        const probe = makeAdapter(() => JSON.stringify({ hasPromo: false }));
        await BackendPromoAnalysisWorker.analyze({
            transcriptArtifact: makeArtifact(),
            durationSec: TOTAL_SEC,
            nowMs: 1_000,
            adapter: probe,
            clock: () => 2_000,
        });
        expect(probe.calls.length).toBeGreaterThan(1);
        const boundary = probe.calls[0].lastSec;

        // Chunk 1 sees only the first half of the promo and reports
        // [boundary-120 .. boundary]; chunk 2 (whose 240s overlap covers the
        // promo start) reports the full [boundary-120 .. boundary+120].
        const adapter = makeAdapter((input) => {
            const segs = input.transcriptArtifact.segments;
            const firstSec = segs[0].startSec;
            const lastSec = segs[segs.length - 1].startSec;
            if (firstSec === 0) {
                return JSON.stringify({
                    hasPromo: true,
                    promoBlocks: [
                        {
                            startSec: boundary - 120,
                            endSec: boundary,
                            confidence: 'high',
                        },
                    ],
                });
            }
            const seesPromoStart =
                firstSec <= boundary - 120 && lastSec >= boundary + 120;
            if (seesPromoStart) {
                return JSON.stringify({
                    hasPromo: true,
                    promoBlocks: [
                        {
                            startSec: boundary - 120,
                            endSec: boundary + 120,
                            confidence: 'high',
                        },
                    ],
                });
            }
            return JSON.stringify({ hasPromo: false });
        });

        const result = await BackendPromoAnalysisWorker.analyze({
            transcriptArtifact: makeArtifact(),
            durationSec: TOTAL_SEC,
            nowMs: 1_000,
            adapter,
            clock: () => 2_000,
        });
        expect(result.terminalResponse.status).toBe('ready');
        if (result.terminalResponse.status !== 'ready') return;
        expect(result.terminalResponse.promoBlocks).toHaveLength(1);
        const block = result.terminalResponse.promoBlocks[0];
        expect(block.startSec).toBe(boundary - 120);
        expect(block.endSec).toBe(boundary + 120);
    });

    it('retries a failed chunk once, then fails the whole job', async () => {
        let failures = 0;
        const adapter = makeAdapter((input) => {
            const firstSec =
                input.transcriptArtifact.segments[0]?.startSec ?? 0;
            if (firstSec > 0) {
                failures += 1;
                return new Error('provider down');
            }
            return JSON.stringify({ hasPromo: false });
        });
        const result = await BackendPromoAnalysisWorker.analyze({
            transcriptArtifact: makeArtifact(),
            durationSec: TOTAL_SEC,
            nowMs: 1_000,
            adapter,
            clock: () => 2_000,
        });
        expect(failures).toBe(2);
        expect(result.terminalResponse.status).toBe('error');
        if (result.terminalResponse.status !== 'error') return;
        expect(result.terminalResponse.error.code).toBe(
            'model_provider_error',
        );
        expect(result.analysisRun.failureReason).toBe('model_provider_error');
    });

    it('returns no_promo when every chunk is empty', async () => {
        const adapter = makeAdapter(() =>
            JSON.stringify({ hasPromo: false }),
        );
        const result = await BackendPromoAnalysisWorker.analyze({
            transcriptArtifact: makeArtifact(),
            durationSec: TOTAL_SEC,
            nowMs: 1_000,
            adapter,
            clock: () => 2_000,
        });
        expect(result.terminalResponse.status).toBe('no_promo');
        expect(result.analysisRun.rawModelResponse).toContain('[chunk 0');
    });
});
```

Adjust `makeArtifact()` field names to the real `TranscriptArtifact` type in
`backend/src/extraction/subtitle-extraction-types.ts` if any differ (check
`strategy` and `videoDurationSec` — mirror an existing worker test's fixture,
e.g. in `backend/tests/`, as the authority).

- [x] **Step 2: Run to verify failure**

Run: `pnpm vitest run backend/tests/promo-analysis-worker-chunking.test.ts`
Expected: FAIL — adapter is called once with the whole transcript (call count
assertion fails).

- [x] **Step 3: Rework `analyze` into a chunk loop**

In `promo-analysis-worker.ts`, add imports:

```ts
import { buildServerTranscriptChunks } from '@topskip/backend/analysis/promo-analysis-chunking';
import { ChunkMerge } from '@topskip/common/promo-chunk-merge';
import { mergePromoBlocksWithGap } from '@topskip/common/promo-dedupe';
import {
    BLOCK_MERGE_GAP_SEC,
    CHUNK_BLOCK_TOLERANCE_SEC,
} from '@topskip/common/promo-chunking-config';
```

Replace the body of `analyze` between metadata validation (keep lines
100–107) and the final ready/no-promo construction with:

```ts
        const chunkPlan = buildServerTranscriptChunks(
            input.transcriptArtifact.segments,
        );
        if (!chunkPlan.ok) {
            return BackendPromoAnalysisWorker.failure(input, {
                provider: adapterMetadata.provider,
                rawModelResponse: null,
                parsedResult: null,
                normalizedPromoBlocks: [],
                failureReason:
                    BACKEND_ANALYSIS_FAILURE_REASON.ModelProviderError,
                model: adapterMetadata.model,
                promptVersion: adapterMetadata.promptVersion,
                completedAtMs: BackendPromoAnalysisWorker.readClock(input),
            });
        }

        let mergedBlocks: PromoBlock[] = [];
        const rawResponses: string[] = [];
        let usage: BackendLlmAnalysisUsage | undefined;
        let model = adapterMetadata.model;

        for (const chunk of chunkPlan.chunks) {
            const chunkArtifact = {
                ...input.transcriptArtifact,
                segments: chunk.segments,
            };
            const attempt = await BackendPromoAnalysisWorker.analyzeChunkWithRetry(
                adapter,
                chunkArtifact,
            );
            if (!attempt.ok) {
                return BackendPromoAnalysisWorker.failure(input, {
                    provider: adapterMetadata.provider,
                    rawModelResponse: attempt.rawModelResponse,
                    parsedResult: null,
                    normalizedPromoBlocks: [],
                    failureReason: attempt.failureReason,
                    model,
                    promptVersion: adapterMetadata.promptVersion,
                    usage,
                    completedAtMs: BackendPromoAnalysisWorker.readClock(input),
                });
            }

            model = attempt.model;
            rawResponses.push(
                `[chunk ${String(chunk.index)} ${String(chunk.startSec)}-${String(chunk.endSec)}s]\n${attempt.rawModelResponse}`,
            );
            if (attempt.usage !== undefined) {
                usage = {
                    inputTokens:
                        (usage?.inputTokens ?? 0) + attempt.usage.inputTokens,
                    outputTokens:
                        (usage?.outputTokens ?? 0) +
                        attempt.usage.outputTokens,
                    ...(attempt.usage.costUsd !== undefined ||
                    usage?.costUsd !== undefined
                        ? {
                              costUsd:
                                  (usage?.costUsd ?? 0) +
                                  (attempt.usage.costUsd ?? 0),
                          }
                        : {}),
                };
            }

            if (!attempt.parsedResult.hasPromo) {
                continue;
            }
            const filtered = ChunkMerge.filterPromoBlocksForChunkTimeRange(
                attempt.parsedResult.promoBlocks,
                chunk.startSec,
                chunk.endSec,
                CHUNK_BLOCK_TOLERANCE_SEC,
            );
            mergedBlocks = mergePromoBlocksWithGap(
                [...mergedBlocks, ...filtered],
                BLOCK_MERGE_GAP_SEC,
            );
        }

        const completedAtMs = BackendPromoAnalysisWorker.readClock(input);
        const rawModelResponse = rawResponses.join('\n\n');
        const combinedParsedResult: ParsedModelPromoResult =
            mergedBlocks.length > 0
                ? { hasPromo: true, promoBlocks: mergedBlocks }
                : { hasPromo: false };
```

Then reuse the existing tail logic with the combined values:

- The `!parsed.parsedResult.hasPromo` branch (old lines 147–170) becomes
  `if (!combinedParsedResult.hasPromo)` and passes `rawModelResponse`,
  `combinedParsedResult`, `usage`, `model`, `completedAtMs` into
  `buildAnalysisRun` / `buildNoPromoResponse`.
- The normalization + ready branch (old lines 172–208) normalizes
  `mergedBlocks` and passes the same combined fields.

Add the private helper:

```ts
    /**
     * One chunk analysis with a single retry; parse failures and provider
     * throws share the retry so a transient bad response cannot fail a
     * multi-minute job outright.
     *
     * @param adapter - Backend LLM adapter.
     * @param chunkArtifact - Transcript slice for this chunk.
     * @returns Parsed chunk outcome, or a stable failure after the retry.
     */
    private static async analyzeChunkWithRetry(
        adapter: BackendLlmAnalysisAdapter,
        chunkArtifact: TranscriptArtifact,
    ): Promise<
        | {
              ok: true;
              parsedResult: ParsedModelPromoResult;
              rawModelResponse: string;
              model: string;
              usage?: BackendLlmAnalysisUsage;
          }
        | {
              ok: false;
              failureReason: BackendAnalysisFailureReason;
              rawModelResponse: string | null;
          }
    > {
        let lastFailure:
            | {
                  failureReason: BackendAnalysisFailureReason;
                  rawModelResponse: string | null;
              }
            | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
            let adapterResult: BackendLlmAnalysisAdapterResult;
            try {
                adapterResult = await adapter.analyze({
                    transcriptArtifact: chunkArtifact,
                });
            } catch {
                lastFailure = {
                    failureReason:
                        BACKEND_ANALYSIS_FAILURE_REASON.ModelProviderError,
                    rawModelResponse: null,
                };
                continue;
            }
            const parsed = parseBackendPromoResponse(
                adapterResult.rawModelResponse,
            );
            if (!parsed.ok) {
                lastFailure = {
                    failureReason: parsed.failureReason,
                    rawModelResponse: adapterResult.rawModelResponse,
                };
                continue;
            }
            return {
                ok: true,
                parsedResult: parsed.parsedResult,
                rawModelResponse: adapterResult.rawModelResponse,
                model: adapterResult.model,
                usage: adapterResult.usage,
            };
        }
        return { ok: false, ...(lastFailure as NonNullable<typeof lastFailure>) };
    }
```

Check `ParsedModelPromoResult`'s no-promo variant shape in
`promo-analysis-types.ts:20-28` (it is a union where `hasPromo: false` has no
`promoBlocks`) and match `combinedParsedResult` to it exactly.

- [x] **Step 4: Run the new tests**

Run: `pnpm vitest run backend/tests/promo-analysis-worker-chunking.test.ts`
Expected: PASS.

- [x] **Step 5: Run existing worker/job tests**

Run: `pnpm vitest run backend/tests`
Expected: PASS — short-transcript fixtures produce a single chunk, so
existing expectations (single adapter call, raw response content) hold except
where a test asserts the exact `rawModelResponse` string; update those to
expect the `[chunk 0 …]` prefix.

**Verification**: all backend tests pass.

### [x] Task 7: Bump the algorithm version to server-v6

**Files:**

- Modify: `common/src/server-analysis-contract.ts:13`
- Modify: 13 test files hardcoding `'server-v5'`, plus
  `backend/src/cache-fixtures.ts:15`

- [x] **Step 1: Bump the constant**

```ts
export const SERVER_ANALYSIS_ALGORITHM_VERSION = 'server-v6';
```

- [x] **Step 2: Update hardcoded fixtures**

List the files: `grep -rln "server-v5" backend backend/tests extension/tests common/tests --include="*.ts"`. In each, replace the literal `server-v5` with
`server-v6` (including `backend/src/cache-fixtures.ts:15`
`result-e2eFixture1-server-v5`). Do not touch
`backend/src/legacy/**` if its literals describe the legacy contract —
inspect each hit before replacing.

- [x] **Step 3: Full test run**

Run: `pnpm test`
Expected: PASS.

**Verification**: `grep -rn "server-v5" --include="*.ts" backend common extension | grep -v legacy` returns nothing unexpected.

## Final Verification

- [x] `pnpm test` — full suite green (837 passed).
- [x] `pnpm lint` — format, oxlint, eslint, markdownlint, tsc all green.
- [x] `pnpm format` applied (2 files reformatted).
- [ ] Manual end-to-end (NOT run — real paid OpenRouter calls; covered by tests): start the local backend (`.claude/launch.json`
  "backend" config or `pnpm backend:dev`), build the dev extension
  (`pnpm dev`), open the 3h46m video `CqXG2dg7WIY`; in the backend logs expect
  several `model-analysis-started`-stage adapter calls for one job and a
  terminal `analysis-completed` whose `inputTokens` is the sum over chunks;
  the popup should show blocks (cache is cold because of the v6 bump).

## Notes

- **Cost**: chunking adds ~15–20% input-token duplication (overlap) plus one
  system prompt per chunk; the observed $0.199 full-video call becomes
  roughly $0.25–0.28 — well under the $1 per-job budget reservation
  (`MODEL_RESERVATION_USD`, `backend/src/public-state.ts:24`, raised from
  $0.35 ahead of this work). No budget-flow change needed.
- **Latency**: sequential chunk calls, typical 4–5 chunks × ~15 s ≈ ≤ 75 s per
  long video; the extension's polling loop already handles multi-minute jobs.
  Parallelizing chunks is deliberate future work (YAGNI).
- **Cache rollover**: the v6 bump invalidates all cached v5 results (including
  short videos whose analysis is unchanged) — acceptable one-time re-analysis
  cost; it is the mechanism that fixes already-cached long-video results.
- **Scope**: this touches common/extension/backend, which is at the upper
  bound for a quick spec; it stayed here because the extension change is a
  mechanical API migration and the behavior change is confined to the backend
  worker. If implementation reveals contract/API changes, stop and switch to
  the full SDD flow.
