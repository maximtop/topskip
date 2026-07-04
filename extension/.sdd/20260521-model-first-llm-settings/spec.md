# Feature Specification: Model-First LLM Settings

**Created**: 2026-05-21
**Status**: Validated
**Implemented by**: GPT-5 Codex (medium)
**Model**: GPT-5 Codex (medium)
**Input**: Redesign TopSkip LLM detection settings from provider-first to model-first. Current options UI asks user to select a promo-detection provider (Chrome Built-in Prompt API vs OpenRouter BYOK), then configure provider-specific API key and OpenRouter model slug. This is confusing because users think in terms of models, not providers. Desired behavior: options page lets user choose only a detection model as the primary control. Each model belongs to a provider behind the scenes. Providers may include OpenRouter, OpenAI, Chrome built-in Prompt API, and possibly Firefox built-in/on-device LLM later. Provider selection should not be exposed as a primary user choice. Provider settings should only collect credentials when the selected model requires them, e.g. OpenRouter API key for OpenRouter models, OpenAI API key for OpenAI models, no key for Chrome built-in model. Custom model support should remain possible for provider-backed models, starting with OpenRouter slugs, but should be presented as adding models rather than choosing a provider. Runtime detection pipeline may still use provider adapters internally. Need align storage/messages/options UI/popup labels/tests with this model-first UX while preserving existing background-only storage rule and provider registry architecture where useful.

## Assumptions

- **Model is the user-facing unit of choice**: The options page should present one primary detection model control. Provider names may appear as supporting metadata, but users should not have to choose a provider first.
- **Provider remains an internal routing concern**: The promo-detection pipeline may continue to use provider adapters and provider identifiers internally, as long as user-facing settings are model-first.
- **OpenAI is in scope**: The first shippable slice should cover OpenRouter models, OpenAI models, and Chrome Built-in Prompt API. Future browser built-in providers should fit the same model catalog shape later.
- **Credentials live in a separate connections section**: API keys should not sit directly under the model selector. The model section chooses the active model; a separate connections/API keys section manages provider credentials and highlights keys required by the active model.
- **Connection testing is explicit**: API key entries should include a user-triggered test action so users can verify a key before relying on it for promo detection.
- **Custom OpenRouter slugs remain supported**: Existing custom model behavior should be reframed as "Add model" and tied to a provider behind the scenes.
- **Storage privacy boundary remains unchanged**: Popup, options, and content scripts still use runtime messaging for settings. Background-owned storage remains the source of truth for preferences and provider secrets.
- **One active model at a time**: Multi-model analysis, fallback chains, and automatic model ranking are out of scope.

## User Scenarios & Testing

### User Story 1 - Choose Detection Model Directly (Priority: P1)

A user opens TopSkip settings and chooses the model they want TopSkip to use for promo detection. They do not need to understand whether the model is routed through OpenRouter, OpenAI, Chrome built-in AI, or another provider.

**Why this priority**: This removes the main confusion in the current screen. The user's mental model is "which model should detect promos", not "which provider should I configure first".

**Independent Test**: Open options with at least one OpenRouter model, one OpenAI model, and one Chrome built-in model available. Verify the primary control is model selection, not provider selection, and changing the model changes the active detection route.

**Acceptance Scenarios**:

1. **Given** the options page loads, **When** the General detection settings render, **Then** the primary setup section is titled around choosing a detection model, not choosing a provider.
2. **Given** multiple models are available, **When** the user selects an OpenRouter model, **Then** TopSkip stores that model as active and routes future detection through the OpenRouter-backed path.
3. **Given** multiple models are available, **When** the user selects an OpenAI model, **Then** TopSkip stores that model as active and routes future detection through the OpenAI-backed path.
4. **Given** multiple models are available, **When** the user selects the Chrome built-in model, **Then** TopSkip stores that model as active and routes future detection through the built-in browser path.
5. **Given** a model has provider metadata, **When** the model appears in the selector, **Then** the UI may show a secondary provider label without making provider selection a separate step.

---

### User Story 2 - Manage Provider Connections Separately (Priority: P1)

A user manages API keys in a dedicated connections section instead of inside the model-choice section. When the active model needs a missing key, the model section can show a setup warning or link, but key entry stays in the connections section.

**Why this priority**: This keeps model choice clean and makes credentials reusable account-level setup. Users can switch models without the page feeling like provider selection is still the main task.

**Independent Test**: Select a remote model with no saved key, a remote model with a saved key, and a built-in model. Verify the model selector remains focused on models, while the separate connections section shows relevant saved/missing key state and can test whether a key is valid.

**Acceptance Scenarios**:

