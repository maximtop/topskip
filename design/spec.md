# Feature Specification: Design System & UI Modernization

**Created**: 2026-04-15
**Status**: Validated
**Model**: claude-opus-4.6
**Input**: design does not look great, check modern design requirements,
accessibility, etc, describe our design system, and we will implement it

## Selected Direction (2026-04-16)

The implementation direction is now narrowed from generic modernization to a
specific product UX blend chosen from the concept exploration and visual
mockups.

- **Popup behavior**: combine Quick Status Tap, Smart Context, and Detection
  Timeline. The popup must feel calm and immediate: one dominant control,
  state-aware messaging, and lightweight visual detection when promo blocks
  exist.
- **Visual language**: combine the restraint of Clean Minimal,
  the editorial calm of Notion-like, and the polished information framing of
  Stripe-inspired settings.
- **Options behavior**: keep the options page as the full control room, but
  present it with a cleaner summary-first structure instead of a plain stacked
  form.
- **Implementation constraint**: this is still a UI-only redesign. Background
  logic, detection behavior, and message contracts do not change.

## Assumptions

- **Mantine 9 remains the UI framework**: The project already depends on
  Mantine 9 + React 19. The design system will be built as a custom Mantine
  theme configuration rather than introducing a new component library. This
  avoids bundle bloat and leverages existing infrastructure.
- **Chrome extension constraints apply**: The popup has a maximum width of
  ~800px (Chrome enforced) and the current 320px target is reasonable. The
  options page opens in a full tab and can use wider layouts.
- **No brand guidelines exist**: TopSkip is an MVP with no established brand
  identity. The design system will define one from scratch, targeting a clean,
  modern, developer-tool aesthetic.
- **Dark/light mode must both work**: The current `defaultColorScheme="auto"`
  (OS preference) is the right approach and will be preserved.
- **Content script toast is in-scope**: The `showSkipToast()` overlay injected
  into YouTube pages is part of the user-facing UI and must meet accessibility
  and design standards.
- **No additional UI dependencies**: The design system must be implementable
  with Mantine's theming API, CSS variables, and minimal custom CSS. No new
  UI libraries (Tailwind, Radix, shadcn, etc.) will be added.
- **Progressive enhancement**: The redesign will not change functionality. All
  existing features (toggle, detection status, settings form, toast) remain
  identical in behavior.
- **Chosen visual tone is restrained**: The final UI should avoid loud
  gradients, glassmorphism, or novelty styling. It should read as trustworthy,
  minimal, and productized.

## User Scenarios & Testing

### User Story 1 - Consistent Visual Identity Across All Surfaces (Priority: P1)

A user installs TopSkip and encounters three UI surfaces: the toolbar popup,
the options page, and the in-page skip toast. Today each looks like an
unstyled Mantine default with no visual relationship between them. After the
redesign, all three surfaces share a cohesive color palette, typography scale,
spacing rhythm, and component styling that communicates "this is one product."

**Why this priority**: Visual consistency is the foundation of trust and
perceived quality. Users judge extension credibility within seconds of opening
the popup. An unstyled default Mantine look signals "unfinished prototype" and
reduces confidence in the extension's reliability.

**Independent Test**: Open the popup, options page, and trigger a skip toast.
Verify that all three use the same brand colors, font family, font sizes,
spacing units, and border-radius values. A screenshot comparison should show
they belong to the same product.

**Acceptance Scenarios**:

1. **Given** the extension is installed, **When** a user opens the popup,
   **Then** it renders with the TopSkip brand colors, defined typography scale,
   and consistent spacing — not Mantine's default blue theme.
2. **Given** the user opens the options page, **When** it loads, **Then** the
   page header, form controls, and buttons use the same theme tokens as the
   popup.
3. **Given** a skip is triggered on YouTube, **When** the toast appears,
   **Then** it uses design system colors and typography (not hardcoded inline
   styles).

---

### User Story 2 - Accessible Popup Interaction (Priority: P1)

A user with a screen reader opens the TopSkip popup. They can navigate all
controls, understand the current state (enabled/disabled, detection status),
and perform actions (toggle, open settings) using only the keyboard and
assistive technology. Color is never the sole indicator of state.

**Why this priority**: Accessibility is a baseline requirement, not a feature.
Chrome Web Store review may flag inaccessible extensions. Screen reader users
and keyboard-only users must be able to operate the extension.

