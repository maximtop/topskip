# Feature Specification: Multi-Language Translation Support (20 Locales)

**Created**: 2026-04-15
**Status**: Validated
**Model**: claude-opus-4.6
**Input**: Translate the TopSkip extension to the 20 most popular languages, following the i18n patterns established in the AdGuard VPN browser extension.

## Assumptions

- **20 target languages**: The 20 most popular languages by global internet
  usage are: English (en, base), Chinese Simplified (zh_CN), Spanish (es),
  Hindi (hi), Arabic (ar), Portuguese Brazilian (pt_BR), French (fr),
  Japanese (ja), Russian (ru), German (de), Korean (ko), Italian (it),
  Turkish (tr), Vietnamese (vi), Polish (pl), Dutch (nl), Ukrainian (uk),
  Indonesian (id), Thai (th), and Chinese Traditional (zh_TW). English is
  already present as the base locale, so 19 new locale folders are created.
  Reasoning: based on global internet user populations and Chrome Web Store
  audience distribution.

- **VPN extension as the reference architecture**: The i18n infrastructure
  MUST follow the same patterns used in the AdGuard VPN extension — Chrome
  `_locales/<lang>/messages.json` format, `@adguard/translate` library,
  `translator` / `reactTranslator` singletons, `__MSG_*__` manifest fields,
  and TwoSky integration for translation management. Reasoning: the user
  explicitly requested this.

- **Placeholder syntax**: Message placeholders use `%name%` format (not the
  Chrome `$name$` substitution syntax), consistent with the VPN extension's
  `@adguard/translate` library conventions. Reasoning: matches the reference
  project.

- **No plural forms needed initially**: The current TopSkip UI has no strings
  requiring plural forms (no counts, quantities, or numeric variables).
  Plural support via pipe-separated forms is available through
  `reactTranslator.getPlural()` if needed later. Reasoning: inventory of
  current strings shows no pluralized content.

- **Initial translations are machine-generated or empty stubs**: The 19 new
  locale files will initially contain either machine-translated content or
  copies of the English base. Real translations will be provided later via
  the TwoSky translation platform. Reasoning: standard workflow — developers
  set up infrastructure, translators provide content.

- **Build pipeline update**: The Rspack build must be updated to copy
  `_locales/` into `dist/` so Chrome can load them. Reasoning: Chrome MV3
  requires `_locales/` at the extension root alongside `manifest.json`.

- **`@adguard/translate` is the i18n library**: This library is used (as in
  the VPN extension) rather than alternatives like `i18next` or
  `react-intl`. Reasoning: explicit user instruction to follow VPN extension
  patterns.

## User Scenarios & Testing

### User Story 1 — Extension Displays in User's Browser Language (Priority: P1)

A user installs TopSkip in a browser whose language is set to one of the 20
supported locales (e.g., French). When they open the popup, options page, or
see a toast on YouTube, all UI text appears in French. If the browser language
is not among the 20 supported locales, English is used as the fallback.

**Why this priority**: This is the core value proposition of the feature. Without
this, translations exist but are never displayed. The Chrome extension API
automatically selects the matching `_locales/<lang>/messages.json` for manifest
fields, and the runtime `TranslationService` resolves the browser locale to the
closest supported locale for in-app strings.

**Independent Test**: Set Chrome's language to `fr`, load the extension, open the
popup — all labels, status messages, and button text appear in French. Change
to an unsupported language (e.g., Swahili) — English appears.

**Acceptance Scenarios**:

1. **Given** the browser language is `fr`, **When** the user opens the popup,
   **Then** all popup strings (heading, toggle label, status messages, button
   text, alert content) are displayed in French.
2. **Given** the browser language is `ja`, **When** the user opens the options
   page, **Then** all labels, descriptions, headings, and error messages are
   displayed in Japanese.
3. **Given** the browser language is `sw` (unsupported), **When** the user
   opens the popup, **Then** all strings are displayed in English (base
   locale fallback).
4. **Given** the browser language is `zh-TW`, **When** the user views the
   extension in `chrome://extensions`, **Then** the extension name and
   description are displayed in Traditional Chinese (via `__MSG_*__` manifest
   fields).

---

### User Story 2 — All Hardcoded Strings Extracted to Message Keys (Priority: P1)

A developer opens the popup, options page, content script, and shared modules
and sees zero hardcoded English user-facing strings. Every string is referenced
via `translator.getMessage('key')` or `reactTranslator.getMessage('key', ...)`.
The English `messages.json` file contains all ~40+ message keys with their
English text and optional descriptions.

**Why this priority**: Without string extraction, there is nothing to translate.
This is a prerequisite for all other stories.

**Independent Test**: Search all `.ts` and `.tsx` source files for string
literals that appear in the UI. Verify that every user-facing string has a
corresponding key in `en/messages.json` and is accessed via the translator API.

**Acceptance Scenarios**:

1. **Given** the base locale file `src/_locales/en/messages.json` exists,
   **When** a developer inspects it, **Then** it contains a key for every
   user-facing string in `PopupApp.tsx`, `options.tsx`, `youtube-watch.ts`,
   `preferences-store.ts`, and `manifest.json`.