1. **Given** an OpenRouter model is selected and no OpenRouter key is saved, **When** the settings render, **Then** the model section indicates setup is required and the separate connections section shows OpenRouter missing-key status.
2. **Given** an OpenRouter key is already saved, **When** an OpenRouter model is selected, **Then** the connections section shows saved-key status without exposing the full key.
3. **Given** an OpenRouter key is entered or saved, **When** the user clicks the OpenRouter connection's test button, **Then** TopSkip checks whether the key is valid and shows success or actionable failure feedback.
4. **Given** a Chrome built-in model is selected, **When** the settings render, **Then** the connections section may still list cloud provider keys, but the active model state does not imply any external key is required.
5. **Given** an OpenAI model is selected and no OpenAI key is saved, **When** the settings render, **Then** the model section indicates setup is required and the separate connections section shows OpenAI missing-key status.
6. **Given** an OpenAI key is entered or saved, **When** the user clicks the OpenAI connection's test button, **Then** TopSkip checks whether the key is valid and shows success or actionable failure feedback.

---

### User Story 3 - Add Extra Models Without Switching Provider First (Priority: P1)

A user wants to use a model that is not in the default list. They add the model from an "Add model" flow, choose the provider only as model metadata if needed, and then select the added model like any other model.

**Why this priority**: Custom OpenRouter slugs are important today, but the current "Custom OpenRouter models" section reinforces the provider-first design.

**Independent Test**: Add a valid OpenRouter slug, verify it appears in the model list, select it, and confirm future detection uses that slug.

**Acceptance Scenarios**:

1. **Given** the user opens the add-model flow, **When** OpenRouter is the only custom-model provider available, **Then** the flow can default to OpenRouter without making the user choose between providers.
2. **Given** the user enters a valid OpenRouter model slug, **When** validation succeeds, **Then** the model is added to the available model list and can become active.
3. **Given** the user enters an invalid or unavailable model slug, **When** validation fails, **Then** the page shows actionable validation feedback and does not add the model as confirmed.
4. **Given** the active model is a custom model, **When** the user removes it, **Then** TopSkip falls back to a valid default model and keeps unrelated credentials intact.

---

### User Story 4 - See Active Model Everywhere It Matters (Priority: P2)

A user can see which detection model is active in the options page and popup. Provider details may be shown as secondary context so users understand cost, network, and setup implications.

**Why this priority**: Users need confidence about cost and privacy, especially when switching between local and paid cloud models.

**Independent Test**: Select OpenRouter and built-in models, then open popup and options. Verify the active model label is clear and provider context is secondary.

**Acceptance Scenarios**:

1. **Given** an OpenRouter model is active, **When** the user opens the popup, **Then** the status label prioritizes the model name and may include OpenRouter as secondary context.
2. **Given** Chrome built-in model is active, **When** the user opens the popup, **Then** the status label shows the built-in model name and indicates that no external key is required.
3. **Given** the active model is not configured, **When** the popup renders, **Then** the user sees which model needs setup and can open options to finish configuration.

---

### User Story 5 - Keep Future Providers Easy to Add (Priority: P2)

A developer adds a new provider-backed model family without redesigning the user-facing settings again. Models enter the catalog with provider metadata, setup requirements, availability, and display labels.

**Why this priority**: The product includes OpenAI in the first model-first version and still anticipates future browser built-in models. The redesign should prevent another provider-first refactor later.

**Independent Test**: Add a test provider/model entry to the model catalog and verify it appears in the model selector, requests its required setup, and routes detection through the matching provider adapter.

**Acceptance Scenarios**:

1. **Given** a new provider-backed model is registered, **When** the options page loads, **Then** the model appears as a selectable model if its availability rules allow it.
2. **Given** the new provider requires credentials, **When** its model is selected, **Then** the model section points to the separate connections section for the missing or saved credential state.
3. **Given** the new provider does not require credentials, **When** its model is selected, **Then** the model section marks it usable without directing the user to credential setup.

### Edge Cases

- What happens when the previously active provider ID exists but no active model ID can be resolved during migration?
- How does the UI behave when a saved custom model slug belongs to a provider whose credential is missing?
- How does the connections section order providers when multiple API-key providers are supported but only one is required by the active model?
- How does key testing behave for unsaved draft keys versus already saved keys?
- How does key testing report network failures, unauthorized keys, revoked keys, and provider rate limits?
- Which OpenAI models ship as built-in presets for the first model-first version?
- How does the UI show unavailable, downloadable, downloading, and ready states for built-in models?
- How are long model names, long slugs, provider badges, and translated strings handled on narrow options widths and in the popup?
- How does the system avoid losing saved OpenRouter credentials when the user switches to a built-in model?
- What happens when model validation cannot reach the provider model-list API?
- What happens when the selected model is removed from the default catalog in a future version?
- How should duplicate display names from different providers be disambiguated?

## Requirements

### Functional Requirements

