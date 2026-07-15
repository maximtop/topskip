# Implementation Plan: Chunked Promo Detection over Full Transcript

**Spec**: `.sdd/20260419-chunked-promo-detection-full-transcript/spec.md`  
**Created**: 2026-04-19  
**Status**: Validated

## Summary

Replace single-pass transcript analysis with provider-budget-aware chunked analysis:

- keep `LlmProviderAdapter.analyzeTranscript()` single-shot,
- add adapter budget discovery (`maxTranscriptChars()`),
- split merged transcript into overlapping line-aligned chunks when needed,
- analyze chunks sequentially with bounded retry on `tooLarge`,
- progressively publish merged promo blocks,
- and emit full-fidelity per-chunk + aggregate logs (sent text, raw response, latency).

This plan is explicitly designed to eliminate silent truncation for long non-Latin transcripts (the current Chrome Prompt API failure mode) while preserving one-call behavior when a transcript fits.

## Technical Context

| Topic | Detail |
|---|---|
| Core pipeline | `src/background/messaging/promo-analysis.ts` |
| Adapter contract | `src/background/providers/llm-provider-adapter.ts` |
| Providers | `src/background/providers/chrome-prompt-api-adapter.ts`, `src/background/providers/openrouter-adapter.ts` |
| Transcript merge | `src/shared/captions/merge-transcript.ts` |
| Existing analysis logs | `src/background/openrouter/log-promo-analysis.ts` |
| Content behavior | `src/content/youtube-watch.ts` (block application and fired-tracking) |
| Message schema | `src/shared/messages.ts` + `PromoDetectionStatePayload` |
| Test stack | Vitest + existing unit test layout under `tests/background/**`, `tests/content/**`, `tests/shared/**` |

## File Changes

### New Files

- `src/background/messaging/chunk-plan-config.ts`
- `src/background/messaging/chunk-planner.ts`
- `src/background/messaging/chunk-merge.ts`
- `tests/background/messaging/chunk-planner.test.ts`
- `tests/background/messaging/chunk-merge.test.ts`

### Modified Files

- `src/background/providers/llm-provider-adapter.ts`
- `src/background/providers/chrome-prompt-api-adapter.ts`
- `src/background/providers/openrouter-adapter.ts`
- `src/background/messaging/promo-analysis.ts`
- `src/background/openrouter/log-promo-analysis.ts`
- `src/content/youtube-watch.ts`
- `src/shared/messages.ts` (optional `partialCoverage` payload extension)
- `tests/background/providers/chrome-prompt-api-adapter.test.ts`
- `tests/background/providers/openrouter-adapter.test.ts`
- `tests/background/messaging/promo-analysis.test.ts` (or current equivalent)
- `tests/content/youtube-watch*.test.ts` / skip logic tests

## Tasks

### Phase 1 - Adapter Contract and Errors

### [ ] Task 1.1: Extend adapter interface for chunk planning

**Goal**: Add `maxTranscriptChars()` and structured `tooLarge` errors.

**Changes**:

- In `llm-provider-adapter.ts`:
  - add `maxTranscriptChars(): Promise<number>`,
  - extend `AnalyzeTranscriptResult` to represent `tooLarge` distinctly (not string parsing).

**Notes**:

- Keep backward compatibility for callers by preserving `ok` discriminator.

**Verify**:

- `pnpm run lint:types`

---

### [ ] Task 1.2: Implement `maxTranscriptChars()` in providers

**Goal**: Budget discovery is provider-owned and conservative.

**Chrome adapter**:

- derive from `contextWindow - contextUsage - RESPONSE_TOKEN_RESERVE`,
- calibrate chars-per-token with `measureContextUsage(probe)` when possible,
- fallback to conservative ratio (`<= 2 chars/token`) on calibration failure.

**OpenRouter adapter**:

- return `Number.MAX_SAFE_INTEGER` (or model-map if added later).

**Verify**:

- provider unit tests updated for budget method behavior.

---

### [ ] Task 1.3: Remove in-adapter transcript truncation

**Goal**: truncation moves from adapter to planner; adapter only checks fit.

