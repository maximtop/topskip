# Feature Specification: Apply Detected Promo Timings as Seeks

**Created**: 2026-04-15
**Status**: Validated
**Model**: z-ai/glm-5.1
**Input**: "currently we are detecting timings when promo blocks are happenning, lets apply them correspondingly"

## Context

TopSkip detects sponsor/promo blocks by sending YouTube caption transcripts to an
OpenRouter-backed LLM, which returns `promoBlocks[]` with `startSec`, optional
`endSec`, and optional `confidence` per block. The background service worker
parses the response, stores detection state in `PromoDetectionStore`, and
broadcasts a `PROMO_BLOCKS_DETECTED` runtime message to the watch content script.

The content script's `YoutubeWatch` class already stores received
`promoBlocks` and evaluates them in `onTimeUpdate` via
`evaluatePromoBlocksSkip()`: when natural playback crosses a block's
`startSec`, it seeks to `computePromoBlockTargetTime()` (the block's `endSec`,
or `startSec + 30` if `endSec` is absent, clamped to video duration).

However, the pipeline has reliability gaps — the detection side is solid but
the "apply" side needs hardening so that every detected block is actually
skipped, interesting blocks are visible to the user in real time, and edge cases
(late arrival, video replay, mid-block navigation) are handled correctly. This
spec formalises the "apply" path and closes those gaps.

## Assumptions

- **One model, one pass**: Production continues to use a single non-streaming
  OpenRouter call per video (no multi-model ensemble or streaming).
- **Blocks are best-effort**: The LLM may return blocks with only `startSec`
  and no `endSec`; the system already falls back to `startSec + 30 s`. This
  spec does not change LLM behaviour — only how the *received* blocks are
  consumed.
- **Enabled toggle respected**: All apply logic is gated by the existing
  `enabled` preference (popup switch). When disabled, no seeks fire.
- **Video replay**: Re-playing the same video (seeking back to near-zero after
  blocks have fired) should allow the same blocks to fire again rather than
  remaining "spent" for the entire page lifetime.
- **No new storage**: Promo blocks are per-tab in-memory state; this spec does
  not persist them across page reloads or sessions.

## User Scenarios & Testing

### User Story 1 — Auto-skip crosses promo start during playback (P1)

A user watches a YouTube video with TopSkip enabled and OpenRouter configured.
The LLM detects a promo block starting at 1:45 (`startSec = 105`). As the
video plays past the 105-second mark, TopSkip seeks playback to the end of the
block (or `startSec + 30` if `endSec` is absent) and displays a brief toast.

**Why this priority**: This is the core value proposition — without an actual
skip after detection, the feature is incomplete.

**Independent Test**: Load a video with known promo timings (fixture or a real
video previously confirmed by the LLM). Verify that playback jumps past each
block's start and that the toast appears.

**Acceptance Scenarios**:

1. **Given** TopSkip is enabled and promo blocks `[ { startSec: 105, endSec: 135 } ]`
   are stored for the current video, **When** playback `currentTime` crosses 105
   from below (natural playback, `prevTime < 105 ≤ currentTime`), **Then** the
   video seeks to 135 and a "Skip applied" toast is shown.
2. **Given** a block with only `startSec: 200` (no `endSec`), **When** playback
   crosses 200, **Then** the video seeks to `min(200 + 30, duration)`.
3. **Given** `enabled` is `false`, **When** playback crosses a block start,
   **Then** no seek occurs and no toast is shown.
4. **Given** YouTube's own ad overlay is active (`isLikelyAdPlaying()` returns
   `true`), **When** playback crosses a block start, **Then** no promo skip
   fires (YouTube handles its own ad; TopSkip defers).

---

### User Story 2 — Late-arriving blocks apply mid-playback (P2)

The LLM response arrives after playback has already passed all or some block
start times. TopSkip must apply any blocks whose start has not yet been crossed
and must not skip backwards for blocks whose start has already passed.

**Why this priority**: LLM latency is common (1–5 s network round-trip); users
who start watching mid-video expect relevant blocks still to be skipped.

**Independent Test**: Simulate a delayed `PROMO_BLOCKS_DETECTED` message by
starting playback at 60 s in a video whose first promo block starts at 30 s.
When blocks arrive, only blocks starting after the current playhead should fire;
the already-passed block is skipped.

**Acceptance Scenarios**:

1. **Given** playback is at 60 s and blocks `[ { startSec: 30 }, { startSec: 120 } ]`
   arrive, **When** the content script processes the message, **Then** the block
   at 30 s is **not** retroactively skipped and the block at 120 s fires
   normally when crossed.
2. **Given** blocks arrive while playback is paused, **When** the user resumes,
   **Then** the first block whose `startSec` is ahead of the current time is
   skipped when crossed.
3. **Given** blocks arrive **before** playback begins (e.g. very fast LLM
   response), **When** the user presses play, **Then** blocks fire as normal as
   each start is crossed.

---

### User Story 3 — Promo blocks reset on video replay or navigation (P2)

