# Feature Specification: Chunked Promo Detection over Full Transcript

**Created**: 2026-04-19
**Status**: Validated
**Model**: Claude Opus 4.6 (high)
**Input**: User description: "I get no results while I know there were promo blocks.
Instead of truncating passed captions I want to pass **all** of them, even if it
takes several requests to the LLM. Context overflow is real in my corpus (the
Chrome Prompt API adapter keeps truncating 74k-char transcripts to ~33k for
Cyrillic captions, so early/mid-video promos are silently dropped). I don't want
keyword-based prefilters because they fail on some languages, and I don't want
SponsorBlock — TopSkip must work standalone."

## Context

Earlier iterations shipped:

- **`20260415-openrouter-multi-block-promo-detection`** — single LLM call per
  video over a merged transcript, with deterministic truncation to
  `MAX_CAPTION_TRANSCRIPT_CHARS = 120_000` as the only overflow mitigation.
- **`20260418-llm-provider-abstraction-chrome-built-in-ai-integration`** —
  introduced the `LlmProviderAdapter` interface and added an on-device
  `ChromePromptApiAdapter` (Gemini Nano). Because Gemini Nano has a small
  context window (~4–8k tokens), the adapter truncates transcripts per call
  (phase-1 char heuristic plus phase-2 `measureContextUsage` halving, keeping
  the **tail**).

Observed failure (captured in dev logs): for a 74 459-char Russian-language
transcript the Chrome adapter silently cut ~55% of the text and returned a
single degenerate promo block spanning the full video (`startSec: 0`,
`endSec: 3233.04`), while the user can manually verify that multiple real
promo integrations exist earlier in the video. Any truncation that discards
captions loses coverage of the discarded region. This specification replaces
"truncate to fit" with "chunk the full transcript and run the adapter N
times".

## Assumptions

- **Full-coverage, not full-context**: The orchestrator MUST send **every**
  caption segment to the active provider across one or more adapter calls per
  video. No segment may be silently discarded because of provider context
  limits. Deterministic drop of malformed segments (empty text, invalid
  timestamps) remains allowed.
- **Adapters stay single-shot**: `LlmProviderAdapter.analyzeTranscript` keeps
  its current contract — it analyzes **one** transcript string and returns
  zero or more promo blocks. Chunking is **orchestrated in the pipeline**
  (`src/background/messaging/promo-analysis.ts`), not duplicated inside each
  adapter.
- **Adapters expose a chunk budget**: Adapters MUST advertise an effective
  character budget per call via a new method on the interface (e.g.
  `maxTranscriptChars(): Promise<number>`). Implementations:
  - `ChromePromptApiAdapter` computes this from `session.contextWindow`,
    `contextUsage`, and `RESPONSE_TOKEN_RESERVE`, converted to chars with
    language-aware calibration (current `CHARS_PER_TOKEN = 4` is wrong for
    Cyrillic/CJK; the implementation SHOULD measure once via
    `measureContextUsage` on a known-length probe string and cache the ratio
    per session, or keep a conservative floor).
  - `OpenRouterAdapter` returns a constant defined per-model or a sentinel
    (`Infinity` / `Number.MAX_SAFE_INTEGER`) signalling "single chunk fits";
    the pipeline MUST treat any budget ≥ merged-transcript length as "one
    chunk".
- **Chunks are derived from the merged transcript lines, not raw chars**: The
  merged transcript already uses `[startSec] text\n…` per caption segment
  (see `mergeCaptionSegmentsToTranscript`). Chunk boundaries MUST be newline
  boundaries so each chunk corresponds to a contiguous, time-ordered set of
  caption segments. No chunk may start or end mid-line.
- **Chunks overlap in time**: Adjacent chunks MUST share an **overlap window**
  (caption segments at the tail of chunk `i` repeat at the head of chunk
  `i + 1`). Default overlap target: **15%** of the per-chunk character
  budget, subject to a floor of 30 seconds of video time and a ceiling of
  90 seconds. Rationale: a promo integration shorter than the overlap window
  is guaranteed to appear wholly inside at least one chunk; longer promos
  appear with continuity in at least one overlap region where spans from both
  sides can be merged.
- **Span merging replaces boundary reconciliation**: This spec does **not**
  introduce a second-pass LLM call for boundary reconciliation. Overlap plus
  deterministic span merging (IoU / gap-threshold union) is the only
  cross-chunk continuity mechanism in scope. Second-pass reconciliation is
  explicitly deferred until measured data shows overlap+merge is insufficient.
- **Hard call budget per video**: The pipeline MUST enforce an upper bound on
  the number of adapter calls per video (`MAX_CHUNKS_PER_VIDEO`, default
  **8**). If the full transcript with the chosen chunk budget would require
  more chunks than the limit, the pipeline MUST either (a) coarsen the chunk
  budget upward for providers that can accept it (e.g. shrink overlap toward
  the floor), or (b) stop after the limit and report a partial-coverage
  status. It MUST NOT silently discard the tail.