2. **Given** the popup component `PopupApp.tsx`, **When** a developer reads
   the source, **Then** no English string literals are used for UI labels —
   all use `translator.getMessage()` or `reactTranslator.getMessage()`.
3. **Given** the manifest file, **When** it is built, **Then** the `name`,
   `description`, and `action.default_title` fields use `__MSG_*__` pattern
   referencing keys in `messages.json`.

---

### User Story 3 — Manifest Fields Translated for Chrome Web Store (Priority: P2)

When the extension is listed on the Chrome Web Store, Chrome automatically
shows the localized extension name and description to users based on their
language. The manifest references `__MSG_name__`, `__MSG_short_name__`, and
`__MSG_description__` keys, and each locale's `messages.json` provides
translated values for these keys.

**Why this priority**: Store presence and first impressions matter for adoption,
but the extension is functional without translated manifest fields.

**Independent Test**: Build the extension, inspect `dist/manifest.json` — it
contains `__MSG_name__`, `__MSG_description__`, and `"default_locale": "en"`.
Inspect `dist/_locales/es/messages.json` — it contains `name`, `short_name`,
and `description` keys with Spanish text.

**Acceptance Scenarios**:

1. **Given** the built `dist/manifest.json`, **When** inspected, **Then** it
   contains `"default_locale": "en"` and uses `__MSG_*__` for name,
   short_name, and description.
2. **Given** a non-English locale file (e.g., `es/messages.json`), **When**
   inspected, **Then** it contains translated `name`, `short_name`, and
   `description` keys.

---

### User Story 4 — Translation Management Tooling (Priority: P2)

A developer can run CLI commands to upload the base English locale to TwoSky,
download translations from TwoSky, validate translation completeness, and
identify unused message keys. This matches the VPN extension's `pnpm locales`
workflow.

**Why this priority**: Without tooling, maintaining 20 locales is manual and
error-prone. However, the extension can ship with initial (stub) translations
before tooling is complete.

**Independent Test**: Run `pnpm locales download` — locale files are populated
from TwoSky. Run `pnpm locales validate` — report shows completeness
percentages. Run `pnpm locales info --unused` — lists any unreferenced keys.

**Acceptance Scenarios**:

1. **Given** the developer runs `pnpm locales upload`, **When** the command
   completes, **Then** the English `messages.json` is uploaded to the TwoSky
   project.
2. **Given** the developer runs `pnpm locales download`, **When** the command
   completes, **Then** all 20 locale `messages.json` files are updated from
   TwoSky.
3. **Given** the developer runs `pnpm locales validate`, **When** the command
   completes, **Then** a report shows translation completeness for each
   locale and flags structural errors (missing placeholders, etc.).

---

### User Story 5 — Content Script Toast in User's Language (Priority: P3)

