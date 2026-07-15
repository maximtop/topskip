# Feature Specification: Promo Detection Accuracy & Developer Observability

**Created**: 2026-04-15
**Status**: Validated
**Model**: Cursor Agent
**Implemented by**: GPT-5.2 (agent mode)
**SDD Version**: v2.0.2-2-gdf44b20
**Input**: User description: "Promo blocks are not determined correctly; hard to verify with current service-worker logs (chunked caption arrays); improve LLM instructions; run locally the same caption input across each OpenRouter preset model to see which model detects boundaries best."

## Context

TopSkip already forwards watch-page captions to the MV3 background, merges them
into a bounded transcript, and calls OpenRouter once per analysis pass with a
strict JSON reply (see **`.sdd/20260415-openrouter-multi-block-promo-detection/spec.md`** — validated baseline). This specification **extends** that behavior for **(a)** clearer **product-level** definition of what counts as a promo block, **(b)** **developer-usable** logging so humans can compare caption timing, merged text, and model output without expanding large object arrays in the browser console, and **(c)** a **local/dev-first** workflow to run the **same** saved transcript through **multiple models** before changing the production default so prompt quality and boundary accuracy can be evaluated deliberately.

**Reference log (repro / UX pain point):** [exported background console — `videoId=v3eXTAqGkzg`, `lang=ru`, chunked caption arrays](../../tmp/logs/console-1776244778870.log).

## Assumptions

- **Baseline unchanged unless explicitly overridden here**: One non-streaming
  OpenRouter `chat/completions` call per video analysis in production; the user
  still configures a **single** active model in options for normal viewing.
- **Caption conventions are ambiguous**: Characters such as `>>`, music notes,
  or speaker-change markers in YouTube captions **do not** always indicate a
  sponsor integration; the specification treats clearer **definitions** and
  **examples** in instructions as a requirement, not optional prose.
- **Developer logging is not end-user privacy**: Logs that echo transcript
  fragments or merged text appear only in **developer** surfaces (e.g. service
  worker console behind a dev flag or equivalent), not in shipped UI for
  typical users, unless the product later explicitly adds a “verbose” user
  toggle [NEEDS CLARIFICATION: whether a user-visible “debug mode” is desired].
- **Multi-model comparison is for engineering first**: before changing prompt
  wording or the default production model, maintainers evaluate candidate models
  locally or in a dev-only workflow against the same saved transcript input;
  this is not automatic model selection during normal playback.
- **Cost**: Running N models on the same transcript implies N API calls when
  that workflow is used; it MUST be opt-in (manual script, dev flag, or explicit
  user action), never silent N× traffic on every video load.

## User Scenarios & Testing

### User Story 1 — Readable verification of detection (Priority: P1)

A developer (or power user) has TopSkip and OpenRouter detection enabled, loads
a YouTube watch video with captions, and needs to decide whether returned
`startSec` / `endSec` values match the **same** text the model was shown **without**
manually expanding dozens of console array entries.

**Why this priority**: Without inspectable logs, “wrong block” reports cannot be
triaged as model error, prompt ambiguity, truncation, or user misread of cues.

**Independent Test**: Trigger one caption analysis; the developer can read one
plain-text log bundle (console block, exported text, or equivalent single
artifact) that ties **video id**, **truncation**, **merged transcript layout**,
and **parsed promo blocks** together in one pass.

**Acceptance Scenarios**:

1. **Given** captions were merged for the LLM, **When** analysis completes,
   **Then** developer-visible output states whether the merged transcript was
   truncated and to what approximate extent (e.g. character budget vs used).
2. **Given** a long caption list, **When** logs are emitted, **Then** the
  primary developer path produces **one human-readable plain-text output**
  using the same `[seconds] text` convention as the merged prompt, not only
  collapsed arrays of objects as the sole detailed view.
3. **Given** the LLM returns promo blocks, **When** logging runs, **Then** each
  reported block is printed with **start** and **end** seconds in plain text on
  the same timeline as caption lines, and the log clearly marks where the
  promo is understood to **start** so a human can scroll once and compare
  without expanding nested objects.

---

### User Story 2 — Clearer definition of “promo block” (Priority: P1)

The system instructions given to the model distinguish **paid sponsor
integrations** (host-read ads, “this video is sponsored by…”, discount codes,
visit-this-URL reads) from **non-promo** narration (story continuation, jokes,
`>>` speaker-style lines, generic B-roll) so that block boundaries align with
**integration start and end** more consistently across languages.

**Why this priority**: Misaligned blocks directly break trust and skip the wrong
moments; unclear definitions make every other fix noisy.

**Independent Test**: Using a fixed transcript fixture (Russian or other) where
human annotators agree on at least one integration window, the model’s JSON
**startSec** lies within an agreed tolerance (e.g. ±5 s of annotated start)
**more often** than before the instruction change, measured in the evaluation
workflow from User Story 3 or a documented manual checklist.

**Acceptance Scenarios**:

1. **Given** the instruction set, **When** a model reads a transcript that
   contains only organic storytelling, **Then** the expected reply is
   `hasPromo: false` (or equivalent) with **no** blocks, including cases with
   `>>` or similar markers that are **not** paid reads.
2. **Given** a transcript with an explicit host-read sponsor segment, **When**
   the model replies, **Then** at least one block’s `startSec` coincides with the
   beginning of that read (within the agreed tolerance) and `endSec` (when
   present) covers the read through the return to main content.
3. **Given** multiple sponsor segments in one video, **When** the model replies,
   **Then** each segment appears as a separate block ordered by time, without
   merging unrelated organic sections into one block.