- **Sequential execution by default**: Chunks run **sequentially** to preserve
  on-device model stability and to allow progressive publication of detected
  blocks. Parallel execution is an **implementation option** for remote
  adapters only; not required.
- **Progressive publication**: As each chunk completes and yields validated
  blocks, the pipeline MUST publish the currently merged block set to the
  content script via the existing `TOPSKIP_PROMO_BLOCKS_DETECTED` message.
  This lets the player start skipping early promos before later chunks
  finish. Each downstream update MUST supersede the previous block list for
  the same `videoId`.
- **Deterministic ordering and deduplication**: After each chunk the pipeline
  MUST merge newly detected blocks into the running list and output a
  canonical form: sorted by `startSec`, with overlapping or near-touching
  blocks (gap ≤ `BLOCK_MERGE_GAP_SEC`, default **3 s**) unioned into a single
  block. Confidence of a merged block is the maximum of its sources. Blocks
  originating only from overlap regions (i.e. reported by two adjacent
  chunks with near-identical spans) MUST be deduplicated, not double-counted.
- **Per-chunk failure handling**: If one chunk fails (provider error, parse
  error, abort), the pipeline MUST continue with remaining chunks and
  surface a partial-coverage status if any chunk failed. A single successful
  chunk MAY still yield valid skips.
- **Cancellation and SPA navigation**: All chunk calls MUST share one
  `AbortSignal`. A new `videoId` or tab navigation MUST abort all pending
  chunks for the previous video; late chunk responses MUST be ignored.
- **No behavior change when one chunk is enough**: For providers whose budget
  covers the full transcript (current OpenRouter typical case), the pipeline
  MUST produce exactly **one** adapter call. Multi-chunk behavior is opt-in
  by the adapter's advertised budget, not always-on.
- **Prompt contract per chunk is unchanged**: Each chunk sends the existing
  `PROMO_DETECTION_SYSTEM_PROMPT` plus the chunk's transcript text. The
  system prompt does **not** need chunk-awareness (it already instructs the
  model to return blocks found within the provided text). Timestamps in the
  transcript lines remain absolute video seconds so the model cannot
  mis-report chunk-local offsets.
- **Storage and schema unchanged**: `browser.storage.local` keys, `PromoBlock`
  shape, `llmPromoDetectionSchema`, and all `TOPSKIP_*` message types from
  prior specs remain as-is. Only the pipeline orchestrator changes; no new
  runtime-message types are required.

## Product Decision

When a video's merged transcript exceeds the active provider's advertised
per-call budget, TopSkip splits the transcript into overlapping chunks,
analyzes each in sequence through the same `LlmProviderAdapter` interface,
and merges the resulting promo blocks into a single sorted, deduplicated
list. The content script receives progressively refined block lists and
applies skips per block as before. No caption text is silently discarded.

A hard chunk budget protects cost on remote providers. If the chunk count
would exceed `MAX_CHUNKS_PER_VIDEO`, the pipeline widens the per-chunk budget
(shrinking overlap) before giving up, and reports a partial-coverage status
if it still cannot cover the full transcript within the cap.

The current failure mode — "hasPromo: true with one bogus 0 → duration
block because the tail-only truncated transcript confused the model" — is
eliminated by never truncating the transcript away from the adapter in the
first place. When the model sees the full video context, its blocks
correspond to the real timeline, not the artifact of a cut.

## User Scenarios & Testing

### User Story 1 — Long on-device transcript produces accurate blocks (Priority: P1)

A user selects Chrome Built-in (Gemini Nano) and opens a Russian-language
YouTube video whose merged transcript is ~74 000 chars (exceeds on-device
context). Promo detection returns the real promo blocks, not a single
degenerate span.

**Why this priority**: This is the reported regression driving the spec.

**Independent Test**: Use the current `openrouter-compare-presets` harness
(or an equivalent developer tool) with a captured caption payload known to
contain at least one mid-video promo. Run detection with the chunked
pipeline enabled. Verify: (a) adapter was invoked more than once;
(b) merged block list contains at least one block matching a manually
identified promo within ±30 s; (c) no block spans the entire video.

**Acceptance Scenarios**:

1. **Given** `chrome-prompt-api` is the active provider and the merged
   transcript exceeds the adapter's `maxTranscriptChars()`, **When**
   detection runs, **Then** the adapter is invoked N times (N ≥ 2), each
   call receives a contiguous overlapping slice of the transcript, and no
   caption segment is missing from the union of all chunks' inputs.
2. **Given** one chunk reports a promo from 120 s to 200 s and an adjacent
   overlapping chunk reports a promo from 180 s to 210 s, **When** the
   pipeline merges results, **Then** the published block list contains a
   single block spanning 120 s to 210 s (max end, min start, max
   confidence).
3. **Given** a detection run that requires 3 chunks, **When** the first
   chunk completes with blocks and subsequent chunks are still running,
   **Then** the content script receives a `PROMO_BLOCKS_DETECTED` message
   with the current block set so early skips can fire, and receives a
   superseding message after later chunks add or merge blocks.