**Chrome adapter behavior**:

- no phase-1/phase-2 tail-cut flow,
- fit-check with `measureContextUsage` on incoming chunk,
- return `tooLarge` when chunk still exceeds fit.

**OpenRouter adapter behavior**:

- map provider context-length errors (HTTP 400 context limit) to `tooLarge`.

**Verify**:

- adapter tests assert no silent truncation path,
- `tooLarge` emitted and handled.

## Phase 2 - Chunk Plan + Merge Core

### [ ] Task 2.1: Add chunk planning constants module

**Goal**: Centralize and type all tunables from FR-010.

Include:

- `MAX_CHUNKS_PER_VIDEO = 8`
- `OVERLAP_FRACTION = 0.15`
- `OVERLAP_FLOOR_SEC = 30`
- `OVERLAP_CEILING_SEC = 90`
- `BLOCK_MERGE_GAP_SEC = 3`
- `CHUNK_BLOCK_TOLERANCE_SEC = 5`
- `LOG_CHUNK_TEXT_MAX_CHARS = 200_000`
- `LOG_RAW_ASSISTANT_MAX_CHARS = 64_000`
- `LOG_MERGED_TEXT_MAX_CHARS = 300_000`

**Verify**:

- lint/types pass.

---

### [ ] Task 2.2: Implement line-aligned chunk planner

**Goal**: deterministic chunk generation from merged transcript lines.

Planner requirements:

- no mid-line splits,
- overlap in seconds constrained by floor/ceiling,
- overlap clamped to <= 50% chunk budget for forward progress,
- cap-aware planning (`MAX_CHUNKS_PER_VIDEO`) with overlap reduction,
- marks `partialCoverage` when plan must truncate.

**Verify**:

- `chunk-planner.test.ts`:
  - one-chunk fit case,
  - multi-chunk overlap case,
  - cap exceeded and reduced-overlap fallback,
  - deterministic repeated output.

---

### [ ] Task 2.3: Implement cross-chunk block merge utility

**Goal**: canonical block list after each chunk.

Rules:

- sort by `startSec`,
- merge overlap/near-touching gaps (`<= BLOCK_MERGE_GAP_SEC`),
- confidence = max source confidence,
- dedupe overlap duplicates.

**Verify**:

- `chunk-merge.test.ts` for exact duplicate, nested, overlap, chain, disjoint.

## Phase 3 - Pipeline Refactor (`PromoAnalysis`)

### [ ] Task 3.1: Introduce multi-chunk execution loop

**Goal**: run planned chunks sequentially through adapter.

Flow:

1. merge full transcript (existing helper),
2. query `adapter.maxTranscriptChars()`,
3. plan chunks,
4. execute chunks in chronological order,
5. on each success: parse/filter/merge/publish progressively.

**Verify**:

- updated pipeline tests for one-chunk and multi-chunk paths.

---

### [ ] Task 3.2: Implement bounded `tooLarge` re-split retry

**Goal**: one retry only, non-recursive.

On first `tooLarge`:

- split that chunk input into two line-aligned halves,
- preserve overlap at new boundary,
- retry once.

On second `tooLarge`:

- mark slice failed,
- continue remaining chunks,
- set `partialCoverage = true`.

**Verify**:

- test covers retry path and bounded-call guarantee.

---

### [ ] Task 3.3: Apply chunk-local timestamp sanity filtering

**Goal**: drop hallucinated spans outside chunk time range (+ tolerance).

Use `CHUNK_BLOCK_TOLERANCE_SEC` and keep existing parse/duration validation.

**Verify**:

- test with out-of-range spans; ensure dropped before merge.

## Phase 4 - Observability and Logs

### [ ] Task 4.1: Add per-chunk log builder

**Goal**: log exact sent text, exact raw response, per-call latency.

Per entry fields:

- `chunkIndex`, `chunkCount`,
- `chunkStartSec`, `chunkEndSec`,
- `chunkChars`,
- `promptVersion`,
- `chunkText` (with explicit truncation marker only over max),
- `rawAssistant` (same),
- `parsedBlocks`,
- `adapterLatencyMs`,
- `adapterOutcome`.