**Independent Test**: Navigate the popup using only Tab/Shift+Tab and
Enter/Space. Verify all interactive elements are reachable, their purpose is
announced, and state changes are communicated. Run axe-core or Lighthouse
accessibility audit and achieve zero critical violations.

**Acceptance Scenarios**:

1. **Given** the popup is open, **When** a user presses Tab repeatedly,
   **Then** focus moves through all interactive elements (toggle switch,
   settings button) in a logical order with visible focus indicators.
2. **Given** the toggle switch is focused, **When** a screen reader reads it,
   **Then** it announces the label ("Enable promo skip"), the role ("switch"),
   and the current state ("on" or "off").
3. **Given** the detection status changes to "Promo blocks detected",
   **When** this happens while the popup is open, **Then** the status text is
   in an ARIA live region so screen readers announce the update.

---

### User Story 3 - Modern, Polished Popup Layout (Priority: P2)

A user opens the popup and sees a well-structured, visually appealing
interface with clear hierarchy: a branded header area, the primary toggle
control prominently placed, context-aware status information clearly
secondary, and action buttons with appropriate visual weight.

**Why this priority**: The popup is the primary interaction point. A polished
layout improves usability by making the most important action (the toggle)
immediately obvious and reducing cognitive load.

**Independent Test**: Open the popup and verify: (1) the header identifies
the product, (2) the toggle is the most visually prominent interactive
element, (3) status text is clearly secondary, (4) the settings button is
clearly a secondary action, (5) the reliability notice does not dominate the
view.

**Acceptance Scenarios**:

1. **Given** a user opens the popup, **When** it renders, **Then** the visual
  hierarchy flows: primary status card > primary toggle > context-aware
  status info > secondary actions > informational notices.
2. **Given** the popup is rendered, **When** the user scans it, **Then** the
   on/off state is immediately clear from both color and iconography (not
   color alone).
3. **Given** the reliability notice is present, **When** the popup renders,
   **Then** the notice is visually de-emphasized (collapsible or smaller)
   so the primary controls are not pushed below the fold.
4. **Given** promo blocks are available, **When** the popup renders,
  **Then** it shows them in a lightweight visual timeline or segmented track
  rather than only as plain text ranges.
5. **Given** the popup is opened outside a supported watch context,
  **When** it renders, **Then** the main content shifts to a useful empty
  state instead of pretending a detection result exists.

---

### User Story 4 - Modernized Options Page (Priority: P2)

A user navigates to the options page and finds a well-organized settings form
with clear section grouping, helpful descriptions, appropriate input
validation feedback, and a layout that works from 320px to 1200px+ screens.

**Why this priority**: The options page is where users configure the LLM
integration, which is a critical setup step. Poor form design leads to
configuration errors and support requests.

**Independent Test**: Open the options page at various viewport widths (320px,
768px, 1200px). Verify form controls are properly labeled, error/success
states are clear, and the layout adapts gracefully.

**Acceptance Scenarios**:

1. **Given** a user opens the options page, **When** it renders, **Then**
  settings are grouped into logical sections with a summary-first layout
  rather than an undifferentiated stack of form controls.
2. **Given** the user saves settings successfully, **When** the success
   message appears, **Then** it uses a styled notification/banner (not
   plain green text) that is also announced to screen readers.
3. **Given** the viewport is 320px wide, **When** the options page renders,
   **Then** all form controls are fully usable without horizontal scrolling.
4. **Given** the user already has a saved configuration, **When** the options
  page loads, **Then** the page surfaces the current setup state near the top
  so the user can confirm status without rereading the whole form.

---

### User Story 5 - Accessible Skip Toast on YouTube (Priority: P2)

A user relying on a screen reader is watching a YouTube video with TopSkip
enabled. When a promo segment is skipped, the user is informed via an
announcement rather than only a visual toast that disappears after 2.5
seconds.

**Why this priority**: The toast is the only user feedback when a skip occurs.
If it is inaccessible, screen reader users have no idea the extension acted.

**Independent Test**: Trigger a skip while a screen reader is active. Verify
the "Skip applied" message is announced. Verify the toast is visually
consistent with the design system.

**Acceptance Scenarios**:

1. **Given** a skip is triggered, **When** the toast appears, **Then** the
   toast container has `role="status"` and `aria-live="polite"` so screen
   readers announce it.
2. **Given** the toast is visible, **When** a user views it, **Then** it uses
   design system colors, typography, and border-radius rather than hardcoded
   inline styles.