4. **Given** the user navigates to a new `videoId` mid-analysis, **When**
   the navigation fires, **Then** all pending chunk calls for the previous
   video abort, no late chunk result is applied to the new video, and the
   new video's detection begins from scratch.

---

### User Story 2 — Cloud provider still does one call when the transcript fits (Priority: P1)

A user on OpenRouter with a large-context model opens a normal-length video;
the chunking machinery does **not** multiply cost.

**Why this priority**: The chunked pipeline must be a no-op when chunking
isn't needed.

**Independent Test**: With `openrouter` active and a transcript whose length
is below the adapter's advertised budget, confirm exactly one
`chat/completions` HTTP request per analysis (no regression versus the
current single-call behavior).

**Acceptance Scenarios**:

1. **Given** `OpenRouterAdapter.maxTranscriptChars()` returns a value ≥ the
   merged transcript length, **When** detection runs, **Then** the adapter
   is invoked exactly once and network shows one `POST` to
   `https://openrouter.ai/api/v1/chat/completions`.
2. **Given** the same setup, **When** the pipeline merges blocks, **Then**
   output is identical to the pre-chunking implementation (same sort,
   dedupe, clamping).

---

### User Story 3 — Partial coverage is surfaced, never hidden (Priority: P1)

If the transcript is so long that even after widening the chunk budget the
pipeline would need more than `MAX_CHUNKS_PER_VIDEO` adapter calls, the user
and developer see a partial-coverage status; results from processed chunks
are still applied.

**Why this priority**: Silent partial coverage was the original bug.
Truncation must never be invisible.

**Independent Test**: Synthesize a caption payload whose merged length
divided by the adapter's advertised budget exceeds
`MAX_CHUNKS_PER_VIDEO * (1 - OVERLAP)`. Confirm the detection log explicitly
records `coverageFraction < 1.0`, the popup status reflects partial
coverage, and the emitted block list covers only the analyzed prefix.

**Acceptance Scenarios**:

1. **Given** the required chunk count with default overlap exceeds the cap,
   **When** the pipeline plans chunks, **Then** it first reduces overlap
   toward the floor before giving up.
2. **Given** even the minimum-overlap plan exceeds the cap, **When** the
   pipeline runs, **Then** it analyzes chunks in chronological order up to
   the cap, marks the detection status as `detected` (if any blocks
   found) or `no_promo` (if none) **plus** a partial-coverage flag, and
   logs both the analyzed range and the unanalyzed tail range.
3. **Given** any chunk fails (adapter error), **When** remaining chunks
   succeed, **Then** the final status reflects partial coverage with an
   error detail; successful blocks still apply.

---

### User Story 4 — Observability per chunk (Priority: P2)

A developer inspecting the service worker console for an analysis run sees
one log entry per chunk (chunk index, time range, char count, blocks found,
raw assistant text) plus one aggregate entry with the merged block list and
coverage fraction.

**Why this priority**: The existing single-pass log format no longer
describes behavior. Without per-chunk logs, bugs in chunking, overlap, or
merging are invisible.

**Independent Test**: Run analysis with at least three chunks. In the
service worker console, confirm per-chunk lines in chronological order
followed by an aggregate summary.

**Acceptance Scenarios**:

1. **Given** a multi-chunk run, **When** the run completes, **Then** each
   chunk's log entry includes chunk index `i/N`, chunk start/end
   `startSec`, chunk char count, adapter outcome, parsed blocks, the
   **exact text sent** to the LLM (`chunkText`), the **exact raw
   response** from the LLM (`rawAssistant`), and the **LLM round-trip
   latency** (`adapterLatencyMs`). See FR-009 for the full field list.
2. **Given** the aggregate log, **When** inspected, **Then** it shows
   total chunks, total adapter calls (exceeds `totalChunks` iff a
   `tooLarge` re-split retry fired), coverage fraction, merged block
   list, total LLM-only latency (`totalAdapterLatencyMs`, sum of
   per-chunk round-trips), end-to-end wall clock
   (`totalWallClockMs`), and the full `mergedTranscriptText` as seen by
   the chunker.
3. **Given** any log output, **Then** no API key or `Authorization`
   header appears in any per-chunk or aggregate line, under any
   truncation or error condition.
4. **Given** a re-split retry occurs for a chunk, **When** the log is
   inspected, **Then** the original attempt and the retry appear as two
   distinct per-chunk entries with their own `adapterLatencyMs` values,
   and the aggregate's `totalAdapterCalls` reflects the extra call.

---

### User Story 5 — Deterministic merging (Priority: P2)

Overlap-driven duplicates and near-touching blocks merge into the smallest
canonical set without losing real separate promos.

**Why this priority**: Incorrect merging either over-merges (hiding real
mid-rolls) or under-merges (double-fires skips). Both are user-visible.

**Independent Test**: Unit tests with synthetic chunk outputs covering:
exact duplicate span, nested span, partially overlapping span, spans with
gap < `BLOCK_MERGE_GAP_SEC`, spans with gap ≥ `BLOCK_MERGE_GAP_SEC`.