When TopSkip applies a skip on YouTube, the brief toast notification ("Skip
applied") appears in the user's browser language.

**Why this priority**: The toast is a single short string. It is a small detail
that completes the experience but is low-impact compared to popup/options.

**Independent Test**: Set browser to `de`, trigger a promo skip on YouTube —
toast displays the German translation of "Skip applied".

**Acceptance Scenarios**:

1. **Given** the browser language is `de` and a promo block is detected,
   **When** TopSkip auto-skips, **Then** the toast text is displayed in
   German.
2. **Given** the browser language is `en`, **When** TopSkip auto-skips,
   **Then** the toast text is "Skip applied" (English).

---

### Edge Cases

- **What happens when a locale file is missing a key?** The translation
  service falls back to the English base locale value for that key.
- **What happens when a locale file is entirely missing?** Chrome falls back
  to the `default_locale` (English) for `__MSG_*__` manifest fields. The
  runtime `TranslationService` loads English as the fallback.
- **What happens with BCP 47 locale variants?** A browser set to `zh-Hans-CN`
  resolves to `zh_CN`; `pt-BR` resolves to `pt_BR`; `zh-Hant-TW` resolves
  to `zh_TW`. Unsupported sub-variants fall back to the base language or
  English.
- **What happens when `@adguard/translate` is not yet initialized?** Before
  `i18n.init()` completes, calls to `translator.getMessage()` fall through
  to `browser.i18n.getMessage()` (native Chrome API), which reads directly
  from `_locales/`. This ensures strings are never blank during startup.
- **What happens with RTL languages (Arabic, Hebrew)?** Arabic (`ar`) is
  included in the 20 locales. The Mantine UI framework supports RTL via its
  `direction` prop. The specification does not mandate full RTL layout
  support in this phase, but translated strings for RTL languages MUST
  display correctly. [NEEDS CLARIFICATION: Should full RTL layout support
  (mirrored UI) be included in scope, or is correct RTL text rendering
  sufficient?]
- **What happens when the content script injects a toast in a YouTube page
  that has a different language than the browser?** The toast uses the
  browser's language (from `browser.i18n`), not YouTube's page language.
  This is correct behavior — the toast is part of the extension, not YouTube.

## Requirements

### Functional Requirements

- **FR-001**: System MUST store translation files in `src/_locales/<lang>/messages.json`
  using the Chrome extension `messages.json` format (`{ "key": { "message": "...",
  "description": "..." } }`).

- **FR-002**: System MUST support exactly 20 locales: `en` (base), `zh_CN`,
  `es`, `hi`, `ar`, `pt_BR`, `fr`, `ja`, `ru`, `de`, `ko`, `it`, `tr`,
  `vi`, `pl`, `nl`, `uk`, `id`, `th`, `zh_TW`.

- **FR-003**: The `manifest.json` MUST include `"default_locale": "en"` and
  MUST use `__MSG_name__`, `__MSG_short_name__`, and `__MSG_description__`
  for the extension name, short name, and description fields.

- **FR-004**: The manifest `action.default_title` MUST use `__MSG_short_name__`
  (or a dedicated `__MSG_default_title__` key) so the toolbar tooltip is
  translated.

- **FR-005**: All user-facing strings in popup (`PopupApp.tsx`), options page
  (`options.tsx`), content script toast (`youtube-watch.ts`), and preferences
  error messages (`preferences-store.ts`) MUST be extracted to message keys
  and accessed via `translator.getMessage()` or
  `reactTranslator.getMessage()`.

- **FR-006**: The project MUST use `@adguard/translate` as the i18n library,
  providing `translator` (plain string) and `reactTranslator` (React/JSX)
  singletons, following the VPN extension pattern.

- **FR-007**: A runtime `TranslationService` MUST load the appropriate
  locale's `messages.json` on extension startup, with English fallback for
  missing keys.

- **FR-008**: The build pipeline (Rspack) MUST copy the `_locales/` directory
  into `dist/` so Chrome loads locale files at runtime.

- **FR-009**: The project MUST include a `.twosky.json` configuration file
  specifying the project ID, base locale (`en`), and the list of 20
  supported locales.

- **FR-010**: The project MUST include CLI tooling (`pnpm locales <command>`)
  for uploading base strings, downloading translations, validating
  completeness, and detecting unused keys, following the VPN extension's
  `tasks/translations/` pattern.

- **FR-011**: The base locale file (`en/messages.json`) MUST contain a
  `description` field for every key that includes context for translators
  (screen location, character limits where applicable).

- **FR-012**: Placeholders in messages MUST use `%name%` syntax consistent
  with `@adguard/translate` conventions.

- **FR-013**: System MUST fall back to `browser.i18n.getMessage()` (native
  Chrome API) when the `TranslationService` has not yet initialized, ensuring
  strings are never blank during startup.

- **FR-014**: Locale resolution MUST handle BCP 47 variants (e.g.,
  `zh-Hans-CN` → `zh_CN`, `pt-BR` → `pt_BR`), falling back to English for
  unrecognized locales.

- **FR-015**: The `en/messages.json` SHOULD include `"name"`, `"short_name"`,
  and `"description"` keys marked as persistent (protected from unused-string
  detection) since they are referenced only via `__MSG_*__` in the manifest.

### Key Entities

- **Message**: A translatable string unit identified by a unique key (e.g.,
  `popup_heading`). Contains a `message` field (the translated text) and an
  optional `description` field (translator context). Messages may contain
  `%placeholder%` tokens that are substituted at runtime.

- **Locale**: A language variant identified by a BCP 47-derived code (e.g.,
  `en`, `zh_CN`, `pt_BR`). Each locale has a `messages.json` file containing
  all message keys. One locale is designated as the base locale (`en`).

- **TranslationService**: A runtime component that loads locale files, caches
  them, and resolves message keys to translated strings. It determines the
  active locale from the browser's language setting and falls back to the
  base locale for missing keys.

- **Translator**: A facade that wraps the TranslationService and provides
  `getMessage(key, placeholders?)` for plain string output. Used in non-React
  contexts (background, content scripts).

- **ReactTranslator**: A facade that wraps the TranslationService and provides
  `getMessage(key, tags?)` for React JSX output, supporting inline tag
  substitution (e.g., `<b>`, `<a>`). Used in React components (popup,
  options).

## Success Criteria

### Measurable Outcomes

- **SC-001**: All ~40+ user-facing strings are extracted from source code into
  `en/messages.json` — zero hardcoded English string literals remain in UI
  components.

- **SC-002**: The extension loads and displays correctly in all 20 supported
  locales — popup, options page, content script toast, and manifest fields
  show locale-appropriate text.

- **SC-003**: Locale fallback works correctly — when the browser language is
  unsupported, all UI text appears in English; when a specific key is missing
  from a locale file, the English value is used for that key.

- **SC-004**: The built `dist/` directory contains `_locales/` with all 20
  locale folders, each containing a valid `messages.json`.

- **SC-005**: `pnpm locales validate` passes without errors for the base
  locale and reports completeness percentages for all locales.

- **SC-006**: No user-visible blank strings appear during extension startup
  (the `browser.i18n` fallback bridge ensures strings are available before
  `TranslationService` initializes).

- **SC-007**: Existing unit and E2E tests continue to pass after the i18n
  refactor — the translation layer does not break existing functionality.
