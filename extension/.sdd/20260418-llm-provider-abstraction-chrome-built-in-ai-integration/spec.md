# Feature Specification: LLM Provider Abstraction & Chrome Prompt API Integration

**Created**: 2026-04-16
**Status**: Draft
**Model**: Claude Opus 4.6 (high)
**Input**: I know that chrome have some prompt api, lets try to use it, later I
will compare free models with paid models, we need some good ui/ux for choosing
model, tests that verify that model switching accordingly, some pattern, I think
adapter here should go as well, because I might want to add possibility to use
other llms as well, clear indication to user which model is used

## Assumptions

- **Chrome Prompt API (Gemini Nano) runs in the service worker**: The Chrome
  built-in `LanguageModel` API is available in extension service workers (the
  background script). The extension already calls `fetch` from background for
  OpenRouter; Gemini Nano calls will also originate from background.
- **Gemini Nano is the "free/local" provider**: It runs on-device at zero cost,
  uses Chrome's built-in model, and requires no API key. It requires Chrome 138+
  with hardware prerequisites (22 GB storage, >4 GB VRAM or 16 GB RAM). Not all
  users will have it available.
- **OpenRouter remains the "cloud/paid" provider**: The existing OpenRouter
  integration (API key + model slug) continues to work as-is, wrapped behind the
  new adapter interface.
- **Only one provider is active at a time**: The user selects a single active
  provider/model combination. Simultaneous multi-provider analysis is out of
  scope for this feature.
- **The adapter interface lives in `src/background/`**: The
  `LlmProviderAdapter` interface, concrete adapters, and the provider registry
  are all consumed exclusively by the background bundle (the promo-detection
  pipeline). The options page and popup never import the adapter — they receive
  provider IDs and display names through `runtime.sendMessage` payloads. Only
  the serialized provider metadata types (ID literals, display names) used in
  message payloads belong in `src/shared/messages.ts`.
- **The existing promo-detection prompt and response schema are reused**: Both
  providers receive the same system prompt and transcript, and must return the
  same `LlmPromoDetectionResult` shape. Gemini Nano's smaller context window
  may require transcript truncation, handled inside the adapter.
- **Model download UX is needed**: Gemini Nano requires a one-time ~2 GB model
  download. The UI should inform users of download progress before the model
  becomes usable.
- **Comparison tooling is out of scope for this spec**: The user mentioned
  comparing free vs paid models later; this spec covers the plumbing and UI to
  switch providers, not a comparison/evaluation framework.

## User Scenarios & Testing

### User Story 1 — Switch to Chrome Built-in AI (Free) (Priority: P1)

A user who does not want to pay for OpenRouter opens the options page and
selects "Chrome Built-in (Gemini Nano)" as their LLM provider. The extension
uses the on-device model for promo detection on subsequent YouTube videos, at no
cost and with no API key required.

**Why this priority**: This is the core new capability — making promo detection
available without a paid API key removes the biggest barrier to adoption.

**Independent Test**: Select "Chrome Built-in" on the options page, navigate to
a YouTube video, and verify that promo detection runs using the Prompt API (no
network request to OpenRouter).

**Acceptance Scenarios**:

1. **Given** the user's Chrome supports the Prompt API (`LanguageModel` is
   available and model status is not `unavailable`), **When** the user selects
   "Chrome Built-in (Gemini Nano)" on the options page and saves, **Then** the
   active provider is stored as `chrome-prompt-api` and the options page shows
   it as the selected provider.
2. **Given** the active provider is `chrome-prompt-api`, **When** captions
   arrive from a YouTube video, **Then** the background script sends the
   transcript to `LanguageModel.prompt()` instead of `callOpenRouterChat()`, and
   detected promo blocks are forwarded to the content script as before.