---

### User Story 3 — Compare preset models on the same transcript first (Priority: P1)

A maintainer takes a **saved** caption transcript (from logs or a fixture file),
runs a **local or dev-only opt-in** procedure that sends the **same** merged user
message to **each** model in the product’s **preset list** (the curated slugs
exposed in options), and receives a **side-by-side** summary of returned blocks
per model for the same input **before** deciding which prompt or default model
change should ship.

**Why this priority**: This is the safest way to improve detection quality,
because prompt and model changes should be evaluated on the same known input
before shipping; it remains too expensive for every page load.

**Independent Test**: With a known API key in a dev environment, run the
procedure once on a fixture; output lists each preset slug, latency, and the
parsed `promoBlocks` (or errors) in a single artifact (table, JSON file, or
terminal report).

**Acceptance Scenarios**:

1. **Given** a fixture transcript and valid API credentials, **When** the
   maintainer runs the comparison procedure, **Then** each preset model is called
   at most **once** per fixture run and results are labeled by model slug.
2. **Given** one model returns invalid JSON or HTTP error, **When** the
   procedure finishes, **Then** other models still produce results and the
   failure is recorded per slug without aborting the entire batch.
3. **Given** production extension behavior, **When** a normal user watches a
   video, **Then** this multi-model procedure does **not** run automatically
   (no N× silent OpenRouter usage).

---

### Edge Cases

- **Very long transcripts**: Merged text hits the character cap; logs MUST still
  make truncation obvious, and instructions MUST tell the model how to behave
  when only an early portion is visible [NEEDS CLARIFICATION: exact policy —
  e.g. “only annotate promos in the visible portion” vs “infer none if
  uncertain”].
- **No captions / empty merge**: No OpenRouter call; logs MUST NOT imply analysis
  ran.
- **Non-Latin scripts**: Instructions and examples MUST NOT assume English-only
  cues; behavior is validated at least on one non-English fixture if available.
- **Conflicting cues** (e.g. `>>` before organic recap): Model SHOULD prefer
  explicit sponsor language over punctuation heuristics.

## Requirements

### Functional Requirements

- **FR-001**: The system MUST extend or replace the current detection
  instructions so that “promo block” is defined with **inclusions** (paid reads,
  repeated brand CTAs, typical sponsor outros) and **exclusions** (organic
  story, non-sponsored announcements, ambiguous `>>` lines without sponsor
  language), without requiring a second LLM round-trip in production.
- **FR-002**: After each successful analysis (or failure after OpenRouter was
  called), developer-targeted output MUST include: `videoId`, language if known,
  merged transcript **character length**, **truncated** yes/no, and **parsed**
  blocks as **plain-text-friendly** lines in **one** plain-text log bundle.
- **FR-003**: Chunked caption logging MAY remain for deep inspection, but MUST
  NOT be the only way to see segment text aligned with seconds at scale; a line
  format consistent with the merged prompt MUST be available in that log bundle,
  including enough surrounding timed lines to make each detected promo start
  obvious to a human reviewer.
- **FR-004**: The product MUST provide an **opt-in local or dev-only**
  maintainer workflow (documented script, test harness, or dev-only command)
  that runs the same merged prompt against **all** **preset** OpenRouter model
  slugs from the extension’s curated list and records structured results for
  comparison before changing the default production model or materially
  rewriting the prompt.
- **FR-005**: The maintainer workflow MUST use the user’s or CI’s own API key
  (never a bundled key) and MUST document approximate token/call cost.
- **FR-006**: Normal watch-page behavior MUST continue to use **one** model (the
  user’s selected slug) unless a future spec adds automatic model selection.
- **FR-007**: The plain-text log bundle MUST show the merged transcript as a
  timing-oriented sequence and annotate each detected promo block with explicit
  start and end markers so a reviewer can identify when the promo starts from a
  single read-through.

### Key Entities

- **Merged transcript view**: Bounded text shown to the LLM; deterministic line
  ordering; carries truncation metadata.
- **Analysis log bundle**: One plain-text artifact per analysis containing
  video id, language, truncation flags, merged timed transcript lines, explicit
  promo start/end markers, final parsed blocks, raw error string if any.
- **Model comparison row**: Preset slug, HTTP/parse outcome, list of blocks
  (start/end/confidence), latency optional.

## Success Criteria

### Measurable Outcomes

- **SC-001**: On a documented reference transcript, **≥1** agreed sponsor window
  is detected with **startSec** within **±5 s** of the annotated start after
  instruction changes (baseline measured before change on the same fixture).
- **SC-002**: A developer can answer “what text did the model see near second
  *T*?” using only console or exported logs in **under 2 minutes** without
  expanding chunked object arrays for the full video.
- **SC-003**: The multi-model comparison workflow produces a complete matrix for
  all preset slugs in one run, with per-model errors isolated, on a fixture of at
  least **100** caption lines.
- **SC-004**: From the plain-text log bundle alone, a developer can identify the
  intended promo start location for a detected block without opening nested
  console objects or cross-referencing a second artifact.

## Out of Scope

- Automatic per-video **model voting** or ensemble in production.
- Fetching OpenRouter’s live model catalog UI.
- Training or fine-tuning custom models.
- Changing YouTube caption fetch mechanics (unless a separate spec).

## Dependencies

- **Depends on**: OpenRouter multi-block promo detection (validated spec above).
- **Related code (informative, not binding)**: `promo-analysis.ts` (system
  prompt), `merge-transcript.ts` (merged line format), `log-transcript-dev.ts`
  (caption chunk logging), `openrouter-model-presets.ts` (preset slug list).
