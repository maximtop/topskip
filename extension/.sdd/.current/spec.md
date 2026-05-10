# Feature Specification: TopSkip Popup and Options Redesign

**Created**: 2026-05-08
**Status**: Validated
**Implemented by**: GitHub Copilot (model/version not exposed)
**Model**: GitHub Copilot (model/version not exposed)
**Input**: /sdd:sdd-spec implement design like on this image

## Assumptions

- **Screenshot is the visual target**: The attached image defines the intended direction for layout, hierarchy, spacing, tone, and component states. Implementation should be a close visual match, not a pixel-perfect clone.
- **Both extension surfaces are in scope**: The redesign covers the toolbar popup and the extension options page because both are shown in the reference image.
- **Current behavior remains intact**: The feature is a UI/UX redesign. Existing TopSkip capabilities, storage boundaries, provider selection, model selection, custom model management, detection status, and auto-skip behavior should continue to work unless explicitly changed by this spec.
- **Options navigation is mostly future-facing**: The options page should show sidebar items for General, Detection, Appearance, Shortcuts, and About. General is the only fully functional section in this feature; the other sections may be visible disabled states, placeholders, or non-destructive empty states.
- **Full responsive support is required**: The popup must fit Chrome extension popup constraints, and the options page must remain usable across desktop, tablet, and narrow mobile-like widths.
- **Accessibility is part of visual quality**: The redesigned UI must preserve keyboard navigation, visible focus states, accessible names, status semantics, and readable contrast.
- **Provider concepts follow existing product language**: Chrome Built-in Prompt API and OpenRouter BYOK are the provider choices shown in the options page; OpenRouter settings include API key status, model preset selection, and custom model slugs.

## User Scenarios & Testing

### User Story 1 - Understand Current Video Status in Popup (Priority: P1)

A user opens the TopSkip toolbar popup while watching YouTube and immediately sees whether TopSkip is connected to the current video, whether promo detection is active, whether auto-skip is on, and what promo blocks were detected.

**Why this priority**: The popup is the fastest feedback surface. Users need confidence that TopSkip is active and acting on the correct video before changing deeper settings.

**Independent Test**: Open the popup against a YouTube watch page with detected promo blocks and verify that the popup presents connection status, auto-skip state, promo block count, video timeline markers, block rows, options link, and version without requiring navigation to the options page.

**Acceptance Scenarios**:

1. **Given** TopSkip is enabled and the active tab is a supported YouTube watch page, **When** the user opens the popup, **Then** the popup shows a connected/active status in the top status area.
2. **Given** auto-skip is enabled, **When** the user opens the popup, **Then** the auto-skip switch appears on and its label clearly describes skipping sponsor or promo segments.
3. **Given** promo blocks are detected for the current video, **When** the popup renders, **Then** it shows the number of blocks, a timeline summary, and each detected block's start time, end time, and duration.
4. **Given** no promo blocks are available yet, **When** the popup renders, **Then** it shows a stable empty or analyzing state without layout jumps or misleading detected-block counts.
5. **Given** the user activates the options link, **When** the browser handles the action, **Then** the TopSkip options page opens.

---

### User Story 2 - Toggle Auto-Skip Quickly from Popup (Priority: P1)

A user can turn automatic promo skipping on or off directly from the popup without opening settings. The visual design should make the switch state obvious and keep detection details readable.

**Why this priority**: The master enable/disable action is the most important quick control. A redesign must not make the core safety control harder to find or operate.

**Independent Test**: Toggle auto-skip off and on from the redesigned popup. Verify the switch state, status text, and stored preference update while the rest of the popup remains visually stable.

**Acceptance Scenarios**:

1. **Given** auto-skip is on, **When** the user toggles it off, **Then** the popup immediately reflects the off state and TopSkip stops auto-skipping on supported watch pages.
2. **Given** auto-skip is off, **When** the user toggles it on, **Then** the popup immediately reflects the on state and TopSkip resumes auto-skipping on supported watch pages.
3. **Given** saving the toggle fails, **When** the popup receives the failure, **Then** the user sees an error state and the UI returns to the last confirmed preference.
4. **Given** the popup is reopened after a preference change, **When** it loads, **Then** it displays the persisted preference.

---

### User Story 3 - Configure Detection Provider in Options (Priority: P1)

A user opens the options page and uses a left-sidebar settings layout to choose between Chrome Built-in Prompt API and OpenRouter BYOK. The General section exposes provider selection and current provider-specific setup controls in one focused page.

**Why this priority**: Provider setup is required for detection to work. The screenshot's main options value is a clearer, more structured provider configuration flow.

**Independent Test**: Open the options page, switch between provider choices, and verify the selected provider state, explanatory copy, and provider-specific controls update without breaking stored preferences.

