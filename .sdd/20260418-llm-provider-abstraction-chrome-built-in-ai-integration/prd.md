# PRD: LLM Provider Abstraction & Chrome Built-in AI Integration

**Created**: 2026-04-17
**Status**: Validated
**Model**: GLM-5.1 via OpenRouter (standard)
**Input**: I know that chrome have some prompt api, lets try to use it, later I will compare free models with paid models, we need some good ui/ux for choosing model, tests that verify that model switching accordingly, some pattern, I think adapter here should go as well, because I might want to add possibility to use other llms as well, clear indication to user which model is used

## Problem Statement

TopSkip currently has a single, hard-coded LLM backend (OpenRouter). Users must provide a paid API key to use the extension at all — there is no free option. Switching to a different LLM provider would require touching OpenRouter-specific code across the client, storage, messaging, options UI, and content scripts. There is no visible indicator telling users which provider or model is currently active, and no validated way to confirm that a provider switch actually routes analysis calls to the correct backend.

## Solution

Introduce a provider-agnostic adapter layer so that the promo-detection pipeline delegates to whichever provider the user selects. Ship a Chrome Built-in AI (Gemini Nano) adapter as a zero-cost alternative to OpenRouter. The options page gets a tabbed provider selector, and the popup displays the active provider and model name at a glance. Model switching is verified by automated tests.

## Assumptions