3. **Given** the toast appears, **When** the user has `prefers-reduced-motion`
   enabled, **Then** the fade-out animation is instant (no transition).

---

### User Story 6 - Dark/Light Mode Visual Quality (Priority: P3)

A user switches between light and dark OS themes (or has their system set to
auto). The extension popup, options page, and toast all adapt correctly with
appropriate contrast ratios, no washed-out colors, and no invisible text.

**Why this priority**: The current `auto` color scheme inherits Mantine
defaults which are generally acceptable, but a custom theme needs explicit
dark-mode color definitions to avoid contrast issues.

**Independent Test**: Open the popup and options page in both light and dark
mode. Verify all text meets WCAG 2.1 AA contrast ratios (4.5:1 for body text,
3:1 for large text). Verify the toast on YouTube is readable in both YouTube's
light and dark themes.

**Acceptance Scenarios**:

1. **Given** the OS is in dark mode, **When** the popup opens, **Then** all
   text/background combinations meet WCAG 2.1 AA contrast requirements.
2. **Given** the OS is in light mode, **When** the options page loads,
   **Then** form labels, descriptions, and error messages have sufficient
   contrast.
3. **Given** YouTube is in dark theme, **When** the skip toast appears,
   **Then** it is clearly visible and distinct from YouTube's own overlays.

---

### Edge Cases

- What happens when the popup opens before Mantine CSS loads? The inline
  `<style>` block must provide a stable minimum layout so the popup does not
  flash or collapse.
- How does the design system handle high-contrast/forced-colors mode on
  Windows? Mantine components should degrade gracefully; custom styles must
  not break.
- What happens when the options page is opened in a narrow side-panel
  (e.g., 320px) vs. a full tab (1200px+)?
- How does the toast render when YouTube's player is in theater mode vs.
  default vs. fullscreen?
- What if the user has a browser zoom level of 150% or 200%? The popup must
  not overflow or become unusable.

## Requirements

### Functional Requirements

#### Design System Foundation

- **FR-001**: The project MUST define a Mantine theme configuration object
  (custom `createTheme()`) that specifies: primary color palette, font family,
  font sizes, spacing scale, border-radius values, and default component
  variants.
- **FR-002**: The theme configuration MUST be defined in a single shared
  module (e.g., `src/shared/theme.ts`) imported by both the popup and options
  entry points.
- **FR-003**: The theme MUST define custom colors that work in both light and
  dark color schemes, with each color having a full 10-shade scale per
  Mantine's color system.
- **FR-004**: The theme SHOULD define default component props/styles for
  `Button`, `TextInput`, `Select`, `Switch`, `Checkbox`, `Alert`, `Text`,
  and `Stack` to ensure consistent appearance without per-instance styling.

#### Typography

- **FR-005**: The design system MUST define a typographic scale with at least
  4 levels: heading, subheading, body, and caption. These MUST map to
  Mantine's `fontSizes` theme key.
- **FR-006**: The primary font family MUST be a system font stack (no web
  font downloads) to keep the extension bundle lean and load instantly.
- **FR-007**: Line heights MUST be defined for each font size level to ensure
  consistent vertical rhythm.

#### Spacing & Layout

- **FR-008**: The design system MUST define a spacing scale that is used
  consistently across all surfaces. This SHOULD leverage Mantine's `spacing`
  theme key.
- **FR-009**: The popup layout MUST have a clear visual hierarchy: branded
  header, primary action area, status area, secondary actions, and
  informational area.
- **FR-010**: The options page MUST group related settings into visually
  distinct sections with headings.
- **FR-011**: The options page layout MUST be responsive, functioning
  correctly from 320px to 1200px+ viewport widths.

#### Color & Theming