**Acceptance Scenarios**:

1. **Given** the options page loads, **When** settings are available, **Then** it shows a sidebar, TopSkip branding, a General active state, and the main heading "TopSkip Settings" with concise setup copy.
2. **Given** OpenRouter is selected, **When** the General section renders, **Then** the OpenRouter provider card appears selected and OpenRouter BYOK settings are visible.
3. **Given** Chrome Built-in Prompt API is selected, **When** the user changes provider selection, **Then** the provider preference is saved and Chrome Built-in status/setup content is shown instead of OpenRouter-specific settings.
4. **Given** provider state cannot be loaded or saved, **When** the options page renders or the user switches provider, **Then** a visible non-destructive error appears and the last confirmed provider remains clear.
5. **Given** future sidebar items are shown, **When** the user tries to navigate to Detection, Appearance, Shortcuts, or About, **Then** the UI clearly communicates that these sections are not yet configurable or presents safe placeholder content without data loss.

---

### User Story 4 - Manage OpenRouter BYOK Settings (Priority: P1)

A user using OpenRouter can see whether their API key is saved, save or update the key, select a built-in model preset, and manage custom model slugs from the redesigned General settings page.

**Why this priority**: OpenRouter BYOK is the current primary provider path. A visual refresh must preserve all setup actions required for actual detection.

**Independent Test**: With OpenRouter selected, save an API key, choose a preset model, add a custom model slug, and remove a custom model slug. Verify each action has visible success/error feedback.

**Acceptance Scenarios**:

1. **Given** an OpenRouter API key is saved, **When** the OpenRouter settings panel renders, **Then** it shows saved-key status without revealing the full key.
2. **Given** the user enters a new API key, **When** the user saves it, **Then** the key is persisted by existing settings behavior and the UI shows saved-key feedback.
3. **Given** built-in model presets are available, **When** the user opens the model selector, **Then** the current preset and available presets are readable and selectable.
4. **Given** the user enters a valid custom OpenRouter model slug, **When** the user adds it, **Then** it appears in the custom model list and can be selected where model choices are offered.
5. **Given** the user removes a custom model slug, **When** removal succeeds, **Then** the model is removed from the list without affecting unrelated settings.
6. **Given** a model slug is invalid or cannot be verified, **When** the user attempts to add it, **Then** the page shows actionable validation feedback and does not add an invalid confirmed model.

---

### User Story 5 - Use Redesigned UI Across Viewports (Priority: P2)

A user can use the redesigned options page and popup on different viewport widths without overlapping content, hidden primary actions, or unreadable controls.

**Why this priority**: Chrome options pages can be opened in narrow windows, and extension popups have fixed-size constraints. The screenshot is desktop-oriented, but usability must not depend on that exact size.

**Independent Test**: Render the popup at extension popup dimensions and the options page at representative desktop, tablet, and narrow widths. Verify primary controls remain usable and content does not overlap.

**Acceptance Scenarios**:

1. **Given** the options page is opened on a wide desktop viewport, **When** it renders, **Then** the sidebar and main content match the reference layout with stable alignment.
2. **Given** the options page is opened on a narrow viewport, **When** it renders, **Then** navigation and content adapt so all controls remain reachable without horizontal scrolling.
3. **Given** long provider names, model slugs, translated labels, or error text, **When** they render, **Then** text wraps or truncates gracefully without overlapping controls.
4. **Given** the popup renders at normal extension popup size, **When** detection details are long or absent, **Then** the popup remains compact, readable, and visually stable.

---

### Edge Cases

- What happens when the active browser tab is not a supported YouTube watch page?
- How does the popup represent analyzing, no-promo, error, unavailable, not-configured, and partial-coverage detection states?
- How does the timeline display when promo blocks overlap, have missing end times, are very short, or span the full video?
- How does the UI behave when video duration is unavailable or zero?
- How are long model slugs, long translated strings, and narrow viewports handled?
- How does the options page handle OpenRouter API key save failure, provider save failure, custom model validation failure, and service worker startup delays?
- How are future sidebar sections represented so users do not mistake placeholders for working configuration?
- How does the design preserve accessible switch labels, status announcements, keyboard order, and focus visibility?

## Requirements

### Functional Requirements