3. **Given** the user's Chrome does not support the Prompt API, **When** the
   user opens the options page, **Then** "Chrome Built-in" is shown as
   unavailable with an explanatory tooltip ("Requires Chrome 138+ with Gemini
   Nano").

---

### User Story 2 — Clear Active-Model Indicator (Priority: P1)

The user can see at a glance which LLM provider and model is currently active,
both on the options page and in the popup.

**Why this priority**: Without a visible indicator, users cannot tell whether
they are using the free or paid model, leading to confusion and unexpected API
charges.

**Independent Test**: Select each provider in options, then open the popup and
verify the displayed provider/model name matches.

**Acceptance Scenarios**:

1. **Given** the active provider is `openrouter` with model
   `google/gemini-3.1-pro-preview`, **When** the user opens the popup, **Then**
   a label such as "OpenRouter · gemini-3.1-pro-preview" is visible in the
   status area.
2. **Given** the active provider is `chrome-prompt-api`, **When** the user opens
   the popup, **Then** the label reads "Chrome Built-in · Gemini Nano" (or
   similar).
3. **Given** the active provider is `openrouter` but no API key is configured,
   **When** the user opens the popup, **Then** the indicator shows the provider
   name alongside a "Not configured" badge, and the status area links to the
   options page.

---

### User Story 3 — Switch Back to OpenRouter (Paid) (Priority: P1)

A user who was using Chrome Built-in switches to OpenRouter to get better
detection accuracy from a larger cloud model. The options page lets them pick
"OpenRouter" as the provider, configure the API key and model slug, and save.

**Why this priority**: The existing OpenRouter path must keep working seamlessly
behind the adapter; breaking it would regress the MVP.

**Independent Test**: Select "OpenRouter", enter an API key and model, save.
Navigate to a YouTube video and verify the OpenRouter endpoint is called.

**Acceptance Scenarios**:

1. **Given** the active provider is `chrome-prompt-api`, **When** the user
   switches to "OpenRouter" on the options page and provides a valid API key and
   model, **Then** subsequent promo detection calls go to
   `openrouter.ai/api/v1/chat/completions`.
2. **Given** the user selects "OpenRouter" but has not entered an API key,
   **When** they attempt to save, **Then** a validation error is shown and the
   provider is not changed.

---

### User Story 4 — Onboarding & Model Readiness for Chrome Built-in (Priority: P1)

When the user first selects Chrome Built-in, the UI guides them through the
model lifecycle: checking availability, downloading the model (with live
progress), and confirming readiness. At every stage the user knows exactly what
is happening and what to expect next.

**Why this priority**: The Gemini Nano model is ~2 GB and downloads on first
use. Without a clear onboarding flow the user sees a dead UI, assumes the
feature is broken, and abandons it. This is the first impression of the free
tier.

**Independent Test**: Mock each `LanguageModel.availability()` state
(`unavailable`, `downloadable`, `downloading`, `available`) and verify the
options page renders the correct stage UI.

**Acceptance Scenarios**:

1. **Given** `LanguageModel.availability()` returns `"available"` (model
   already downloaded), **When** the user selects Chrome Built-in, **Then** the
   options page immediately shows a green "Ready" badge and enables the Save
   button — no download step.
2. **Given** `LanguageModel.availability()` returns `"downloadable"` (model
   not yet downloaded), **When** the user selects Chrome Built-in, **Then** the
   options page shows an explanatory card: model name, approximate size, a
   "Download model" action button, and a note that no data leaves the device.
3. **Given** the user clicks "Download model", **When** the download begins,
   **Then** a progress bar with percentage (from the `downloadprogress` event
   on `LanguageModel.create({ monitor })`) replaces the action button, and the
   Save button remains disabled until the download completes.
4. **Given** the download is in progress, **When** the user navigates away from
   the options page and returns, **Then** the progress bar resumes (or shows
   the current state) rather than resetting.
5. **Given** the download completes successfully, **When** `availability()`
   transitions to `"available"`, **Then** the progress bar is replaced by a
   green "Ready — Gemini Nano" badge, and the Save button is enabled.
6. **Given** `LanguageModel.availability()` returns `"unavailable"` (hardware
   or Chrome version insufficient), **When** the user views the Chrome Built-in
   option, **Then** it is greyed out with a tooltip listing requirements
   (Chrome 138+, 22 GB storage, 4 GB+ VRAM or 16 GB RAM) and a link to
   Chrome's built-in AI documentation.
7. **Given** the download fails or is interrupted (browser closed, network
   error), **When** the user returns to the options page, **Then** the UI
   shows the last known state (e.g., "Download interrupted — Retry") with a
   retry action, not a blank or stuck progress bar.

---

### User Story 5 — Provider Adapter Enables Future LLM Additions (Priority: P2)

A developer adds a new LLM provider (e.g., a local Ollama instance) by
implementing the adapter interface and registering it, without modifying the
core promo-detection pipeline.

**Why this priority**: The adapter pattern is an architectural investment that
makes all future integrations cheaper. It does not deliver direct user value but
is explicitly requested.

**Independent Test**: Write a stub adapter that returns a hardcoded promo
response, register it, select it, and verify the pipeline uses it.

**Acceptance Scenarios**:

1. **Given** a new class implements the `LlmProviderAdapter` interface, **When**
   it is registered in the provider registry, **Then** it appears as a
   selectable option on the options page.
2. **Given** the new adapter is selected, **When** captions arrive, **Then** the
   promo-detection pipeline delegates to the new adapter's `analyze` method.

---

### User Story 6 — Automated Tests Verify Model Switching (Priority: P2)

Unit and integration tests confirm that switching the active provider routes
promo-detection calls to the correct adapter and that the UI reflects the
active selection.

**Why this priority**: Tests prevent regressions as more providers are added
and are explicitly requested.

**Independent Test**: Run `pnpm run test` and verify all new provider-switching
tests pass.

**Acceptance Scenarios**:

1. **Given** the test suite, **When** a test sets the active provider to
   `chrome-prompt-api`, **Then** the pipeline calls the Chrome adapter's
   `analyze` method and not the OpenRouter adapter.
2. **Given** the test suite, **When** a test sets the active provider to
   `openrouter`, **Then** the pipeline calls the OpenRouter adapter and not the
   Chrome adapter.
3. **Given** the preferences store test, **When** the active provider changes
   via messaging, **Then** the store's observable `activeProvider` updates and
   the popup re-renders.

---

### Edge Cases

- **Gemini Nano context window overflow**: Gemini Nano has a much smaller
  context window than cloud models. What happens when the transcript exceeds
  it? The adapter MUST truncate or summarize the transcript to fit, and log a
  warning.
- **Prompt API not available (older Chrome, unsupported hardware)**: The Chrome
  adapter MUST gracefully report unavailability. The options page MUST disable
  or grey out the option.
- **Service worker restart mid-analysis**: If the MV3 service worker is killed
  during a `LanguageModel.prompt()` call, the promise rejects. The adapter MUST
  surface an error status, not silently swallow it.
- **Concurrent provider switch during analysis**: If the user switches providers
  while an analysis is in-flight, the in-flight request SHOULD be aborted (via
  the existing `AbortController` pattern) and re-dispatched to the new provider
  on next caption arrival.
- **OpenRouter API key removed after switch**: If the user switches back to
  OpenRouter but the API key has been cleared, the system MUST show "Not
  configured" status rather than attempting a request.
- **Model download interrupted**: If the Gemini Nano download is interrupted
  (e.g., browser closed), the next `LanguageModel.create()` call will resume or
  restart the download. The UI MUST show a retry action, not a stuck spinner.
- **Options page opened mid-download**: If the model is already downloading
  (triggered earlier or by another extension), the options page MUST pick up
  the current progress rather than showing "downloadable".
- **Disk space drops below threshold after download**: Chrome may purge the
  model if free space falls below 10 GB. On next options page load,
  `availability()` will return `"downloadable"` again — the UI MUST
  re-enter the download flow, not show a stale "Ready" badge.
- **Invalid custom model slug**: A user enters a nonsensical slug like
  `test/test` as a custom OpenRouter model. The system MUST reject slugs
  that don't match `owner/model-name` format at minimum. When an API key is
  present, the system SHOULD verify the slug exists on OpenRouter; if it
  doesn't, show a clear error rather than letting the user save and discover
  failures only during promo detection.

## Requirements

### Functional Requirements

- **FR-001**: System MUST define a provider-agnostic `LlmProviderAdapter`
  interface with at minimum: `id` (unique string), `displayName`,
  `availability()` (returns availability status), and
  `analyzeTranscript(params)` (accepts transcript + signal, returns the
  standard promo-detection result type).
- **FR-002**: System MUST implement a `ChromePromptApiAdapter` that wraps
  Chrome's `LanguageModel.create()` / `session.prompt()` behind the
  `LlmProviderAdapter` interface, reusing the existing system prompt.
- **FR-003**: System MUST implement an `OpenRouterAdapter` that wraps the
  existing `callOpenRouterChat()` behind the `LlmProviderAdapter` interface
  with no behavior change to the OpenRouter path.
- **FR-004**: System MUST provide a provider registry (e.g., a static map or
  factory) that returns the adapter for a given provider `id`.
- **FR-005**: System MUST store the active provider `id` in
  `browser.storage.local` (background-only, Valibot-validated), alongside
  existing OpenRouter config.
- **FR-006**: The `PromoAnalysis` pipeline MUST resolve the active adapter from
  the registry and delegate to its `analyzeTranscript` method, instead of
  calling `callOpenRouterChat` directly.
- **FR-007**: The options page MUST display a provider selector (e.g., segmented
  control or radio group) listing all registered providers with their
  availability status.
- **FR-008**: The options page MUST conditionally show provider-specific
  configuration: API key + model selector + custom model management for
  OpenRouter; download progress / availability status for Chrome Built-in.
  When Chrome Built-in is selected, the model selector, custom model input,
  and API key fields MUST be hidden — Chrome Built-in offers exactly one
  model (Gemini Nano) with no user-configurable model choice.
- **FR-009**: The popup MUST display the active provider name and model (or
  "Gemini Nano" for Chrome Built-in) in a clearly visible label within the
  status area.
- **FR-010**: When Chrome Built-in is selected but the Prompt API is
  unavailable, the system MUST set detection status to `not_configured` (or a
  new `unavailable` status) and display an explanatory message.
- **FR-011**: The Chrome adapter MUST handle Gemini Nano's context window limit
  by truncating the transcript input to fit within `session.contextWindow`
  tokens before prompting.
- **FR-012**: New runtime message types MUST be added for getting/setting the
  active provider from options/popup (following existing
  `runtime.sendMessage` patterns).
- **FR-013**: Unit tests MUST verify that switching the active provider ID
  routes `analyzeTranscript` calls to the correct adapter implementation.
- **FR-014**: Unit tests MUST verify that the preferences store exposes the
  active provider and model name for popup display.
- **FR-015**: The `ChromePromptApiAdapter.analyzeTranscript` MUST use
  `responseConstraint` (JSON Schema) to constrain Gemini Nano's output to the
  expected promo-detection JSON shape, improving reliability.
- **FR-016**: The `ChromePromptApiAdapter` SHOULD use `AbortSignal` support
  (passed via `session.prompt(input, { signal })`) to enable cancellation
  consistent with the existing abort pattern.
- **FR-017**: The options page MUST render a multi-state onboarding widget for
  Chrome Built-in that maps to every `LanguageModel.availability()` value:
  - `"unavailable"` → greyed-out card with hardware/browser requirements
  - `"downloadable"` → explanatory card with model info + "Download model"
    action button
  - `"downloading"` → progress bar with percentage (from `monitor` /
    `downloadprogress` event on `LanguageModel.create()`)
  - `"available"` → green "Ready" badge; Save button enabled
- **FR-018**: The onboarding widget MUST re-check `availability()` each time
  the options page is opened (or the Chrome Built-in tab is focused) to catch
  state changes that happened outside the page (e.g., model purged, download
  completed by another tab).
- **FR-019**: The popup SHOULD show a brief status note when Chrome Built-in is
  selected but the model is not yet ready (e.g., "Model downloading…" or
  "Model unavailable") so the user understands why detection is not running.
- **FR-020**: The onboarding download action MUST be user-initiated (button
  click), not automatic on provider selection, to respect bandwidth and give
  the user control over a multi-GB download.
- **FR-021**: The options page MUST validate custom OpenRouter model slugs
  before saving: the slug MUST match the `owner/model-name` format (e.g.,
  `google/gemini-3.1-pro-preview`). Invalid slugs (e.g., `test/test` that
  are not real OpenRouter models) SHOULD be validated against the OpenRouter
  models endpoint (`GET https://openrouter.ai/api/v1/models`) when an API
  key is configured; if no key is available, at minimum enforce the
  `owner/model-name` format with a warning that the slug is unverified.
- **FR-022**: Unit tests MUST verify that invalid model slugs are rejected
  (format validation) and that the validation feedback is shown to the user.
- **FR-023**: The `ChromePromptApiAdapter` MUST emit structured diagnostic logs
  (using the existing `[TopSkip ...]` `console.*` prefix convention) at every
  significant lifecycle point, to enable fast bug identification:
  - **Availability check**: Log the result of `LanguageModel.availability()`
    each time it is called (value returned, e.g., `"available"`,
    `"downloadable"`, `"unavailable"`).
  - **Session creation**: Log before calling `LanguageModel.create()` and after
    the session is obtained, including `session.contextWindow` (max input
    tokens), `session.maxTokens`, and `session.temperature`.
  - **Transcript truncation**: If the transcript exceeds the context window and
    is truncated, log a `console.warn` with the original segment count, the
    truncated segment count, and the estimated token delta.
  - **Prompt dispatch**: Log when `session.prompt()` is called, including
    transcript length (chars/segments) and whether `responseConstraint` is
    attached.
  - **Prompt result**: Log the raw response length, parse success/failure, and
    the number of promo blocks detected (mirroring what
    `LogPromoAnalysis.logAnalysisBundle` does for OpenRouter).
  - **Errors**: Log `console.error` with the full error message and stack for
    any rejection from `LanguageModel.create()` or `session.prompt()`,
    including abort signals, quota errors, and unexpected exceptions.
  - **Download progress**: During model download (via `monitor`), log
    `console.info` at 0%, 25%, 50%, 75%, and 100% milestones (not every
    `downloadprogress` event, to avoid log spam).
- **FR-024**: The `ChromePromptApiAdapter` analysis results MUST be included in
  the existing `buildPromoAnalysisLogBundle` output (or an equivalent structured
  bundle), so that the same copy-paste-friendly developer artifact produced for
  OpenRouter analysis is also available for Chrome Built-in runs. The bundle
  MUST include: provider ID, model name (`"Gemini Nano"`), availability state
  at call time, context window size, transcript truncation details, raw
  response text, parsed promo blocks, and any error.

### Key Entities

- **LlmProviderAdapter**: The core abstraction. Represents a pluggable LLM
  backend. Key attributes: `id` (unique string identifier), `displayName`
  (user-facing label), `availability()`, `analyzeTranscript()`.
- **ProviderRegistry**: A lookup structure mapping provider `id` → adapter
  instance. Used by the promo-detection pipeline to resolve the active adapter.
- **ActiveProviderConfig**: The persisted user choice. Key attributes:
  `providerId` (references an adapter `id`). Stored in `browser.storage.local`.
  Relates to `OpenRouterConfig` (provider-specific settings remain in their own
  storage key).
- **PromoAnalysisRequest**: The input to `analyzeTranscript`. Key attributes:
  transcript segments, video duration, language, abort signal. Shared across all
  adapters.
- **PromoAnalysisResult**: The output from `analyzeTranscript`. Reuses the
  existing `LlmPromoDetectionResult` shape (`hasPromo`, `promoBlocks[]`).

## Success Criteria

### Measurable Outcomes

- **SC-001**: A user with no API key can run promo detection using Chrome
  Built-in and receive skip results on a YouTube video with a known sponsor
  segment.
- **SC-002**: Switching between Chrome Built-in and OpenRouter on the options
  page takes fewer than 3 clicks (select provider → configure if needed →
  save).
- **SC-003**: The popup correctly displays the active provider and model name
  within 1 second of opening, for both provider types.
- **SC-004**: All new unit tests pass (`pnpm run test`), covering: adapter
  routing, provider switching, availability checking, and preferences store
  updates.
- **SC-005**: Adding a hypothetical third provider requires implementing only
  the `LlmProviderAdapter` interface and registering it — no changes to the
  promo-detection pipeline, message types, or storage logic beyond the new
  adapter's own config.
- **SC-006**: When Chrome Built-in is unavailable (unsupported browser/hardware),
  the options page clearly communicates this and prevents selection, with zero
  console errors.
- **SC-007**: Existing E2E tests continue to pass with no modification (the
  OpenRouter path is unchanged behind the adapter).
- **SC-008**: The onboarding widget renders the correct UI for each of the four
  `LanguageModel.availability()` states, verified by unit tests with mocked
  availability values.
- **SC-009**: A user who has never downloaded the model sees the download card,
  clicks "Download model", observes progress, and reaches the "Ready" state
  without needing to leave the options page or consult documentation.