The user watches a video, some promo blocks are skipped (fired indices are
recorded), then the user seeks back to the beginning and replays. TopSkip must
allow the same promo blocks to fire again rather than remaining permanently
"spent".

**Why this priority**: Without resetting fired state on replay, a user who
rewatches would never see promo skips again for that page session.

**Independent Test**: Play a video until one block fires, seek back to 0, and
play again. The same block should fire at the same time.

**Acceptance Scenarios**:

1. **Given** a block at `startSec: 45` has fired, **When** the user seeks back
   to `currentTime < 45`, **Then** the block's fired flag is cleared so it can
   fire again when the timeline next crosses 45.
2. **Given** a YouTube SPA navigation to a new video (`v` parameter changes),
   **When** the new video loads, **Then** all promo blocks and fired indices are
   reset for the new `videoId`.

---

### User Story 4 — User visibility of detected blocks before and during skip (P3)

A user opens the popup while watching a video. The popup already shows a
detection line ("Promo blocks detected · 0:45–2:00"). This spec ensures that
the displayed information is consistent with what the skip logic actually uses —
same blocks, same order, same boundaries.

**Why this priority**: Trust depends on the user seeing accurate pre-skip
information; however, the popup display already exists and this is a
consistency requirement, not a new UI feature.

**Independent Test**: Compare the `promoBlocks` stored in `YoutubeWatch` (used
by skip logic) with the `PromoDetectionStore` data shown in the popup for the
same tab. They must match.

**Acceptance Scenarios**:

1. **Given** blocks `[ { startSec: 45, endSec: 120 } ]` are received, **When**
   the popup polls `GET_DETECTION_STATUS`, **Then** the response contains
   `promoBlocks: [ { startSec: 45, endSec: 120 } ]` matching what the skip
   logic uses.

---

### User Story 5 — Popup and options page settings are always synchronized (P2)

A user toggles the TopSkip enable switch in the popup, then later opens the
options page to change their OpenRouter API key. The options page must show the
correct `enabled` state that matches what the popup toggle set. Conversely,
changing the enable checkbox on the options page must be reflected by the popup
switch the next time it opens.

**Why this priority**: Two independent `enabled` booleans currently live in
separate storage keys (`topskip:prefs` and `topskip:openrouter`). If they
diverge, the popup's toggle and the options page's checkbox disagree about
whether TopSkip is active, and the content script may consult the wrong value.

**Independent Test**: Open the popup, toggle the switch off. Open the options
page. Reload (or use the Reload button). The options page's "Enable LLM promo
detection" checkbox must be unchecked.

**Acceptance Scenarios**:

1. **Given** the popup toggle is set to `enabled = false`, **When** the options
   page loads (or hits Reload), **Then** the options page's enable checkbox is
   unchecked, reflecting the same `false` state.
2. **Given** the options page checkbox is set to `enabled = true` and saved,
   **When** the popup is opened next, **Then** the popup's enabled switch shows
   `true`.
3. **Given** both UI surfaces point to the same `enabled` source, **When**
   either surface saves a change, **Then** a single authoritative storage value
   is updated and both surfaces read identical values on their next load.
4. **Given** an existing install with divergent `enabled` flags in the two storage
   keys, **When** either page saves preferences, **Then** the system converges
   to a single consistent `enabled` value (migration-on-write).

---

### Edge Cases

- **No blocks detected** (`promoBlocks` is empty or `hasPromo: false`): No
  skip logic fires; the popup shows "No promo found". Playback is unaffected.
- **Block `endSec` beyond video duration**: `computePromoBlockTargetTime`
  already clamps to `duration`. Must verify this clamp still applies.
- **Very short video** (duration < first `startSec`): Block cannot fire; this
  is acceptable — the LLM should not return blocks past duration but the
  content script must degrade gracefully.
- **Multiple blocks, one near another**: Overlapping blocks are merged by
  `sortAndDedupePromoBlocks` before being sent. The skip logic must handle
  merged (non-overlapping, sorted) blocks correctly.
- **Seek during a block** (user manually scrubs past `endSec`): The `isSeeking`
  flag suppresses the skip evaluation so the user's manual seek is honoured.
- **Tab goes to background / video pauses**: When the tab is backgrounded, the
  browser may throttle `timeupdate` events. Upon resume, `prevTime` may jump
  past a block start; the `MAX_PLAYBACK_DELTA_SEC` guard already prevents
  false fires from large jumps.
- **Ad playing** (`isLikelyAdPlaying()`): YouTube's own ad overlay takes
  precedence; promo skip logic does not fire during ads.

## Requirements

### Functional Requirements

- **FR-001**: When promo blocks are received via the `PROMO_BLOCKS_DETECTED`
  runtime message for the active `videoId`, the content script MUST store them
  and clear the `firedPromoBlockIndices` set so all blocks are eligible to fire.
- **FR-002**: On each `timeupdate` event (when TopSkip is enabled, no ad is
  playing, and the video is not seeking), the content script MUST evaluate
  whether playback has crossed the `startSec` of any unfired promo block. If so,
  it MUST seek playback to the block's computed target time (`endSec` if
  available and greater than `startSec`, otherwise `startSec + 30`, clamped to
  `duration`).
