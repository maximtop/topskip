# Feature Specification: OpenRouter Multi-Block Promo Detection

**Created**: 2026-04-14
**Status**: Validated
**Implemented by**: Cursor Agent (GPT-5.2)
**Model**: Codex
**Input**: User description: "now that we have proved that we can get captions from the youtube video, lets use them to determine where integration starts, for this lets use openrouter + field where user can select, or specify its own model for this, we send this captions to llm, and llm should return us timestamps, when promo integration has started"

## Context

Earlier iterations validated playback control and proved that the content
script can obtain timed YouTube caption segments and forward them to the MV3
background service worker.

This specification defines promo handling: use those caption segments to detect
**all** sponsor or promo integration **blocks** in a video with an OpenRouter-hosted
LLM, then **skip** each block—i.e. **do not play** those time ranges; jump playback
to just after each integration using the LLM-derived `startSec` / `endSec`. **There
is no fixed time-window skip** (e.g. 30s → 60s). Automatic **skips** happen **only**
on valid detected blocks. If analysis is unavailable, fails, returns no promo, is
not configured, or completes too late to apply a block before playback passes it,
TopSkip **does not** skip for that block; other blocks may still apply later if
detection arrives in time.

## Assumptions

- **OpenRouter is the only LLM gateway**: The background MUST call OpenRouter’s
  **HTTP API directly** (e.g. `fetch` to `POST https://openrouter.ai/api/v1/chat/completions`
  with `Authorization: Bearer <key>`, JSON body with `model` and `messages`, and
  non-streaming responses).
  **Do not** depend on `@openrouter/sdk` or other client wrappers in the
  extension bundle unless a future spec explicitly adds them. Wire format MUST
  match [OpenRouter’s API documentation](https://openrouter.ai/docs); the
  [create-agent SKILL](https://openrouter.ai/skills/create-agent/SKILL.md) is a
  **conceptual** reference (prompting, key hygiene), not the source of truth for
  the MV3 implementation. No non-OpenRouter LLM hosts.
- **The user provides the API key**: TopSkip does not ship, proxy, or generate
  an OpenRouter key. The key is stored in `browser.storage.local`, not
  `browser.storage.sync`, because it is a secret.
- **Background owns secrets and network calls**: The **options page**, toolbar
  popup, and content scripts do not read or write the OpenRouter key directly
  from storage. They use runtime messaging.
  The background service worker owns storage validation and the OpenRouter
  request.
- **Content scripts only when TopSkip is enabled**: When the main TopSkip
  preference is **off**, the extension MUST **not** inject TopSkip watch-page
  content scripts (no `content.js` / equivalent in page context). Implementation
  MAY use `browser.scripting.registerContentScripts` / unregister, dynamic
  rules, or another MV3-supported pattern; static `content_scripts` in the
  manifest that always inject MUST be avoided or neutralized so the “off” state
  truly runs no TopSkip code in the tab.
- **This changes the original no-third-party-network MVP constraint**: The
  original MVP intentionally avoided external APIs. This phase explicitly adds
  an opt-in third-party request to OpenRouter and must be reflected in docs,
  permissions, privacy copy, and deployment review.
- **Caption input and a single merged prompt**: Captions arrive as the existing
  `CaptionSegment[]` (`startSec`, `durationSec`, `text`). Before calling OpenRouter,
  the background MUST **merge all segments into one bounded transcript** (e.g.
  chronological lines like `[startSec] text` or an equivalent deterministic
  format). That transcript is sent in **one** user message. There MUST be **at
  most one** `chat/completions` request per video analysis—no per-segment,
  batched, or follow-up LLM calls for the same pass—so usage stays **efficient
  and cheap**.
- **Multiple promo blocks per video**: A video MAY contain **several** sponsor or
  promo segments (e.g. mid-roll, end-roll). The LLM MUST return **all** of them
  in **one** JSON payload (ordered list with `startSec` / `endSec` per block).
  The content script MUST skip **each** block independently when playback
  naturally crosses that block’s start (each block fires at most once per
  `videoId`). Chapters and community voting remain out of scope.
- **Detection is opt-in**: No captions are sent to OpenRouter unless TopSkip is
  enabled, the LLM detection feature is enabled, and a valid API key and model
  are configured.
- **No streaming**: The background makes one non-streaming chat-completions
  request per current video analysis.
- **Static model presets**: The **extension options page** provides recommended
  model slugs (current top models on OpenRouter as of April 2026):
  - **Google**: `google/gemini-3.1-pro-preview`, `google/gemini-3-flash-preview`
  - **OpenAI**: `openai/gpt-5.4`, `openai/gpt-5.4-mini`
  - **Anthropic**: `anthropic/claude-opus-4.6`, `anthropic/claude-sonnet-4.6`
  - **Chinese**: `z-ai/glm-5.1`, `minimax/minimax-m2.7`, `xiaomi/mimo-v2-pro`

  plus a custom model input. It does not fetch OpenRouter's model catalog in
  this phase.
- **Custom models are persisted**: When the user adds a custom model slug, it
  is saved to storage and appears in the model dropdown alongside presets in
  future sessions. This is a distinct "Add" action (not the general "Save"
  button) so intention is clear. The user can also remove previously added
  custom models.
- **No fixed-window skip**: The product does **not** ship a legacy hardcoded
  30s → 60s (or similar) automatic skip. Skipping is driven solely by LLM
  detection when valid promo blocks exist; otherwise playback is not altered by
  TopSkip for that reason.

## OpenRouter agent implementation reference

Implementers **SHOULD** read **[OpenRouter Skills — create-agent](https://openrouter.ai/skills/create-agent/SKILL.md)** for general OpenRouter-oriented practices (never commit keys, structure system vs user content). **Implementation in this extension MUST use the OpenRouter HTTP API directly**—not the SKILL’s Node-centric **`@openrouter/sdk`** examples.

**How this applies to TopSkip**:

- **Primary integration**: Exactly **one** **`POST`** to **`https://openrouter.ai/api/v1/chat/completions`** per video analysis (no chaining or multi-request flows), **`stream: false`**, `messages` with a **system** instruction (strict JSON output) and a **single** **user** message whose body is the **merged** bounded transcript (see assumptions). Parse `choices[0].message.content` (or equivalent per [OpenRouter docs](https://openrouter.ai/docs)) for the assistant reply. Send OpenRouter-specific headers as required by current documentation (e.g. `Authorization`, optional `HTTP-Referer` / `X-Title` if the project adopts them for rankings).
- **Do not copy from the SKILL**: Ink TUI, CLI loop, Discord examples, or **`@openrouter/sdk`** `callModel` / tool loops—the MV3 **service worker** uses **`fetch`** only.
- **Scope for promo detection**: A **single-turn** chat completion (one user message with transcript → one assistant message with JSON) is sufficient; tool calling and multi-step agents are **out of scope** unless added later.

## Product Decision

**Terminology**: **Skip** (user-visible) means the viewer does **not** watch a
detected promo integration: when playback would enter that window, TopSkip jumps
to the **end** of that integration (`endSec`, or a default end time if only
`startSec` is known). **Implementation** uses the player’s **seek** API (e.g.
setting `video.currentTime`) to move the playhead—that technical operation is a
“seek”; the **product** behavior is **skipping** the promo **timings** returned by
the LLM.

When valid promo **blocks** are detected in time, TopSkip **skips** **each**
integration at the right moment: crossing a block’s `startSec` triggers a jump to
that block’s `endSec` (or default offset when `endSec` is missing for that block).

When there is **no** valid block list to apply—LLM detection off, not configured,
captions unavailable, OpenRouter errors, invalid response, or `hasPromo: false`
with no blocks—TopSkip **does not** auto-skip for that reason. For a **given**
block, if detection finishes **after** playback has already passed that block’s
start without a skip, the implementation MUST **not** jump backward to re-skip
it; remaining blocks may still apply. A late result must not cause surprising
double-skips.

When the main TopSkip toggle is **off**, the extension performs no analysis,
no automatic playback skips, and **no TopSkip content scripts are injected** into web
pages (see assumptions—typically programmatic injection or unregistering static
content scripts so disabled users get zero page-level footprint).

## User Scenarios & Testing

### User Story 1 - Configure OpenRouter Detection (Priority: P1)

A user opens the **extension options page** (e.g. from the browser’s extension
details → Extension options, or a “Settings” / “Open options” entry point from
the toolbar popup), enables LLM promo detection, enters an OpenRouter API key,
and selects either a preset model or a custom OpenRouter model slug.

**Why this priority**: Detection cannot run without explicit configuration.

**Independent Test**: Open the options page, enable detection, enter a key,
choose a model, save, close and reopen the options page. The detection toggle
and model persist, and the key is present only as a masked/password value.

**Acceptance Scenarios**:

1. **Given** no OpenRouter configuration exists, **When** the user views the
   options page, **Then** they see that LLM detection is disabled or not
   configured, and with TopSkip on there is still **no** automatic seek until
   valid promo **blocks** are detected via configured OpenRouter analysis.
2. **Given** the options page is open, **When** the user enters a non-empty API
   key, enables detection, and saves, **Then** the background persists the key in
   `browser.storage.local` after Valibot validation.
3. **Given** the user selects a preset model, **When** settings are saved,
   **Then** that model slug is persisted with the OpenRouter config.
4. **Given** the user enters a custom model slug and clicks "Add", **When**
   the add action completes, **Then** that slug is persisted to storage and
   appears in the model dropdown for the current and all future sessions.
5. **Given** the user previously added a custom model, **When** they reopen
   the options page, **Then** the custom model appears in the dropdown
   alongside built-in presets.
6. **Given** the user wants to remove a previously added custom model,
   **When** they use the remove action for that model, **Then** it is deleted
   from storage and no longer appears in the dropdown.
7. **Given** the user clears the API key or disables LLM detection on the
   options page, **When** a new video loads, **Then** no captions are sent to
   OpenRouter and **no** automatic skip runs from TopSkip for that video.
8. **Given** the toolbar popup is open, **When** the user needs to change
   OpenRouter settings, **Then** they can reach the options page in one clear
   action (e.g. link or button that calls `browser.runtime.openOptionsPage()`).

---

### User Story 2 - Analyze Current Video Captions (Priority: P1)

When the content script successfully fetches captions for the current YouTube
watch video, the background **merges** segments into one transcript, sends **one**
bounded prompt to OpenRouter, and receives a structured answer listing **zero
or more** promo blocks for the current video.

**Why this priority**: This is the detection pipeline.

**Independent Test**: With a valid key and model configured, open a watch video
with captions and a known sponsor read. Inspect the service worker console and
popup state; analysis transitions from pending to detected or no promo, and
**each run logs a developer-visible analysis summary** (see logging requirements)
so you can judge whether the model was correct.

**Acceptance Scenarios**:

1. **Given** TopSkip is enabled, LLM detection is enabled, a key and model are
   configured, and `CAPTIONS_FROM_CONTENT` succeeds, **When** the background
   receives caption segments, **Then** it merges them into one transcript and
   sends **exactly one** OpenRouter request for the current `videoId` (no
   additional LLM calls for that analysis pass).
2. **Given** captions are unavailable, empty, or failed, **When** the background
   receives the caption message, **Then** it does not call OpenRouter and marks
   detection unavailable for that video.
3. **Given** OpenRouter returns strict valid JSON with `hasPromo: true` and a
   non-empty `promoBlocks` array, **When** the background validates the result,
   **Then** it records **all** validated blocks for the current video (sorted,
   deduped per FR-012).
4. **Given** OpenRouter returns strict valid JSON with `hasPromo: false`,
   **When** the background validates the result, **Then** it records no promo
   blocks and **does not** auto-seek for that video (while LLM detection remains
   enabled).
5. **Given** OpenRouter returns an error, invalid JSON, `hasPromo: true` with
   empty `promoBlocks`, or timestamps outside the video bounds, **When** the
   background processes the response, **Then** it records an error or empty state
   and **does not** auto-seek for that video (while LLM detection remains
   enabled).
6. **Given** any analysis attempt completes (success or failure), **When** a
   developer opens the service worker console, **Then** they can read a
   structured log of that run including the raw model reply text and validated
   fields, without the API key (see Edge Cases — Analysis visibility).

---

### User Story 3 - Skip Detected Promo Blocks (Priority: P1)

When playback reaches a detected promo **block** start time, TopSkip **skips**
that integration by jumping the playhead to that block’s end (or the default end
when `endSec` is absent for **that** block)—implemented via a player **seek**
(`currentTime`). Videos with **multiple** blocks are skipped **once per block**
when each start is crossed in order during normal playback.

**Why this priority**: Detection must affect user-visible **skip** behavior for
every integration in the video.

**Independent Test**: Use a fixture where detection returns two blocks (e.g.
45–120s and 300–360s). Verify playback **skips** to ~120s when crossing 45s, and
**skips** to ~360s when later crossing 300s, without conflating the two.

**Acceptance Scenarios**:

1. **Given** a valid non-empty block list exists for the current `videoId`,
   **When** playback crosses a block’s `startSec` during normal playback, **Then**
   the content script **skips** that integration by seeking to that block’s
   `endSec` (or default).
2. **Given** a block has no `endSec`, **When** playback crosses that block’s
   `startSec`, **Then** the content script skips by seeking to `startSec + 30` for
   **that** block, clamped to video duration.
3. **Given** two or more blocks, **When** playback crosses each start in
   sequence, **Then** each crossing triggers **at most one** skip for that block
   (no double-fire for the same block index).
4. **Given** LLM detection is enabled but no valid block list is in effect,
   **When** playback progresses, **Then** TopSkip does not inject any fixed-window
   skip. If a valid list arrives later, apply remaining blocks per product rules
   without backward jumps.
5. **Given** the user manually seeks across a block boundary, **When** the
   crossing heuristic determines a manual seek, **Then** automatic skip does not
   trap the user in a loop (same rules as single-block, extended per block).
6. **Given** the user disables TopSkip entirely, **When** captions arrive or
   playback progresses, **Then** no OpenRouter call and no automatic skip occur.

---

### User Story 4 - Show Detection Status (Priority: P2)

The popup shows the current tab's detection state: not configured, unavailable,
analyzing, detected, no promo, or error.

**Why this priority**: Users need feedback when paying for an external LLM
request, but the core feature can be validated through background logs first.

**Independent Test**: Open a configured video with captions, then open the
popup while analysis is pending and after it completes. The status updates with
human-readable timestamps or a clear fallback/error message.

**Acceptance Scenarios**:

1. **Given** analysis is in flight for the current tab's video, **When** the
   popup opens, **Then** it shows an analyzing state.
2. **Given** detection returned multiple blocks (e.g. 0:45–2:00 and 4:32–5:35),
   **When** the popup opens, **Then** it shows **all** ranges in `m:ss` or
   `h:mm:ss` format (or a compact list), not only the first.
3. **Given** no promo is detected (LLM mode on), **When** the popup opens,
   **Then** it says no promo was detected and indicates that **no** automatic
   seek from TopSkip will run for this video.
4. **Given** OpenRouter rejects the key or model during **analysis** (watching a
   video), **When** the popup is open, **Then** it shows a sanitized actionable
   error without revealing the API key.
5. **Given** the user saves an invalid key or model on the **options page**,
   **When** validation or the save path fails, **Then** the options page shows a
   clear error without echoing the secret.

## Out of Scope

- A **fixed time-window auto-skip** without LLM detection (e.g. 30s → 60s); that
  behavior is intentionally **not** part of this product.
- **`@openrouter/sdk`** or other OpenRouter client wrappers in the extension
  bundle for this milestone (direct HTTP only).
- Fetching the live OpenRouter model catalog.
- Community segment databases or shared detection results.
- Automatic retries or background batch analysis.
- Server-side proxying, hosted keys, or account management.
- Direct calls to non-OpenRouter LLM providers.
- User analytics about watched videos, sponsors, or skipped time.

## Edge Cases

- **No captions**: Do not call OpenRouter. Status becomes unavailable; **no**
  automatic seek for that video.
- **Very long transcripts**: After merging segments, the background must bound
  the **single** user message size before sending (deterministic truncation by
  time/segment count or character budget). It must not silently send unbounded
  text or split work across **multiple** OpenRouter calls for the same pass.
- **Sponsor occurs outside retained transcript portion**: The system may return
  no promo or a lower-confidence result. The popup should not imply certainty.
- **Invalid API key (401/403)**: Mark config/error status; show a user-facing
  error on the **options page** when saving credentials, and a **sanitized**
  status in the toolbar popup if the failure surfaces during watch; do not retry
  automatically.
- **Rate limiting (429)**: Mark rate-limited status and do not loop.
- **Model not found or unsupported**: Surface the OpenRouter error in sanitized
  form.
- **Service worker suspension**: In-memory results may disappear. If this
  causes poor UX, store non-secret per-video detection status in
  `browser.storage.session`; do not store caption text or API keys there.
- **User turns TopSkip off during playback**: Content scripts MUST be removed or
  disabled per FR-021; no further seeks or caption fetches from TopSkip for that
  tab until re-enabled.
- **SPA navigation**: A new `videoId` cancels or invalidates pending analysis
  for the previous video. Late responses must be ignored.
- **Overlapping or duplicate blocks from the LLM**: Resolved by FR-012’s sort
  and dedupe rule; log when blocks were merged or dropped.
- **Multiple YouTube tabs**: Detection status and block application are keyed by
  tab and `videoId` so one tab's result does not apply to another video.
- **Video duration unavailable**: Validate timestamps against known data when
  possible. If duration is missing, require finite non-negative timestamps and
  clamp at seek time using the player duration once available.
- **LLM returns prose instead of JSON**: Treat the result as an error. Do not
  rely on regex timestamp extraction for automatic skipping.
- **Sensitive logging**: Never log the API key or `Authorization` header.
  **Analysis visibility**: The service worker **MUST** log each analysis run in
  enough detail for the developer to judge correctness, including: `videoId`,
  model slug, prompt version, caption segment count, request outcome (success /
  HTTP error / parse error), **validated parsed result** (`hasPromo`, full
  `promoBlocks` after sort/dedupe, per-block confidence), and the **raw assistant
  message text** from OpenRouter (the model
  reply body), since that is not a secret and is required to verify behavior.
  Logging the **caption text sent in the prompt** is **SHOULD** for the same
  reason (bounded/truncated if necessary to avoid huge console spam); if
  truncated, the log MUST state that truncation occurred.

## Requirements

### Functional Requirements

- **FR-000**: OpenRouter integration MUST use the **HTTP API directly** as
  described in **OpenRouter agent implementation reference** and OpenRouter’s
  official docs. The [create-agent SKILL](https://openrouter.ai/skills/create-agent/SKILL.md)
  MAY inform prompting and key hygiene but MUST NOT be taken as requiring
  `@openrouter/sdk` or Node-only tooling.
- **FR-001**: The **extension options page** MUST include controls for
  enabling/disabling LLM promo detection separately from the main TopSkip
  enabled preference (the latter MAY remain on the toolbar popup per existing
  UX).
- **FR-002**: The **options page** MUST allow the user to enter, replace, and
  clear an OpenRouter API key.
- **FR-003**: The **options page** MUST provide at least three recommended
  OpenRouter model slugs—current defaults:
  `google/gemini-3.1-pro-preview`, `google/gemini-3-flash-preview`,
  `openai/gpt-5.4`, `openai/gpt-5.4-mini`,

  `anthropic/claude-opus-4.6`, `anthropic/claude-sonnet-4.6`,
  `z-ai/glm-5.1`, `minimax/minimax-m2.7`, `xiaomi/mimo-v2-pro`—plus
  a custom model input.
- **FR-003c**: Custom model slugs entered by the user MUST be persisted in
  `browser.storage.local` (same storage pattern as OpenRouter config) and
  MUST appear in the model dropdown alongside built-in presets on subsequent
  sessions. Adding a custom model MUST use a dedicated "Add" action (button
  or equivalent) that is visually distinct from the general settings
  "Save" button, so the user's intent to permanently add a new model is
  clear. The user MUST be able to remove previously added custom models.
- **FR-003b**: The extension MUST declare an **options page** in the manifest
  (`options_ui` or `options_page`) so OpenRouter settings are available outside
  the popup, and SHOULD offer a visible path from the popup to open it (e.g.
  “Settings” opening `browser.runtime.openOptionsPage()`).
- **FR-004**: OpenRouter config MUST be stored in `browser.storage.local`, not
  `browser.storage.sync`.
- **FR-005**: Only the background service worker MUST read/write OpenRouter
  config storage. The **options page**, toolbar popup, and content scripts MUST
  use runtime messaging (no direct `storage` access for OpenRouter keys from UI
  bundles except via background-mediated messages).
- **FR-006**: OpenRouter config MUST be validated with Valibot at read/write
  boundaries. The API key and model slug MUST be non-empty strings when
  detection is enabled.
- **FR-007**: The API key MUST be displayed as a password or masked value on the
  **options page** by default and MUST never be included in content-script,
  popup, or detection-status payloads (only sanitized metadata).
- **FR-008**: The background MUST NOT send captions to OpenRouter unless the
  main TopSkip preference is enabled, LLM detection is enabled, and valid
  OpenRouter config exists.
- **FR-009**: The background MUST call only OpenRouter’s hosted HTTP API (no
  other LLM hosts). Requests MUST be **`POST https://openrouter.ai/api/v1/chat/completions`**
  (or a documented successor path on the same host) with **`fetch`**, correct
  `Authorization` and JSON body, per [OpenRouter API docs](https://openrouter.ai/docs).
- **FR-010**: The OpenRouter user message MUST contain the **full merged**
  transcript: all `CaptionSegment` rows combined in **chronological order** with
  timing preserved in text (deterministic formatting). The system message MUST
  instruct the model to return only strict JSON listing **every** promo or
  sponsor integration block found in chronological order (there may be zero,
  one, or many). The implementation MUST NOT
  issue multiple OpenRouter requests for one analysis of the same `videoId` in
  the same pass (no segment-by-segment or retry loops that multiply cost).
- **FR-011**: The expected JSON result MUST use this shape when promos exist:

  ```json
  {
    "hasPromo": true,
    "promoBlocks": [
      { "startSec": 45, "endSec": 120, "confidence": "medium" },
      { "startSec": 272, "endSec": 335, "confidence": "high" }
    ]
  }
  ```

  `promoBlocks` MUST be a non-empty array when `hasPromo` is `true`. Each block
  MUST include `startSec`; `endSec` is optional per block (same default rule as
  elsewhere: seek target `startSec + 30` clamped when missing). Per-block
  `confidence` SHOULD be included when the model supports it.

  For no detected promo:

  ```json
  {
    "hasPromo": false,
    "confidence": "low"
  }
  ```

  `hasPromo: true` with an empty or missing `promoBlocks` MUST be treated as a
  validation error (same as invalid JSON).

- **FR-012**: The background MUST parse and validate the LLM response before it
  affects playback. For each block, `startSec` and `endSec` MUST be finite
  numbers ≥ 0. If `endSec` is present, it MUST be greater than `startSec`. The
  background MUST **sort** validated blocks by `startSec` ascending and MAY drop
  overlapping or duplicate blocks using a deterministic rule (e.g. keep the
  wider interval or the first-listed) so the content script receives a
  non-ambiguous list.
- **FR-013**: If known video duration is available, each block’s timestamps MUST be
  within the duration or that block MUST be discarded. Skip targets (`endSec` or
  default) MUST be clamped to duration at application time.
- **FR-014**: The full validated **list** of promo blocks MUST be communicated to
  the matching content script via runtime messaging and keyed by `videoId`.
- **FR-015**: Content **skip** logic MUST behave as follows: (a) For **each** promo
  block in the validated list, when playback **naturally** crosses that block’s
  `startSec` (same crossing heuristic as today’s skip logic), **skip** that
  integration by seeking the player to `endSec` or the default offset if `endSec`
  is absent. (b) Each block MUST be applied **at most once** per `videoId`
  (track which block indices have fired). (c) When no valid block list
  applies—including LLM detection disabled, not configured, unavailable captions,
  error, `hasPromo: false`, or invalid payload—perform **no** automatic skip from
  TopSkip for that video. (d) There is **no** fixed time-window skip (e.g. 30s →
  60s) in this product.
- **FR-016**: The background MUST ignore stale detection responses for videos
  that are no longer current in the originating tab.
- **FR-017**: The popup SHOULD show detection status for the active tab's
  current video.
- **FR-018**: OpenRouter **configuration** errors (invalid key, model rejected,
  save failures) MUST surface as sanitized, human-readable text on the **options
  page** where the user edits settings. **Detection** status while watching MAY
  appear in the **toolbar popup** (User Story 4) with the same sanitization rules.
  API keys and `Authorization` headers MUST NOT appear in logs, UI, or runtime
  messages to popup/content/options except masked key display on the options page.
  The **service worker console** MUST still emit the analysis visibility described in
  the Edge Cases section (parsed result, raw assistant text; caption text in
  prompt per the SHOULD there).
- **FR-019**: Documentation and deployment notes MUST identify the new
  third-party request to OpenRouter and the local-only API key storage behavior.
- **FR-020**: After each OpenRouter analysis attempt (success or failure), the
  background MUST write a structured **developer log line** (or grouped
  `console` output) that includes enough information for a human to judge whether
  the model was correct, consistent with the Edge Cases "Analysis visibility"
  rules.
- **FR-021**: When the main TopSkip toggle is **off**, TopSkip MUST **not**
  inject content scripts into matching pages. When the user turns TopSkip
  **on**, the implementation MUST register or allow injection so watch-page
  behavior matches this specification.

### Non-Functional Requirements

- **NFR-001**: Detection must not block the content script from initializing or
  the popup / options page from rendering.
- **NFR-002**: Merged transcript and prompt construction must be deterministic
  for the same `CaptionSegment[]` input, selected model, and prompt version.
- **NFR-006**: For each completed caption payload for a `videoId`, the background
  MUST perform **at most one** OpenRouter `chat/completions` request for promo
  detection (cost and latency control).
- **NFR-003**: Runtime message payloads should stay small enough for extension
  messaging. Do not broadcast full transcripts to the popup or options page.
- **NFR-004**: The implementation should keep OpenRouter-specific code in the
  background bundle, not in shared pure helpers except for types/constants.
- **NFR-005**: Tests must cover storage validation, response validation (including
  multi-block JSON), stale result handling, and per-block skip behavior.

## Key Entities

- **OpenRouterConfig**: `{ enabled: boolean; apiKey: string; model: string;
  customModels: string[] }`. Stored in `browser.storage.local` by background
  only. The API key is secret. `customModels` holds user-added model slugs
  that persist across sessions and appear alongside built-in presets in the
  model dropdown.
- **PromoDetectionStatus**:
  `not_configured | unavailable | analyzing | detected | no_promo | error`.
- **PromoDetectionResult**:
  `{ videoId: string; status: PromoDetectionStatus; promoBlocks?: Array<{ startSec: number; endSec?: number; confidence?: "low" | "medium" | "high" }>; error?: string }`
  (sorted, validated; omit or empty `promoBlocks` when `no_promo` / error).
- **DetectionRequest**: Current `videoId`, optional duration, selected model,
  prompt version, and a **single merged bounded transcript** derived from
  `CaptionSegment[]` (not multiple parallel requests per segment).
- **DetectionStateByTab**: Background-owned transient map keyed by tab ID and
  `videoId`. May be mirrored to `browser.storage.session` if needed.

## Runtime Messages

The implementation may refine names, but the protocol should include these
capabilities:

- `TOPSKIP_GET_OPENROUTER_CONFIG`: options page (or other extension UI) ->
  background. Returns sanitized config metadata, never the raw API key.
- `TOPSKIP_SET_OPENROUTER_CONFIG`: options page (or other extension UI) ->
  background. Stores enabled flag, API key replacement/clear intent, and
  selected model.
- `TOPSKIP_ADD_CUSTOM_MODEL`: options page -> background. Adds a custom
  model slug to the persisted `customModels` list.
- `TOPSKIP_REMOVE_CUSTOM_MODEL`: options page -> background. Removes a
  custom model slug from the persisted `customModels` list.
- `TOPSKIP_GET_DETECTION_STATUS`: popup -> background. Returns current active
  tab/video detection status.
- `TOPSKIP_PROMO_DETECTION_UPDATED`: background -> popup/content. Announces
  status changes and detected promo blocks for a specific `videoId`.
- `TOPSKIP_PROMO_BLOCKS_DETECTED` (or equivalent): background -> content.
  Carries the validated **list** of promo blocks the content script applies
  independently per block.

Existing `TOPSKIP_CAPTIONS_FROM_CONTENT` remains the source of caption segments
for analysis.

## Success Criteria

- **SC-001**: With a valid OpenRouter key and model, a captioned video can move
  from caption receipt to a parsed detection status without console errors.
- **SC-002**: For at least 5 manually selected videos with known sponsor reads,
  at least one detected block’s `startSec` is within 30 seconds of a manually
  observed integration start in at least 3 videos (recommended fast model).
  Videos with **multiple** integrations SHOULD surface multiple `promoBlocks`
  where captions support it.
- **SC-003**: For at least 5 manually selected videos with no sponsor read, the
  system returns `hasPromo: false` (or no blocks) or does not auto-seek from LLM
  blocks in at least 4 videos.
- **SC-004**: When valid blocks arrive before playback crosses each block’s start,
  playback seeks to each block’s end (or the specified default when `endSec` is
  absent)—not an arbitrary fixed clock time unrelated to detection.
- **SC-005**: When no key is configured, LLM detection is disabled, or analysis
  fails or yields no applicable blocks, **no** OpenRouter-backed seek runs and
  **no** fixed-window seek runs—TopSkip does not alter playback for that reason.
- **SC-005b**: A developer inspecting the service worker console can read the
  full analysis outcome (including raw model reply text) for each run without
  exposing the API key.
- **SC-006**: API keys are never logged, never sent to content scripts, never
  sent in popup/options status responses (except masked display on the options
  page), and never transmitted to any host other than OpenRouter.
- **SC-007**: `pnpm run lint`, `pnpm run build`, `pnpm run test`, and relevant
  coverage/e2e checks pass after implementation.

## Verification Methodology

| ID | How verified |
|----|--------------|
| **SC-001** | Manual service worker smoke with a configured key plus unit tests for response validation. |
| **SC-002-SC-003** | Manual evaluation set documented during implementation; do not make these CI gates. |
| **SC-004** | Unit tests for multi-block skip logic and Playwright or controlled path when practical. |
| **SC-005** | Unit tests: no valid blocks yields no seek; multiple blocks each fire at most once. |
| **SC-005b** | Manual check of service worker logs after a test OpenRouter call. |
| **SC-006** | Code review and targeted tests ensuring sanitized messages/log helpers do not expose secrets. |
| **SC-007** | Automated local/CI commands. |

## Open Questions

1. ~~Which model presets should ship initially?~~ **Resolved**: Ship 9 presets
   grouped by vendor — Google (`gemini-3.1-pro-preview`,
   `gemini-3-flash-preview`), OpenAI (`gpt-5.4`, `gpt-5.4-mini`), Anthropic
   (`claude-opus-4.6`, `claude-sonnet-4.6`), Chinese (`glm-5.1`,
   `minimax-m2.7`, `mimo-v2-pro`).
2. Should detected results persist in `browser.storage.session` from the first
   implementation, or only after in-memory behavior proves insufficient?
3. Should the toolbar popup or options page expose a manual “reanalyze current
   video” button in this phase, or leave it for a later iteration?
4. What privacy copy should be added to README/DEPLOYMENT/options page (and
   popup if shown) before release builds that include OpenRouter support?