**Acceptance Scenarios**:

1. **Given** two chunks report identical spans (within 1 s on both ends),
   **When** merged, **Then** one block remains.
2. **Given** two blocks separated by a gap greater than
   `BLOCK_MERGE_GAP_SEC`, **When** merged, **Then** both blocks remain
   distinct.
3. **Given** a block nested inside a wider block, **When** merged, **Then**
   the wider block is kept and the nested block is dropped; confidence is
   the max of the two.
4. **Given** N blocks forming a chain of overlaps, **When** merged, **Then**
   the result is one block with `min(startSec)` and `max(endSec)` and the
   maximum confidence in the chain.

## Out of Scope

- **Boundary-reconciliation second pass** (asking the LLM a narrow question
  at suspect boundaries). Overlap + deterministic merge only, for this
  milestone.
- **Parallel chunk dispatch**. Allowed as implementation freedom, not
  required; defaults sequential.
- **Keyword / regex prefilter** to narrow LLM attention. Explicitly
  rejected by the user (language fragility).
- **SponsorBlock integration / fallback**. Explicitly rejected (standalone
  product goal).
- **Timestamp-hallucination mitigation** (e.g., having the model quote
  caption text and mapping back deterministically). Addressed separately if
  it shows up in evaluation data.
- **Per-language `CHARS_PER_TOKEN` calibration beyond Gemini Nano**.
  Implementation SHOULD calibrate once per session; a deeper per-language
  token model is out of scope.
- **UI surface changes beyond partial-coverage flag**. The popup shows the
  existing statuses plus at most a small "partial" indicator when relevant;
  no new screens.
- **Changing the adapter interface's return type** to stream partial results
  from inside a single adapter call. Progressive publication comes from the
  pipeline calling the adapter multiple times, not from a streaming
  callback.

## Edge Cases

- **Provider budget is `0` or negative**: Treat as "adapter not currently
  usable" and fail fast with a `not_configured` status rather than calling
  with an empty transcript.
- **Merged transcript empty**: Skip analysis entirely; status `no_promo`
  (existing behavior).
- **Single-segment chunk that exceeds the adapter budget**: A chunk
  boundary cannot split a single caption line. If the pipeline's one-time
  re-split (FR-002 step 6) converges on a single caption line whose char
  count still exceeds the planning budget, and the adapter rejects it as
  `tooLarge` on execution (FR-012), the pipeline MUST NOT re-split
  further. It records the slice as a failed chunk with an
  `irreducible_chunk` marker, sets `partialCoverage: true`, and proceeds.
  Adapters MUST NOT silently truncate in this case — FR-012 forbids it.
- **Overlap larger than chunk**: When the budget is very small, the
  configured overlap window may exceed the per-chunk budget. The planner
  MUST clamp overlap to at most 50% of the chunk budget to guarantee
  forward progress (each new chunk MUST add at least 50% new content).
- **Block that straddles a chunk boundary without overlap coverage**: Only
  possible when overlap < promo length. The `OVERLAP_CEILING_SEC` of 90 s
  is chosen to cover typical promo lengths; unusually long sponsor reads
  (≥ 90 s) can still be split. Documented as a known residual risk; the
  overlap ceiling is a tunable.
- **SPA navigation with multi-chunk in flight**: Abort all pending chunks;
  do not publish any block list for the obsolete `videoId`; treat late
  chunk completions as no-ops.
- **Adapter returns `hasPromo: false` on one chunk and `hasPromo: true` on
  another**: The aggregate result is `hasPromo: true` with the union of
  detected blocks. A negative chunk does not invalidate positive chunks.