**Verify**:

- log helper tests for required fields and marker behavior.

---

### [ ] Task 4.2: Extend aggregate log bundle

**Goal**: complete run-level observability.

Add:

- `mergedTranscriptText`,
- `plannedBudgetChars`, `overlapSec`, `totalChunks`,
- `totalAdapterCalls`,
- `coverageFraction`, `partialCoverage`, `uncoveredRanges`,
- `mergedBlocks`,
- `totalAdapterLatencyMs`, `totalWallClockMs`,
- `globalTruncated`,
- prompt text once per aggregate record.

**Verify**:

- tests for aggregate completeness + secret redaction invariants.

## Phase 5 - Content Script Consistency

### [ ] Task 5.1: Switch fired-block tracking to `startSec` key

**Goal**: avoid re-fire when progressive updates renumber block indices.

Implementation:

- replace index-based `Set<number>` with stable key set (rounded `startSec`).

**Verify**:

- test: block list updated mid-playback does not double-fire already skipped block.

---

### [ ] Task 5.2: Handle optional `partialCoverage` in status payload

**Goal**: preserve old behavior while exposing partial-coverage metadata.

**Verify**:

- message/type tests compile and runtime consumers tolerate missing field.

## Phase 6 - Tests and Validation

### [ ] Task 6.1: Unit test matrix

Required suites:

- chunk planner,
- chunk merge,
- provider budget + `tooLarge` behavior,
- pipeline one-chunk/no-regression path,
- pipeline multi-chunk progressive publish,
- retry + irreducible chunk handling,
- logging completeness + no-secrets.

---

### [ ] Task 6.2: Manual validation checklist

1. Reproduce failing Russian transcript run (`chrome-prompt-api`):
   - >1 chunk,
   - no silent truncation,
   - at least one realistic non-degenerate block.
2. OpenRouter transcript-fit run:
   - exactly one adapter call,
   - output parity with previous behavior.
3. Forced over-cap run:
   - `partialCoverage: true`,
   - uncovered ranges visible in aggregate logs.
4. Confirm per-call logs include:
   - sent chunk text,
   - raw response,
   - latency.

---

### [ ] Task 6.3: Repo quality gates

- `pnpm run lint`
- `pnpm run build`
- `pnpm run test`
- `pnpm run test:coverage`
- `pnpm run test:e2e`

## Spec Coverage Matrix

| Spec Area | Plan Tasks |
|---|---|
| FR-001 budget discovery | 1.1, 1.2 |
| FR-002 chunk planning + retry | 2.2, 3.1, 3.2 |
| FR-003 sequential execution | 3.1 |
| FR-004 progressive publication | 3.1 |
| FR-005 abort semantics | 3.1 |
| FR-006 in-range filtering | 3.3 |
| FR-007 final status + partialCoverage | 3.1, 3.2, 5.2 |
| FR-008 `startSec` fired keying | 5.1 |
| FR-009 logging fields | 4.1, 4.2 |
| FR-010 constants module | 2.1 |
| FR-011 global truncation visibility | 4.2 |
| FR-012 no in-adapter truncation + `tooLarge` | 1.3, 3.2 |
| FR-013 one-call parity for fit transcripts | 1.2, 3.1 |
| NFR-001 to NFR-005 | 1.2, 2.2, 2.3, 6.1 |
| SC-001..SC-008 | 3.x, 4.x, 5.x, 6.x |

## Risks and Mitigations

- **Risk: log volume too high**  
  Mitigation: bounded `LOG_*_MAX_CHARS` with explicit truncation markers and aggregate-only prompt text.

- **Risk: budget estimate drift for non-Latin scripts**  
  Mitigation: `measureContextUsage` probe calibration + conservative fallback + bounded re-split retry.

- **Risk: progressive updates re-trigger skips**  
  Mitigation: `startSec` keyed fired tracking and dedicated tests.

- **Risk: complexity regression in one-chunk path**  
  Mitigation: explicit one-chunk parity tests and adapter call-count assertions.