- **FR-012**: The design system MUST define a primary brand color with
  semantic meaning (not Mantine's default blue).
- **FR-013**: The system MUST define semantic color tokens for: success,
  warning, error, and informational states.
- **FR-014**: All color combinations (text on background) MUST meet WCAG 2.1
  AA contrast requirements (4.5:1 for normal text, 3:1 for large text and
  UI components).
- **FR-015**: The `defaultColorScheme` MUST remain `"auto"` to follow OS
  preference.

#### Accessibility

- **FR-016**: All interactive elements MUST be keyboard-navigable in a
  logical tab order.
- **FR-017**: All interactive elements MUST have visible focus indicators
  that meet WCAG 2.1 AA requirements (3:1 contrast against adjacent colors).
- **FR-018**: The popup's detection status area MUST use an ARIA live region
  (`aria-live="polite"`) so status changes are announced to screen readers.
- **FR-019**: The skip toast MUST have `role="status"` and
  `aria-live="polite"` attributes.
- **FR-020**: Color MUST NOT be the sole means of conveying state (e.g.,
  enabled/disabled, success/error). Text labels or icons MUST supplement
  color.
- **FR-021**: The toast SHOULD respect `prefers-reduced-motion` by disabling
  fade animations when the user preference is set.
- **FR-022**: Form inputs on the options page MUST have associated visible
  labels (not placeholder-only labels).

#### Component Standards

- **FR-023**: Buttons MUST have consistent sizing, padding, and border-radius
  across all surfaces.
- **FR-024**: Form controls (TextInput, Select, Checkbox) MUST have
  consistent styling including focus, hover, error, and disabled states.
- **FR-025**: The reliability notice in the popup SHOULD be visually
  de-emphasized (e.g., collapsible, muted styling, or relegated to a
  secondary area) so primary controls remain above the fold.
- **FR-026**: The skip toast MUST use design system tokens (CSS custom
  properties or theme values) instead of hardcoded inline style values.

#### Documentation

- **FR-027**: The design system MUST be documented in a design system
  reference file that describes: color palette, typography scale, spacing
  scale, component defaults, and accessibility requirements.
- **FR-028**: The design system documentation SHOULD include visual
  examples or token values that developers can reference when building
  new UI.

### Key Entities

- **Theme Configuration**: The central Mantine `createTheme()` object.
  Contains: `primaryColor`, `colors`, `fontFamily`, `fontSizes`,
  `lineHeights`, `spacing`, `radius`, `defaultRadius`, `components`
  (default props/styles). Shared across popup and options entry points.
- **Color Palette**: A set of named color scales (primary, gray, semantic
  colors). Each scale has 10 shades (indices 0-9) per Mantine convention.
  Must work in both light and dark modes.
- **Typography Scale**: Named size levels (`xs`, `sm`, `md`, `lg`, `xl`)
  with corresponding `fontSize` and `lineHeight` values. Applied via
  Mantine's theme keys.
- **Spacing Scale**: Named spacing values (`xs`, `sm`, `md`, `lg`, `xl`)
  used for padding, margins, and gaps. Applied via Mantine's `spacing`
  theme key.
- **Component Defaults**: Per-component default props and style overrides
  (e.g., all Buttons get `radius="md"`, all Alerts get a specific variant).
  Defined in the theme's `components` key.

## Success Criteria

### Measurable Outcomes

- **SC-001**: All text/background color combinations across popup, options
  page, and toast meet WCAG 2.1 AA contrast ratios (4.5:1 body, 3:1 large
  text), verifiable via automated contrast-checking tools.
- **SC-002**: The popup is fully operable via keyboard-only navigation
  (Tab/Shift+Tab, Enter/Space) with all interactive elements reachable and
  focusable, verifiable via manual testing.
- **SC-003**: An axe-core accessibility audit of the popup and options page
  produces zero critical or serious violations, verifiable via
  `@axe-core/playwright` or browser DevTools.
- **SC-004**: The skip toast is announced by screen readers (NVDA, VoiceOver)
  when it appears, verifiable via manual screen reader testing.
- **SC-005**: The design system theme is defined in a single shared module
  with no per-component inline color, font, or spacing overrides remaining
  in popup or options code, verifiable via code review.
- **SC-006**: Both light and dark modes render correctly with no invisible
  text, broken layouts, or contrast failures, verifiable via visual
  inspection at both OS color scheme settings.
- **SC-007**: The popup renders a stable layout within 100ms of opening (no
  layout shift from late-loading styles), verifiable by observing no visible
  flash of unstyled content.
- **SC-008**: The options page is fully usable at viewport widths of 320px,
  768px, and 1200px without horizontal scrolling or overlapping elements,
  verifiable via responsive testing.
- **SC-009**: No new runtime dependencies are added to the extension
  bundle (design system is implemented entirely via Mantine theming and
  minimal custom CSS), verifiable via `package.json` diff.
- **SC-010**: 100% of design system tokens (colors, fonts, spacing, radii)
  are documented in the design system reference file, verifiable via
  document review.