- **Model returns absurd timestamps** (negative, exceeding duration, or
  outside the chunk's own time range): Existing `parseLlmPromoResponse`
  validation and duration clamping still apply per chunk. Additionally,
  the pipeline SHOULD drop blocks whose `startSec` falls outside the
  chunk's time range plus a small tolerance, to resist the
  "full-video-span" hallucination observed today.
- **Progressive publication and content-script block-fired tracking**: The
  content script already tracks fired block indices by `videoId`. When a
  superseding block list arrives, indices may shift if merging renumbered
  blocks. The spec MUST either (a) key "already fired" by block
  `startSec`/`endSec` values rather than array index, or (b) only permit
  monotonic appends to the block list (new chunks can **add** blocks but
  not re-index earlier ones). The implementation plan MUST choose one.
  Preferred: key by `startSec` for resilience against renumbering.
- **`measureContextUsage` returns wrong ratio** for the first probe: the
  iterative halving fallback inside the adapter remains a last-resort guard
  inside a single chunk; it MUST NOT discard so much content that the chunk
  becomes empty. If the adapter cannot fit even a minimal chunk, it returns
  an error; the pipeline records and continues with the next chunk.

## Requirements

### Functional Requirements

- **FR-001**: `LlmProviderAdapter` MUST expose a new method
  `maxTranscriptChars(): Promise<number>` returning a **conservative**
  per-call character budget after accounting for system prompt and
  response reserve. The returned number is a **planning estimate**
  expressed in characters (UTF-16 code units, i.e. `String.length`),
  not tokens; real token counts depend on the model's tokenizer and on
  script (Latin ~3.5–4.5 chars/token, Cyrillic ~1.5–2.5, CJK ~0.6–1.5),
  so adapters MUST err on the side of under-reporting to avoid
  over-packed chunks. Adapters implement it as follows:
  - `ChromePromptApiAdapter`: computed from `session.contextWindow`,
    `contextUsage`, and `RESPONSE_TOKEN_RESERVE`. The adapter SHOULD
    calibrate a chars-per-token ratio once per session via a
    `session.measureContextUsage(probe)` call on a known-length probe
    string (ideally drawn from the current transcript so the ratio
    reflects the video's script). The calibrated ratio MAY be cached
    per language code across sessions. If calibration fails, fall back
    to a conservative constant (≤ 2 chars/token) rather than the
    Latin-biased default of 4. This probe is a tokenizer-level call, not
    model inference (see NFR-001).
  - `OpenRouterAdapter`: returns a constant per configured model (a lookup
    table or `Number.MAX_SAFE_INTEGER` as default) since OpenRouter does
    not expose a tokenizer counter to clients.

  The value returned is the pipeline's **planning** input (FR-002);
  authoritative fit verification happens per-chunk at execution time
  (FR-012).
- **FR-002**: The promo-analysis pipeline MUST plan chunks as follows:
  1. Merge all caption segments to the existing `[startSec] text\n…`
     transcript (no reduction beyond `MAX_CAPTION_TRANSCRIPT_CHARS`, which
     remains a last-resort global safety cap).
  2. Query `adapter.maxTranscriptChars()` to obtain the planning budget
     (henceforth `budget`).
  3. If `merged.text.length ≤ budget`, emit one chunk (whole transcript).
     This single-chunk branch MUST be byte-identical in output to the
     pre-chunking pipeline on the same input.
  4. Else, build overlapping chunks by walking newline-delimited lines
     (each line is one caption segment) so each chunk's char length ≤
     `budget`. Overlap size is
     `min(OVERLAP_CEILING_SEC of video time,
     max(OVERLAP_FLOOR_SEC, budget * OVERLAP_FRACTION))`.
  5. If the plan's chunk count exceeds `MAX_CHUNKS_PER_VIDEO`, reduce the
     overlap toward the floor. If still over the cap, truncate the plan
     to the cap and mark the run as partial-coverage.
  6. The comparison in step 3 is a **char-length heuristic** against the
     adapter's advertised planning budget. It is not authoritative: the
     adapter's real limit is in tokens, and the chars-per-token ratio is
     an estimate. When the adapter rejects a chunk at execution time with
     a "too large" error (see FR-012), the pipeline MUST re-split that
     chunk's input into two halves on line boundaries (preserving overlap
     at the new boundary) and retry **at most once**. If the retry also
     fails as too-large, the pipeline MUST record the chunk as failed,
     mark the run as partial-coverage, and continue with remaining
     chunks. This retry path is bounded: at most one re-split per
     originally-planned chunk, never recursive.
- **FR-003**: The pipeline MUST execute chunks **sequentially** in
  chronological order by default. Parallel execution is permitted only
  when explicitly implemented for a given adapter and MUST preserve result
  ordering in merging.
- **FR-004**: After every completed chunk, the pipeline MUST recompute the
  merged block list (sort by `startSec`; union adjacent/overlapping blocks
  with gap ≤ `BLOCK_MERGE_GAP_SEC`) and emit a
  `TOPSKIP_PROMO_BLOCKS_DETECTED` message carrying the current merged
  list. Each message supersedes the previous one for that `videoId`.
- **FR-005**: The pipeline MUST share one `AbortController` across all
  chunks for a given analysis. Any per-tab abort path (new videoId, tab
  close, provider change) MUST abort all pending chunks.
- **FR-006**: The pipeline MUST drop any promo block whose `startSec` lies
  outside the chunk's own time range plus a `CHUNK_BLOCK_TOLERANCE_SEC`
  slack (default **5 s**). Blocks whose `endSec` falls beyond the chunk
  range MAY extend outside (they'll merge with later chunks' blocks).
- **FR-007**: The final detection status for the run MUST reflect:
  - `detected` when at least one block survived merging.
  - `no_promo` when all chunks reported no promo and no error.
  - `error` when every chunk failed.
  - Additionally, a boolean partial-coverage flag (e.g.
    `partialCoverage: true`) MUST be set when (a) the chunk plan was
    truncated due to `MAX_CHUNKS_PER_VIDEO`, or (b) at least one chunk
    failed while others succeeded. This flag is forwarded to the popup
    status payload.
- **FR-008**: Content-script "already-fired" tracking for promo blocks MUST
  key on block `startSec` (rounded to an integer second) rather than array
  index, so progressive publication cannot cause a block to fire twice or
  lose its "already fired" marker when merging renumbers blocks.
- **FR-009**: The developer log MUST emit one structured per-chunk entry
  and one aggregate entry per run. API keys, `Authorization` headers, and
  any other secret material MUST NOT appear anywhere in these logs under
  any condition. Subject to that, each entry MUST include at minimum the
  fields below so a developer can reproduce and judge any analysis run
  from the service worker console alone:

  Per-chunk entry:
  - **`chunkIndex`** (number, 0-based) and **`chunkCount`** (total chunks
    in the plan).
  - **`chunkStartSec`** and **`chunkEndSec`** — the time range of the
    caption segments included in this chunk.
  - **`chunkChars`** — length of the chunk transcript in UTF-16 code units.
  - **`promptVersion`** — identifier (string / hash / semver) of the
    `PROMO_DETECTION_SYSTEM_PROMPT` in effect. The system prompt itself
    MUST NOT be inlined per chunk (it is constant per release and would
    bloat logs); a per-run dereference from `promptVersion` to the actual
    prompt text is acceptable via a single aggregate-level field or a
    code reference.
  - **`chunkText`** (string) — the **exact** user-message content sent to
    `adapter.analyzeTranscript` for this chunk. Logged in full by
    default; an implementation MAY truncate only when length exceeds
    `LOG_CHUNK_TEXT_MAX_CHARS` (proposed default **200 000**, effectively
    never hit under the chunk plan). When truncated, the log MUST include
    an explicit marker and the original length, so the truncation is
    never ambiguous.
  - **`rawAssistant`** (string) — the **exact** raw response string
    returned by the LLM for this chunk (pre-parse, pre-validation),
    including any prose wrapping around JSON. Logged in full by default;
    truncation MUST follow the same explicit-marker rule as `chunkText`
    (proposed bound `LOG_RAW_ASSISTANT_MAX_CHARS = 64 000`). A null
    `rawAssistant` is only permitted when the adapter did not receive a
    response (network failure, abort).
  - **`parsedBlocks`** — blocks after `parseLlmPromoResponse` and chunk
    in-range filtering (FR-006), before cross-chunk merge.
  - **`adapterLatencyMs`** — wall-clock milliseconds measured from the
    instant **just before** the pipeline calls `adapter.analyzeTranscript`
    to the instant it returns. This is the LLM round-trip cost for this
    chunk, isolated from planning, merging, and publishing overhead. On
    a re-split retry (FR-002 step 6), the retry is logged as a separate
    entry with its own `adapterLatencyMs`.
  - **`adapterOutcome`** — one of `success`, `too_large`, `parse_error`,
    `network_error`, `aborted`, `other_error`, mapped from the
    `AnalyzeTranscriptResult` variant.

  Aggregate entry (emitted once per run, after all chunks settle):
  - **`videoId`**, **`providerId`**, **`model`**, **`languageCode`**.
  - **`promptVersion`** and, exactly once here, the `PROMO_DETECTION_SYSTEM_PROMPT`
    text that version maps to (so the full prompt is recoverable from a
    single log grep).
  - **`captionSegmentCount`**, **`mergedTranscriptChars`**,
    **`mergedTranscriptText`** (full, with the same truncation-marker
    rule as `chunkText` but bounded by `LOG_MERGED_TEXT_MAX_CHARS`,
    proposed default **300 000**). This is the input the chunker saw,
    independent of how it was sliced.
  - **`plannedBudgetChars`** (the `adapter.maxTranscriptChars()` value at
    plan time), **`overlapSec`**, **`totalChunks`**.
  - **`totalAdapterCalls`** — may exceed `totalChunks` by the number of
    `tooLarge` re-split retries.
  - **`coverageFraction`** — chars successfully analyzed / total merged
    chars; `1.0` means no silent loss.
  - **`partialCoverage`** and, when true, **`uncoveredRanges`** listing
    any analyzed-but-failed chunks and any planned-but-dropped tail.
  - **`mergedBlocks`** — final canonical sorted/deduped block list.
  - **`totalAdapterLatencyMs`** — sum of per-chunk `adapterLatencyMs`
    values (pure LLM time).
  - **`totalWallClockMs`** — from caption payload arrival at
    `PromoAnalysis.onCaptionsReady` to final `PROMO_BLOCKS_DETECTED`
    publish. The difference `totalWallClockMs − totalAdapterLatencyMs`
    is the pipeline overhead.
  - **`globalTruncated`** — true only if the `MAX_CAPTION_TRANSCRIPT_CHARS`
    safety cap triggered (see FR-011).

  Log transport: the existing `LogPromoAnalysis.logAnalysisBundle` path
  (or its successor) MUST be used for aggregate entries. Per-chunk
  entries SHOULD use a sibling helper (e.g. `logChunkEntry`) so they
  share the "no secrets" invariant and can be filtered by a common
  console label.
- **FR-010**: Constants governing the plan MUST live in a single module
  (e.g. `src/background/messaging/chunk-plan-config.ts`) and SHOULD be
  typed and documented:
  - `MAX_CHUNKS_PER_VIDEO = 8`
  - `OVERLAP_FRACTION = 0.15`
  - `OVERLAP_FLOOR_SEC = 30`
  - `OVERLAP_CEILING_SEC = 90`
  - `BLOCK_MERGE_GAP_SEC = 3`
  - `CHUNK_BLOCK_TOLERANCE_SEC = 5`
  - `LOG_CHUNK_TEXT_MAX_CHARS = 200_000`
  - `LOG_RAW_ASSISTANT_MAX_CHARS = 64_000`
  - `LOG_MERGED_TEXT_MAX_CHARS = 300_000`
  The `LOG_*_MAX_CHARS` values are deliberately larger than expected
  real inputs so logging defaults to full-fidelity; they exist only as a
  safety net against pathological sizes that would stall DevTools.
  Values are tunable by future specs; changes SHOULD be justified by
  evaluation data.
- **FR-011**: The existing `MAX_CAPTION_TRANSCRIPT_CHARS = 120_000` global
  safety cap is **retained** as a last-resort bound against pathological
  caption payloads. It MUST NOT be hit in normal videos; when it triggers
  the aggregate log MUST record `globalTruncated: true`.
- **FR-012**: The `ChromePromptApiAdapter`'s internal phase-1/phase-2
  tail-truncation logic MUST be **removed** in favor of receiving
  pre-chunked input from the pipeline. The adapter MUST still perform a
  final `measureContextUsage` fit check on the received chunk before
  calling `session.prompt()`. Behavior on the fit check:
  - **Fits**: proceed with `prompt()` as today.
  - **Does not fit**: return a structured error distinguishable from
    other failures (e.g. `{ ok: false, error: '…', tooLarge: true }` or
    an equivalent dedicated shape on `AnalyzeTranscriptResult`). The
    adapter MUST NOT silently drop caption text to force a fit, and MUST
    NOT retry internally. Handling is the pipeline's responsibility
    under FR-002 step 6 (re-split once, then skip chunk and mark
    partial-coverage).

  Pipeline reaction:
  - On `tooLarge` from a chunk's first attempt: re-split that chunk's
    input on line boundaries into two halves with overlap preserved at
    the new boundary, and retry once.
  - On `tooLarge` from the retry: record the slice as a failed chunk,
    continue with remaining chunks, and set `partialCoverage: true`.
  - On non-`tooLarge` errors: existing per-chunk error handling (FR-007
    partial-coverage semantics) applies; no re-split is attempted.

  For `OpenRouterAdapter`, a remote-side context-length error (HTTP
  400 / provider error code indicating input too long) MUST be mapped
  to the same `tooLarge` shape so the pipeline handles it uniformly.
  All other HTTP failures remain generic adapter errors.
- **FR-013**: `OpenRouterAdapter` MUST continue to issue exactly one HTTP
  request per adapter call (one chunk = one chat/completions POST). When
  the full transcript fits in one chunk, end-to-end behavior is
  byte-identical to the pre-chunking path.

### Non-Functional Requirements

- **NFR-001**: Chunk planning (merging, slicing, budget query) MUST NOT
  perform LLM **inference** calls (no `session.prompt()`, no
  `chat/completions` round-trip). Tokenizer-level probes — specifically
  `session.measureContextUsage` on Chrome Prompt API — ARE permitted
  during planning for calibration (see FR-001) because they do not
  invoke model inference and carry only bookkeeping cost. Budget query
  (`adapter.maxTranscriptChars()`) is allowed to be `async` to
  accommodate such probes.
- **NFR-002**: For a fixed `CaptionSegment[]`, provider budget, and plan
  constants, the chunk plan MUST be **deterministic** (byte-identical
  chunk boundaries on re-run). This is required for reproducible logging
  and tests.
- **NFR-003**: Sequential multi-chunk analysis on Gemini Nano SHOULD
  complete within a reasonable multiple of single-chunk latency
  (informal target: ≤ N × single-chunk time + overhead). The spec
  does not set a hard deadline; observability makes regressions
  measurable.
- **NFR-004**: No chunk-level control flow may reach `src/shared/` or
  pure-helper modules that perform I/O; orchestration stays in
  `src/background/`. Pure helpers for line-walking and span-merging are
  allowed in `src/shared/` only if deterministic and side-effect-free.
- **NFR-005**: Unit tests MUST cover: chunk planner (one chunk vs many,
  overlap clamping, plan-cap behavior, partial-coverage flag), span
  merger (FR-005 and User Story 5 cases), and progressive-publication
  ordering (superseding messages key off `startSec`).

## Key Entities

- **ChunkPlan**:
  `{ chunks: Array<{ index: number; startSec: number; endSec: number;
  text: string; chars: number }>; overlapSec: number; partialCoverage:
  boolean; plannedChunkCount: number; coverageFraction: number }`.
- **ChunkAnalysisResult**:
  `{ index: number; ok: boolean; blocks: PromoBlock[]; rawAssistant?:
  string; error?: string; wallClockMs: number }`.
- **MergedDetectionState**:
  `{ videoId: string; blocks: PromoBlock[]; partialCoverage: boolean;
  chunkResults: ChunkAnalysisResult[] }` (transient, kept on the
  background detection store for the active tab).

No new runtime-message types; existing
`TOPSKIP_PROMO_BLOCKS_DETECTED` and `TOPSKIP_GET_DETECTION_STATUS`
payloads gain an optional `partialCoverage` field (non-breaking).

## Success Criteria

- **SC-001**: On the user-reported failing Russian video (74 459-char
  merged transcript, `chrome-prompt-api` provider), post-implementation
  the detection log shows at least 2 chunks, at least one non-degenerate
  promo block (not spanning the entire video), and no silent truncation.
- **SC-002**: On a corpus of at least 5 captioned videos known to contain
  promo blocks, chunked detection on `chrome-prompt-api` detects ≥ 1 real
  promo block within ±30 s in at least 3 videos, and **no** video returns
  the degenerate "0 → duration" block.
- **SC-003**: On a video whose merged transcript fits in one chunk for
  the active provider, the pipeline issues exactly one adapter call and
  the emitted block list is equal (as a sorted canonical set) to the
  pre-chunking implementation on the same input.
- **SC-004**: A synthesized transcript long enough to force the chunk
  plan over `MAX_CHUNKS_PER_VIDEO` yields `partialCoverage: true` in the
  status payload, analyzes the earliest chunks up to the cap, and surfaces
  the uncovered range in the aggregate log.
- **SC-005**: Unit tests for chunk planner and span merger pass and cover
  the cases listed in NFR-005.
- **SC-006**: `pnpm run lint`, `pnpm run build`, `pnpm run test`,
  `pnpm run test:coverage`, and `pnpm run test:e2e` all pass.
- **SC-007**: No log line, runtime message, or UI status payload contains
  an API key or `Authorization` header.
- **SC-008**: For every analysis run (one-chunk or multi-chunk), the
  service worker console contains, for each adapter call: the **exact
  transcript text sent** (`chunkText`), the **exact raw LLM response**
  (`rawAssistant`), and the **per-call LLM round-trip latency**
  (`adapterLatencyMs`). The aggregate log additionally contains
  `totalAdapterLatencyMs` (pure LLM time) and `totalWallClockMs`
  (end-to-end), so the pipeline overhead is derivable without
  instrumentation.

## Verification Methodology

| ID | How verified |
|----|--------------|
| **SC-001** | Manual replay of the failing caption payload against the implemented pipeline; inspect service worker console. |
| **SC-002** | Manual evaluation set documented during implementation; recorded as a dev note, not a CI gate. |
| **SC-003** | Unit test asserting adapter-call count = 1 for a short transcript, plus Playwright or controlled background test confirming block equality. |
| **SC-004** | Unit test covering the chunk planner at and above the cap, plus an integration test for the partial-coverage flag. |
| **SC-005** | Vitest suites under `tests/background/messaging/` and/or `tests/shared/captions/`. |
| **SC-006** | `make lint`, `make build`, `make test-unit`, `make test-coverage`, `make test-e2e`. |
| **SC-007** | Code review plus targeted tests on log helpers and message payload builders. |
| **SC-008** | Unit test on `buildChunkLogEntry` / `buildPromoAnalysisLogBundle` (or successors) asserting presence and non-empty values for `chunkText`, `rawAssistant`, `adapterLatencyMs` per chunk and `totalAdapterLatencyMs` / `totalWallClockMs` on aggregate; plus a manual console inspection for one real run. |

## Open Questions

1. **Per-model budget table for OpenRouter**: Should the adapter ship a
   hard-coded map from model slug to character budget, or treat OpenRouter
   as effectively unbounded (single chunk) until a concrete need arises?
   Proposed default: single chunk (return `MAX_SAFE_INTEGER`) in this
   milestone; add the map only if a user selects a small-context model
   and hits context errors in practice.
2. **Parallel chunk dispatch for OpenRouter**: When the full transcript
   doesn't fit a remote model's context (future case), is parallel
   analysis worth the extra complexity and cost, or should we stay
   sequential? Default: stay sequential; revisit on evidence.
3. **Progressive publication vs single final publish**: Do we ship
   progressive `PROMO_BLOCKS_DETECTED` updates in the MVP, or wait for
   all chunks and publish once? Progressive wins for user-visible early
   skips; single-publish is simpler and avoids the block-renumbering
   concern. Proposal: progressive, with FR-008's `startSec`-keyed
   already-fired tracking.
4. **Overlap tuning**: Is the proposed 15% / 30 s floor / 90 s ceiling a
   reasonable default? It is an unverified guess today; concrete data
   on typical and worst-case promo lengths would let us tighten the
   ceiling and the block-merge gap threshold.
5. **Chars-per-token calibration on Chrome Prompt API**: One-time probe
   per session with `measureContextUsage` on a known-length string is
   the proposed approach. Is this cheap enough to do every session, or
   should the ratio be cached per language code across sessions?
6. **"Partial coverage" UI surface**: Show a small badge / tooltip in the
   popup, or leave partial coverage as a log-only signal for developers
   in this milestone?