- **FR-001**: The popup MUST use the reference image's structure: branded header, current-video connection status area, auto-skip control section, detected promo blocks section, options link, and version/footer area.
- **FR-002**: The popup MUST show whether TopSkip is connected to the current YouTube video and whether promo detection is active, unavailable, idle, analyzing, successful, or failed.
- **FR-003**: The popup MUST expose the existing auto-skip enabled preference as a switch with an accessible name and visible on/off state.
- **FR-004**: The popup MUST display detected promo blocks with count, timeline markers, start/end times, and durations when detection data exists.
- **FR-005**: The popup MUST provide clear empty, analyzing, no-promo, not-configured, unavailable, partial-coverage, and error states without implying blocks were detected when they were not.
- **FR-006**: The popup MUST provide an action that opens the options page.
- **FR-007**: The options page MUST use the reference image's structure: left navigation/branding sidebar and a General settings content area.
- **FR-008**: The options page MUST show the General sidebar item as active for this feature.
- **FR-009**: The options page MUST include Detection, Appearance, Shortcuts, and About sidebar items as visible future sections or safe placeholders, unless later implementation plans explicitly scope them out.
- **FR-010**: The General options page MUST let users choose between Chrome Built-in Prompt API and OpenRouter BYOK provider options.
- **FR-011**: Provider selection MUST persist using the existing preference flow and MUST not require a page reload to update visible provider-specific controls.
- **FR-012**: The Chrome Built-in provider card MUST communicate that analysis runs on-device and does not require an external API key.
- **FR-013**: The OpenRouter BYOK provider card MUST communicate that users supply their own OpenRouter API key and can use supported OpenRouter models.
- **FR-014**: When OpenRouter is selected, the options page MUST show API key saved/unsaved state without exposing a saved key in full.
- **FR-015**: When OpenRouter is selected, the options page MUST let users save or update the API key and receive success or error feedback.
- **FR-016**: When OpenRouter is selected, the options page MUST let users choose from built-in model presets.
- **FR-017**: When OpenRouter is selected, the options page MUST let users add and remove custom OpenRouter model slugs with validation feedback.
- **FR-018**: The redesigned UI MUST preserve existing storage and messaging boundaries: popup and options request settings changes through extension messaging, while background-owned storage remains the source of truth.
- **FR-019**: The redesigned UI MUST be responsive across popup dimensions and options-page desktop, tablet, and narrow viewport widths.
- **FR-020**: The redesigned UI MUST maintain keyboard accessibility for all interactive controls, including provider cards, switches, sidebar items, links, buttons, selects, and custom model actions.
- **FR-021**: The redesigned UI MUST maintain meaningful accessible names and status semantics for switches, alerts, saved states, connection states, and loading states.
- **FR-022**: The redesigned UI MUST avoid overlapping text, clipped primary actions, and horizontal scrolling at supported viewport widths.
- **FR-023**: Visual styling SHOULD closely match the screenshot's calm light theme, blue accent color, card borders, compact spacing, status badges, and button hierarchy while respecting existing product branding.
- **FR-024**: The redesign MUST NOT add new external network calls, new runtime permissions, or new data collection.
- **FR-025**: Existing automated checks for popup/options rendering and accessibility MUST be updated or preserved so the redesigned surfaces are covered by regression tests.

### Key Entities

- **Popup Status Summary**: User-facing representation of current tab connection, promo detection state, auto-skip state, provider readiness, and detected promo block summary.
- **Promo Block Display Item**: A displayed promo segment with start time, end time, duration, and timeline position.
- **Options Navigation Item**: A visible settings section entry with label, active/placeholder state, and navigation behavior.
- **Provider Choice**: A selectable detection backend option with display name, description, availability/selection state, and provider-specific setup requirements.
- **OpenRouter Configuration**: BYOK settings including saved-key status, selected preset/custom model, custom model list, validation state, and save feedback.
- **Responsive Layout State**: The arrangement of sidebar, main content, cards, controls, and lists at different viewport widths.

## Success Criteria

### Measurable Outcomes

- **SC-001**: A user can identify TopSkip connection status, auto-skip state, and promo block count in the popup within 5 seconds during a usability smoke test.
- **SC-002**: A user can toggle auto-skip from the popup in one interaction, and the confirmed state is visible immediately after the action completes.
- **SC-003**: A user can choose the active detection provider from the options page in one interaction after page load.
- **SC-004**: A user can save an OpenRouter API key, select a preset model, add a custom model, and remove a custom model without leaving the General options section.
- **SC-005**: The options page remains usable with no horizontal scrolling or overlapping controls at representative widths of 360px, 768px, and 1024px.
- **SC-006**: The popup remains usable with no horizontal scrolling, overlapping controls, or clipped primary actions at the extension popup viewport used by automated tests.
- **SC-007**: Automated accessibility checks for popup and options pages report no critical violations for keyboard navigation, labels, roles, and status/error semantics.
- **SC-008**: Existing unit and e2e tests for preferences, provider selection, OpenRouter settings, popup rendering, and options rendering pass after the redesign.
- **SC-009**: The redesign does not introduce additional extension permissions, external data collection, or new network requests beyond existing provider-related behavior.
- **SC-010**: Manual visual review confirms the popup and options page are a close match to the attached reference image in layout, hierarchy, spacing, and primary visual states.