- **Chrome Prompt API runs in the service worker**: The `LanguageModel` API is available in extension background scripts. Chrome 138+ with hardware prerequisites (22 GB storage, >4 GB VRAM or 16 GB RAM) is required. Not all users will have it.
- **Gemini Nano is the free/local provider**: It runs on-device, requires no API key, and involves a one-time ~2 GB model download managed by Chrome.
- **OpenRouter remains the cloud/paid provider**: The existing integration is wrapped behind the adapter interface with no behavior change.
- **Only one provider is active at a time**: The user selects a single active provider. Simultaneous multi-provider analysis is out of scope.
- **The adapter interface lives in background/**: Only the background bundle imports adapters and the registry. The options page and popup receive provider metadata (IDs, display names, availability) through `runtime.sendMessage` payloads. Serialized provider-ID literals and display names that cross bundle boundaries go in `src/shared/messages.ts`.
- **Same prompt and result schema for both providers**: Both adapters receive the same system prompt and transcript, and must return the same `LlmPromoDetection` shape. Gemini Nano's smaller context window may require transcript truncation, handled inside its adapter.
- **Provider switch takes effect on next video only**: If the user switches providers while a video is being analyzed, the in-flight request is aborted via the existing `AbortController` pattern. The new provider is used starting with the next caption arrival (next video).
- **Dual `enabled` flags are unified**: The current separate `topskip:prefs.enabled` and `topskip:openrouter.enabled` flags are consolidated. A single `providerId` field in prefs identifies the active provider. `OpenRouterStorage` stores only its config (key, model, custom models), not an `enabled` flag.
- **English-only for new UI strings**: i18n is not in scope for this feature. New strings will use English directly or existing i18n infrastructure where convenient, but no new `_locales/` keys are required.
- **Model slug validation queries OpenRouter**: When an API key is configured, custom model slugs are validated against the OpenRouter models API at save time. Without a key, only `owner/model-name` format is enforced.

## User Stories

### User Story 1 — Use Chrome Built-in AI for Free Promo Detection (Priority: P1)

As a **user without an OpenRouter API key**, I want to select Chrome Built-in AI as my LLM provider, so that I can run promo detection on YouTube videos at no cost.

**Why this priority**: Removing the paid-API-key barrier is the most impactful new capability. It makes TopSkip usable for anyone with a compatible Chrome browser.

**Acceptance Scenarios**:

1. **Given** the user's Chrome supports the Prompt API (`LanguageModel` is available and model status is not `unavailable`), **When** the user selects "Chrome Built-in" on the options page and saves, **Then** the active provider is stored as `chrome-prompt-api` and the options page shows it as the selected provider.
2. **Given** the active provider is `chrome-prompt-api` and the model is available, **When** captions arrive from a YouTube video, **Then** the background script sends the transcript to `LanguageModel.prompt()` instead of the OpenRouter endpoint, and detected promo blocks are forwarded to the content script.
3. **Given** the user's Chrome does not support the Prompt API, **When** the user opens the options page, **Then** the Chrome Built-in option is shown as unavailable with an explanatory note about requirements.

---

### User Story 2 — See Which Provider and Model Is Active (Priority: P1)

As a **user**, I want to see the active LLM provider and model name in the popup and options page, so that I always know whether I am using the free or paid model.

**Why this priority**: Without a visible indicator, users cannot tell whether promo detection costs money or runs locally. This directly affects trust and willingness to use the extension.

**Acceptance Scenarios**:

1. **Given** the active provider is `openrouter` with model `google/gemini-3.1-pro-preview`, **When** the user opens the popup, **Then** a label such as "OpenRouter · gemini-3.1-pro-preview" is visible in the status area.
2. **Given** the active provider is `chrome-prompt-api`, **When** the user opens the popup, **Then** the label reads "Chrome Built-in · Gemini Nano" (or similar).
3. **Given** the active provider is `openrouter` but no API key is configured, **When** the user opens the popup, **Then** the indicator shows the provider name alongside a "Not configured" badge, and the status area links to the options page.

---

### User Story 3 — Switch Back to OpenRouter (Priority: P1)

As a **user**, I want to switch from Chrome Built-in to OpenRouter to use a larger cloud model, so that I can get better detection accuracy for difficult videos.

**Why this priority**: The existing OpenRouter path must keep working behind the adapter. Breaking it would regress the MVP.

**Acceptance Scenarios**:

1. **Given** the active provider is `chrome-prompt-api`, **When** the user switches to "OpenRouter" on the options page and provides a valid API key and model, **Then** subsequent promo detection calls go to `openrouter.ai/api/v1/chat/completions` (starting with the next video).
2. **Given** the user selects "OpenRouter" but has not entered an API key, **When** they attempt to save, **Then** a validation error is shown and the provider is not changed.

---

### User Story 4 — Onboard Through Model Download (Priority: P1)

As a **user selecting Chrome Built-in for the first time**, I want to be guided through checking availability, downloading the model, and confirming readiness, so that I always know what is happening and what to expect next.

**Why this priority**: The Gemini Nano model is ~2 GB. Without a clear onboarding flow, users see a dead UI, assume the feature is broken, and abandon it. This is the first impression of the free tier.

**Acceptance Scenarios**:

1. **Given** `LanguageModel.availability()` returns `"available"` (model already downloaded), **When** the user selects Chrome Built-in, **Then** the options page immediately shows a green "Ready" badge and enables the Save button — no download step.
2. **Given** `LanguageModel.availability()` returns `"downloadable"` (model not yet downloaded), **When** the user selects Chrome Built-in, **Then** the options page shows a card with model name, approximate size, a "Download model" action button, and a note that no data leaves the device.
3. **Given** the user clicks "Download model", **When** the download begins, **Then** a progress bar with percentage replaces the action button, and the Save button remains disabled until the download completes.
4. **Given** the download is in progress, **When** the user navigates away from the options page and returns, **Then** the progress bar shows the current state rather than resetting.
5. **Given** the download completes, **When** `availability()` transitions to `"available"`, **Then** the progress bar is replaced by a green "Ready" badge and the Save button is enabled.
6. **Given** `LanguageModel.availability()` returns `"unavailable"` (hardware/Chrome version insufficient), **When** the user views the Chrome Built-in option, **Then** it is greyed out with a note listing requirements (Chrome 138+, 22 GB storage, 4 GB+ VRAM or 16 GB RAM).
7. **Given** the download fails or is interrupted, **When** the user returns to the options page, **Then** the UI shows a "Download interrupted — Retry" action, not a stuck spinner.

---

### User Story 5 — Developer Adds a New LLM Provider (Priority: P2)

As a **developer**, I want to add a new LLM provider by implementing an adapter interface and registering it, so that I can integrate additional backends without modifying the promo-detection pipeline.

**Why this priority**: The adapter pattern is an architectural investment that makes future integrations cheaper. It does not deliver direct user value but is explicitly requested.

**Acceptance Scenarios**:

1. **Given** a new class implements the `LlmProviderAdapter` interface, **When** it is registered in the provider registry, **Then** it appears as a selectable option on the options page.
2. **Given** the new adapter is selected, **When** captions arrive, **Then** the promo-detection pipeline delegates to the new adapter's `analyzeTranscript` method.

---

### User Story 6 — Automated Tests Verify Model Switching (Priority: P2)

As a **developer**, I want unit and integration tests that confirm switching the active provider routes promo-detection calls to the correct adapter and the UI reflects the selection, so that I can confidently add more providers without regressions.

**Why this priority**: Tests prevent regressions as more providers are added and are explicitly requested.

**Acceptance Scenarios**:

1. **Given** the test suite, **When** a test sets the active provider to `chrome-prompt-api`, **Then** the pipeline calls the Chrome adapter's `analyzeTranscript` method and not the OpenRouter adapter.
2. **Given** the test suite, **When** a test sets the active provider to `openrouter`, **Then** the pipeline calls the OpenRouter adapter and not the Chrome adapter.
3. **Given** the preferences store test, **When** the active provider changes via messaging, **Then** the store's observable `activeProvider` updates and the popup re-renders with the correct provider label.

---

### User Story 7 — Validate Custom OpenRouter Model Slugs (Priority: P2)

As a **user**, I want the options page to validate my custom model slug before saving, so that I don't discover typos only when promo detection fails on a live video.

**Why this priority**: Invalid slugs cause silent failures during playback. Validation at save time is a significant UX improvement, but the feature is not on the critical path for Chrome Built-in.

**Acceptance Scenarios**:

1. **Given** the user enters a slug like `test/test` that does not match `owner/model-name` format, **When** they attempt to add it, **Then** a format error is shown and the slug is not added.
2. **Given** the user enters a well-formed slug and an API key is configured, **When** they attempt to add it, **Then** the system queries the OpenRouter models API and, if the slug is not found, shows a "Model not found on OpenRouter" error.
3. **Given** the user enters a well-formed slug but no API key is configured, **When** they attempt to add it, **Then** the slug is added with an "Unverified" warning badge indicating it could not be validated.

---

### User Story 8 — Abort In-Flight Analysis on Provider Switch (Priority: P2)

As a **user**, I want provider switches to take effect cleanly, so that I never get results from a provider I no longer want to use.

**Why this priority**: The existing `AbortController` pattern already aborts analysis when new captions arrive. Extending it to provider switches is consistent and safe, but the edge case is rare.

**Acceptance Scenarios**:

1. **Given** the active provider is `openrouter` and an analysis is in flight, **When** the user switches to `chrome-prompt-api`, **Then** the in-flight OpenRouter request is aborted and the next video's analysis uses the Chrome adapter.
2. **Given** the switch happens mid-analysis, **When** the abort completes, **Then** the detection store is updated to a neutral state (not `error`) and no stale promo blocks from the old provider are forwarded to the content script.

---

### User Story 9 — Popup Shows Model Readiness Status (Priority: P2)

As a **user**, I want the popup to tell me when the Chrome Built-in model is not ready, so that I understand why detection is not running.

**Why this priority**: A popup that silently shows "paused" when the model is downloading is confusing. A brief note costs little and aids comprehension.

**Acceptance Scenarios**:

1. **Given** the active provider is `chrome-prompt-api` and the model is downloading, **When** the user opens the popup, **Then** the status area shows "Model downloading…" alongside the provider label.
2. **Given** the active provider is `chrome-prompt-api` and the model is unavailable, **When** the user opens the popup, **Then** the status area shows "Model unavailable" with a link to the options page.

---

## Key Entities

### LlmProviderAdapter

- **Attributes**: `id` (unique string, e.g. `"openrouter"`, `"chrome-prompt-api"`), `displayName` (user-facing label, e.g. "OpenRouter", "Chrome Built-in"), `availability()` → `ProviderAvailability` enum (`available` | `downloadable` | `downloading` | `unavailable`), `analyzeTranscript(params)` → `Promise<AnalyzeTranscriptResult>`
- **Relationships**: Registered in `ProviderRegistry`. Referenced by `providerId` in prefs.
- **Validation**: Each implementation must return the standard `LlmPromoDetection` shape. The `id` must be unique across all registered adapters.

### ProviderRegistry

- **Attributes**: Map of `providerId` → `LlmProviderAdapter` instance. Static/frozen at startup.
- **Relationships**: Used by `PromoAnalysis` to resolve the active adapter.
- **Validation**: Supports `get(id)` and `getAll()`. Returns `undefined` for unknown IDs.

### ActiveProviderConfig

- **Attributes**: `providerId` (string, references an adapter `id`). Stored in `browser.storage.local` under prefs.
- **Relationships**: Replaces the OpenRouter-specific `enabled` flag. The selected provider's own config (API key, model, download state) is stored separately.
- **Validation**: `providerId` must reference a registered adapter. If the referenced adapter is unavailable, detection enters `not_configured` or `unavailable` status.
- **States**: `openrouter` ↔ `chrome-prompt-api` (and future IDs). Default: `openrouter`.

### OpenRouterConfig

- **Attributes**: `apiKey` (string), `model` (string slug), `customModels` (string[]). Stored in `browser.storage.local` under `topskip:openrouter`.
- **Relationships**: Provider-specific config for the `openrouter` adapter only. No longer stores an `enabled` flag — that is derived from `ActiveProviderConfig.providerId === "openrouter"`.
- **Validation**: When `openrouter` is the active provider, `apiKey` and `model` must be non-empty. Custom model slugs must match `owner/model-name` format.

### ChromePromptApiConfig

- **Attributes**: None persisted — Chrome manages model state. Availability is queried live via `LanguageModel.availability()`.
- **Relationships**: Provider-specific runtime state for the `chrome-prompt-api` adapter.
- **States**: Availability transitions: `unavailable` → `downloadable` → `downloading` → `available`. Chrome may revert from `available` to `downloadable` (disk pressure).

### PromoAnalysisRequest

- **Attributes**: `transcript` (string), `videoId` (string), `languageCode` (string), `durationSec` (number), `signal` (AbortSignal).
- **Relationships**: Shared input shape for all adapters. Constructed by `PromoAnalysis` from captions.

### PromoAnalysisResult

- **Attributes**: Wraps the existing `LlmPromoDetection` result (`hasPromo`, `promoBlocks[]`) plus provider metadata for logging.
- **Relationships**: Unified output shape from all adapters.

## Module Design

### LlmProviderAdapter (interface)

- **Responsibility**: Provider-agnostic contract for LLM-backed transcript analysis.
- **Interface**: `id`, `displayName`, `availability()`, `analyzeTranscript(request)` → `Promise<AnalyzeTranscriptResult>`. Each adapter owns its own error handling, retry logic, and transcript preparation (e.g., truncation for Gemini Nano).
- **Tested**: Yes — the interface itself via mock implementations; each concrete adapter separately.

### OpenRouterAdapter (concrete)

- **Responsibility**: Wraps the existing `callOpenRouterChat()` and response parsing behind the adapter interface. No behavior change.
- **Interface**: Implements `LlmProviderAdapter`. `availability()` returns `available` if API key and model are configured, else `unavailable`. `analyzeTranscript()` delegates to `callOpenRouterChat()` + `parseLlmPromoResponse()`.
- **Tested**: Yes — unit tests verify that `analyzeTranscript` calls `callOpenRouterChat` with correct arguments and returns parsed results.

### ChromePromptApiAdapter (concrete)

- **Responsibility**: Wraps Chrome's `LanguageModel.create()` / `session.prompt()` behind the adapter interface. Handles model download monitoring, context window truncation, and structured output constraints.
- **Interface**: Implements `LlmProviderAdapter`. `availability()` wraps `LanguageModel.availability()`. `analyzeTranscript()` creates a session, truncates transcript to fit `session.contextWindow`, sends prompt with `responseConstraint`, and parses the response.
- **Tested**: Yes — unit tests with mocked `LanguageModel` verify availability states, truncation logic, prompt construction, and result parsing.

### ProviderRegistry (static lookup)

- **Responsibility**: Maps provider IDs to adapter instances. Readonly after initialization.
- **Interface**: `get(id: string)` → `LlmProviderAdapter | undefined`. `getAll()` → `LlmProviderAdapter[]`.
- **Tested**: Yes — verifying lookup and enumeration.

### ActiveProviderStorage (refactored from PrefsSyncStorage)

- **Responsibility**: Persists and validates the active `providerId` in `browser.storage.local` alongside the existing `enabled` flag.
- **Interface**: `getProviderId()` → `string`, `setProviderId(id)` → validated write, `ready()` → initialization guard. Retains existing prefs `enabled` API.
- **Tested**: Yes — verifying valid/invalid provider IDs, default fallback, cross-session persistence.

### OnboardingWidget (UI component)

- **Responsibility**: Multi-state UI for Chrome Built-in model lifecycle (unavailable → downloadable → downloading → available). Renders availability-specific cards, download button, progress bar, retry action, and "Ready" badge.
- **Interface**: React component receiving `availability` state and a `onDownloadTrigger` callback. Polls or subscribes to availability changes.
- **Tested**: Yes — rendering tests per state with mocked availability.

### ProviderSelector (UI component)

- **Responsibility**: Tabbed or segmented control on the options page listing all registered providers with their availability. Below it, renders the selected provider's config panel.
- **Interface**: React component receiving `providers[]` and `activeProviderId`. Emits `onProviderChange(id)`.
- **Tested**: Yes — verifying selection state, disabled state for unavailable providers, and panel switching.

## Implementation Decisions

- **Unified prefs with providerId**: The dual `enabled` flags are consolidated. A single `providerId` field in prefs identifies the active provider. `OpenRouterStorage` stores only config (key, model, custom models), not `enabled`. The `enabled` flag in prefs remains the master on/off; the `providerId` tells the pipeline *which* adapter to use when enabled.
- **Provider switch on next video only**: When the user switches providers, the in-flight analysis (if any) is aborted via the existing `AbortController` pattern. The new provider is used starting with the next caption arrival. This avoids the complexity of mid-analysis re-dispatch.
- **Tabbed options layout**: A segmented control at the top selects the active provider. Below it, the selected provider's config panel appears (API key + model selector for OpenRouter, or download/readiness card for Chrome Built-in). The "enabled" toggle remains at the top level.
- **Model slug validation against OpenRouter API**: When an API key is present, custom slugs are validated by querying `GET https://openrouter.ai/api/v1/models`. The response is cached for the session. Without a key, only `owner/model-name` format is enforced with an "Unverified" warning.
- **Chrome adapter uses `responseConstraint`**: The `session.prompt()` call includes a JSON Schema constraint to improve output reliability from Gemini Nano. This is a Prompt API feature not available for OpenRouter.
- **Transcript truncation in Chrome adapter**: Gemini Nano's context window (~30 K tokens) is much smaller than cloud models. The adapter estimates token count (chars ÷ 4), truncates from the start of the transcript (keeping the most recent content), and logs a warning with original vs. truncated segment counts.
- **New runtime message types**: `GET_ACTIVE_PROVIDER`, `SET_ACTIVE_PROVIDER`, `GET_CHROME_PROMPT_API_STATUS` are added to `src/shared/messages.ts` for options/popup ↔ background communication. Provider display names are returned in responses, not hardcoded in the UI.
- **Diagnostic logging**: The Chrome adapter logs significant lifecycle events (availability checks, session creation with context window stats, truncation, prompt dispatch, result parsing, errors) using the existing `[TopSkip ...]` prefix convention. Download progress logs at 0%/25%/50%/75%/100% milestones.

## Testing Decisions

- **Good test for this feature**: Each adapter in isolation with mocked I/O (no network, no `LanguageModel`), plus integration tests for the pipeline routing (provider A selected → adapter A called; switch to B → adapter B called on next run).
- **Modules with tests**: `LlmProviderAdapter` implementations (OpenRouter + Chrome), `ProviderRegistry`, `ActiveProviderStorage` (refactored prefs), `OnboardingWidget` (per-state rendering), `ProviderSelector` (selection + panel switching), `PreferencesStore` (active provider observable).
- **Prior art in codebase**: `tests/content/skip-logic.test.ts` and `tests/content/page-guards.test.ts` for pure-logic unit tests; `tests/popup/preferences-store.test.ts` for MobX store tests with mocked `browser.runtime.sendMessage`.

## Out of Scope

- **Comparison/evaluation framework**: The user mentioned comparing free vs paid models later. This feature provides the plumbing to switch providers, not a benchmarking or A/B testing tool.
- **Simultaneous multi-provider analysis**: Only one provider is active at a time.
- **Ollama, Together, or other third-party providers**: The adapter interface is designed to support them, but implementing concrete adapters for specific providers is deferred.
- **i18n for new UI strings**: English-only for this feature. Existing i18n infrastructure continues to work; new strings may use it later.
- **Chrome Prompt API in content scripts**: The adapter runs in the service worker only. No Prompt API usage in content scripts.
- **Streaming responses**: Both adapters use non-streaming calls. Streaming is a future optimization.
- **Model fine-tuning or custom system prompts**: The system prompt is shared across providers and not user-configurable.

## Open Questions

| Question | Owner | Resolution Path |
| --- | --- | --- |
| Does `LanguageModel.create({ monitor })` fire `downloadprogress` events when the download is resumed (not started fresh)? | Developer | Test in Chrome 138+ during implementation; if not, re-query `availability()` on page focus to detect state changes. |
| What is the exact token limit for Gemini Nano's context window? | Developer | Read `session.contextWindow` at session creation time; use it dynamically rather than hardcoding. |
| Can `session.prompt()` with `responseConstraint` reliably produce valid JSON from Gemini Nano for the promo-detection schema? | Developer | Prototype during implementation; if unreliable, fall back to raw text + `parseLlmPromoResponse()`. |
| Should the `OpenRouterStorage.enabled` removal require a data migration for existing users who have it set to `false`? | Developer | Yes — migration reads `topskip:openrouter.enabled`, sets `topskip:prefs.enabled` accordingly, then removes the old key. |

## Success Criteria

### Measurable Outcomes

- **SC-001**: A user with no API key can run promo detection using Chrome Built-in and receive skip results on a YouTube video with a known sponsor segment.
- **SC-002**: Switching between providers on the options page takes fewer than 3 clicks (select provider tab → configure if needed → save).
- **SC-003**: The popup displays the active provider and model name within 1 second of opening, for both provider types.
- **SC-004**: All new unit tests pass (`pnpm run test`), covering: adapter routing, provider switching, availability checking, and preferences store updates.
- **SC-005**: Adding a hypothetical third provider requires implementing only the `LlmProviderAdapter` interface and registering it — no changes to the promo-detection pipeline, message types, or storage logic beyond the new adapter's own config.
- **SC-006**: When Chrome Built-in is unavailable (unsupported browser/hardware), the options page clearly communicates this and prevents selection, with zero console errors.
- **SC-007**: Existing E2E tests continue to pass with no modification (the OpenRouter path is unchanged behind the adapter).
- **SC-008**: The onboarding widget renders the correct UI for each of the four `LanguageModel.availability()` states, verified by unit tests with mocked availability values.