- **FR-003**: After a successful promo skip seek, the content script MUST add
  the block's index to `firedPromoBlockIndices` and display a brief on-screen
  toast confirming the skip.
- **FR-004**: When playback seeks backward past a previously fired block's
  `startSec` (i.e. `video.currentTime` drops below `startSec`), the content
  script MUST remove that block's index from `firedPromoBlockIndices` so the
  block may fire again on replay.
- **FR-005**: When the `videoId` changes (SPA navigation or page reload), the
  content script MUST reset `promoBlocks` to the new set and clear
  `firedPromoBlockIndices`.
- **FR-006**: The content script MUST NOT fire a promo skip when
  `isLikelyAdPlaying()` returns `true` (YouTube's own ad overlay is active).
- **FR-007**: The content script MUST NOT fire a promo skip when the extension
  `enabled` preference is `false`.
- **FR-008**: The content script MUST NOT fire a promo skip when the
  `timeupdate` delta (`currentTime − prevTime`) exceeds
  `MAX_PLAYBACK_DELTA_SEC` (≈ 2.75 s), preventing false triggers from seeks or
  tab backgrounding.
- **FR-009**: Late-arriving blocks (received after playback has already passed
  some `startSec` values) MUST be evaluated against the *current* playback
  position: blocks whose `startSec` is still ahead fire normally; blocks whose
  `startSec` is already past are silently skipped (no retroactive seek).
- **FR-010**: The promo blocks shown in the popup via `GET_DETECTION_STATUS`
  MUST match exactly the `promoBlocks` array that the skip logic in the content
  script uses for the same `videoId`.
- **FR-011**: The `prevTime` tracked by `onTimeUpdate` MUST be set to the
  seek target after a promo skip (not the pre-seek `currentTime`) so that
  subsequent `timeupdate` events see a monotonic progression from the new
  position.
- **FR-012**: If a promo block has `endSec === startSec` or `endSec < startSec`,
  the system MUST treat it as if `endSec` were absent (fall back to
  `startSec + 30`, clamped to `duration`).
- **FR-013**: The `enabled` flag MUST be read/written from a single authoritative
  source. When either the popup (`SET_PREFS`) or the options page
  (`SET_OPENROUTER_CONFIG`) writes the enabled state, the change MUST take
  effect on the other surface on its next load.
- **FR-014**: When the background receives a `SET_PREFS` (popup), it MUST propagate
  the new `enabled` value to the OpenRouter stored config so that the options
  page reads the same value on its next load.
- **FR-015**: When the background receives a `SET_OPENROUTER_CONFIG` (options
  page), it MUST propagate the new `enabled` value to the general prefs storage
  so that the popup switch reads the same value on its next load.
- **FR-016**: On first run after a code upgrade from a version where the two
  storage keys could diverge, if exactly one of the two `enabled` flags is
  `true`, the background MUST resolve the conflict by using `true` (opt-in
  wins). If both are present and disagree, the user sees a single unified state
  after the first write from either surface.

### Key Entities

- **PromoBlock**: `{ startSec: number; endSec?: number; confidence?: PromoConfidence }`
  — the LLM-detected time range for a single paid integration.
- **firedPromoBlockIndices**: A `Set<number>` tracking which block indices have
  already triggered a skip in the current playback pass. Reset on block arrival
  or backward seek past a block start.
- **PromoBlocksSkipDecision**: `{ action: 'skip'; blockIndex: number; targetTime: number }`
  or `{ action: 'none' }` — the evaluation result from `evaluatePromoBlocksSkip()`.
- **PromoDetectionStatePayload**: The per-tab snapshot stored in the background
  (`PromoDetectionStore`) and polled by the popup, carrying `videoId`, `status`,
  `promoBlocks[]`, and optional `error`.

## Success Criteria

### Measurable Outcomes

- **SC-001**: On a test video with at least one known promo block, when
  TopSkip is enabled and OpenRouter returns `hasPromo: true` with valid
  blocks, playback MUST automatically seek past each block's `startSec` within
  one `timeupdate` cycle (typically ≤ 0.25 s after crossing the boundary).
- **SC-002**: After a promo skip, the on-screen "Skip applied" toast MUST be
  visible for at least 2 seconds before fading out.
- **SC-003**: When the user seeks backward before a previously fired block's
  `startSec` and replays past it, the same block MUST fire again (re-skip).
- **SC-004**: Late-arriving blocks (received after `currentTime` has passed
  their `startSec`) MUST NOT cause a backwards seek; only future blocks fire.
- **SC-005**: No promo skip fires while YouTube's own ad overlay is active
  (`isLikelyAdPlaying()` is `true`), while TopSkip is disabled, or while the
  user is manually seeking.

## Out of Scope

- Changing the LLM prompt or detection accuracy (covered by the existing
  `20260415-promo-detection-accuracy-observability` spec).
- Persisting promo blocks across page reloads or browser sessions.
- Multi-model comparison or model selection during playback.
- Adding a "preview before skip" delay or confirmation dialog.
- Changing the popup UI beyond what already exists.