- **FR-001**: The options page MUST expose model selection as the primary detection configuration control.
- **FR-002**: The options page MUST NOT expose provider selection as a separate primary choice in the main detection setup flow.
- **FR-003**: Each selectable model MUST have a stable user-facing name and enough hidden provider metadata for the system to route detection correctly.
- **FR-004**: Each selectable model SHOULD show secondary context for cost, privacy, or provider when that context helps users choose safely.
- **FR-005**: Selecting a model MUST persist the active model choice and update the active detection route without requiring a page reload.
- **FR-006**: Selecting an OpenRouter-backed model MUST route promo detection through the OpenRouter-backed analysis path.
- **FR-007**: Selecting an OpenAI-backed model MUST route promo detection through the OpenAI-backed analysis path.
- **FR-008**: Selecting a Chrome built-in model MUST route promo detection through the browser built-in analysis path.
- **FR-009**: The model catalog MUST include OpenAI model presets in the first model-first version.
- **FR-010**: The settings page MUST place provider API key controls in a separate connections/API keys section, not inside the primary model selection section.
- **FR-011**: The model selection section MUST indicate when the active model needs missing setup and SHOULD link or scroll to the relevant connection entry.
- **FR-012**: The settings page MUST show saved-key status without revealing a full saved API key.
- **FR-013**: The active model state MUST NOT imply that built-in local/browser models require any external API key.
- **FR-014**: Each API-key connection entry MUST provide a user-triggered test action that validates the current key for that provider.
- **FR-015**: Key testing MUST show a clear success, invalid-key, or retryable-error state without exposing the full key.
- **FR-016**: Key testing MUST be available for a draft key before save, for a saved key, or both if the UI supports both states.
- **FR-017**: The connections section MUST support OpenRouter and OpenAI API key entries in the first model-first version.
- **FR-018**: Users MUST be able to add an OpenRouter custom model slug through an add-model flow.
- **FR-019**: Added custom models MUST appear in the same model selection control as built-in presets.
- **FR-020**: Custom OpenRouter model validation MUST reject invalid slug format and SHOULD verify model existence when a usable API key is present.
- **FR-021**: Removing a custom model MUST preserve unrelated credentials and MUST leave the active model in a valid state.
- **FR-022**: The popup MUST prioritize active model display over provider display.
- **FR-023**: The popup MAY show provider as secondary context when useful for setup, privacy, or cost clarity.
- **FR-024**: Not-configured states MUST identify the selected model and the missing setup needed to use it.
- **FR-025**: Existing saved OpenRouter model and provider preferences MUST migrate to an equivalent active model choice.
- **FR-026**: Migration MUST preserve saved API keys and custom model lists.
- **FR-027**: The runtime detection pipeline MAY keep provider adapters internally, but user-facing settings and labels MUST be model-first.
- **FR-028**: Popup, options, and content scripts MUST continue to request settings through extension messaging rather than reading or writing provider secrets directly.
- **FR-029**: Background-owned storage MUST remain the source of truth for preferences, active model routing metadata, and provider credentials.
- **FR-030**: Provider additions after this change SHOULD require adding model catalog/setup metadata without redesigning the options page.
- **FR-031**: Automated tests MUST cover model selection, OpenRouter and OpenAI connection status, API key test success/failure, custom model add/remove, migration from provider-first prefs, popup active-model labels, and routing to the correct analysis path.

### Key Entities

- **Detection Model**: User-facing model option with stable ID, display name, optional provider context, setup requirements, availability state, and routing metadata.
- **Provider**: Internal analysis backend that can run one or more detection models and may require credentials or readiness checks.
- **Connection Entry**: Provider-specific credential setup row such as an OpenRouter or OpenAI API key, including saved/missing/editable/tested state and whether the active model currently depends on it.
- **Custom Model**: User-added model entry, initially an OpenRouter slug, that joins the same selection list as built-in model presets.
- **Active Model Choice**: Persisted choice that determines which model TopSkip uses for future promo detection.
- **Model Availability**: State describing whether a model can be used now, needs setup, needs download, is downloading, or is unavailable.

## Success Criteria

### Measurable Outcomes

- **SC-001**: A user can change the active detection model from the options page without interacting with a provider selector.
- **SC-002**: A user can identify the active detection model in the popup within 5 seconds during a manual smoke test.
- **SC-003**: Selecting a built-in/browser model shows the active model as usable without any external API key requirement.
- **SC-004**: Selecting an OpenRouter-backed model with no saved key marks the model as requiring setup and identifies the OpenRouter entry in the separate connections section.
- **SC-005**: Selecting an OpenAI-backed model with no saved key marks the model as requiring setup and identifies the OpenAI entry in the separate connections section.
- **SC-006**: Saved OpenRouter and OpenAI keys survive switching between cloud and built-in models.
- **SC-007**: A user can test OpenRouter and OpenAI keys from the connections section and see whether each key is valid before relying on it for detection.
- **SC-008**: Existing users with provider-first preferences keep an equivalent active model after migration.
- **SC-009**: Long model names and custom slugs do not overlap controls or cause horizontal scrolling at representative options widths of 360px, 768px, and 1024px.
- **SC-010**: Unit and rendering tests verify that active model changes route detection through the expected provider adapter.
- **SC-011**: Existing preference, OpenRouter storage, OpenAI storage, provider routing, popup label, key testing, and options rendering tests are updated or replaced so model-first behavior has regression coverage.
- **SC-012**: No new runtime secrets become readable from popup, options, or content scripts.
