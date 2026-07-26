# Plan Check: Design System & UI Modernization

**Created**: 2026-04-15
**Reviewer**: claude-opus-4.6
**Reviewed**: `design/spec.md`, `design/plan.md`, `design/validation.md`,
`design/DESIGN_SYSTEM.md`, all modified source files, AGENTS.md

## Overall Assessment

The spec, plan, and implementation are **solid**. The design system is
well-structured, the TDD workflow was followed correctly, accessibility is
genuinely addressed (not just lip service), and the validation is thorough.
The teal brand identity is a good choice — distinct from Mantine's default
blue, and appropriate for a developer-facing tool.

That said, there are concrete improvements I'd make — both within the current
scope and as follow-ups.

## Issues Within Current Scope

### 1. Toast token sync is fragile (Medium)

The content script toast hardcodes CSS values that must manually match
`theme.ts`. The `DESIGN_SYSTEM.md` documents this ("must be updated manually")
but there's no enforcement.

**Recommendation**: Add a unit test in `theme.test.ts` that imports the known
toast token values (as constants exported from a small `toast-tokens.ts` file
or just as inline assertions) and asserts they match the corresponding theme
values. This catches drift at CI time instead of visual review.

```ts
// Example addition to theme.test.ts:
it('toast hardcoded tokens align with theme', () => {
  expect(topskipTheme.fontSizes?.sm).toBe('0.8125rem');
  expect(topskipTheme.lineHeights?.sm).toBe('1.4');
  expect(topskipTheme.spacing?.sm).toBe('0.625rem');
  expect(topskipTheme.spacing?.md).toBe('1rem');
  expect(topskipTheme.radius?.md).toBe('0.5rem');
});
```

### 2. SC-003 axe-core audit is PARTIAL (Low-Medium)

The validation notes it was "designated as post-implementation manual
verification" — but this is the one success criterion that isn't actually
verified. An `@axe-core/playwright` integration in the E2E suite would close
this gap permanently.

**Recommendation**: Add a single E2E test that opens the popup and options
page and runs `checkA11y()` from `@axe-core/playwright`. This is ~20 lines
of code and catches regressions automatically.

### 3. No React error boundary (Low)

Neither popup nor options wraps the app in an error boundary. A broken render
in the popup shows a blank white square with no recovery path.

**Recommendation**: Add a minimal `ErrorBoundary` component that shows a
"Something went wrong — reload" message. This is especially important for the
popup where the user can't see DevTools errors.

### 4. Options page: no API key "show/hide" toggle (Low)

The API key field is `type="password"` with no visibility toggle. Users can't
verify what they pasted, which causes subtle configuration errors.

### 5. Plan test contradiction noted but not fixed

The plan originally specified `not.toContain('Roboto')` but the theme includes
Roboto (as a system font fallback). The validation documents this deviation.
The implemented test uses `not.toContain('Inter')` which is correct — but the
plan text still contains the contradictory test code. The plan should be
patched for accuracy.

## Improvements Beyond Current Scope

### 6. No onboarding / first-run guidance (Medium)

A new user installs TopSkip and opens the popup. The toggle is there, but
there's no hint that they need to configure an OpenRouter API key for LLM
promo detection to work. The "Open settings (OpenRouter)" button is secondary.

**Recommendation**: When `status === 'not_configured'`, show a prominent
callout like: "Set up your OpenRouter API key to enable LLM promo detection"
with a direct link to the options page.

### 7. No connection / API key validation (Medium)

The options page saves the API key but gives no feedback on whether it's valid
until the user watches a video and detection fails. A "Test connection" button
that makes a lightweight OpenRouter API call (e.g., list models) would save
significant user frustration.

### 8. Popup doesn't show selected model (Low)

The popup shows detection status but not which model is active. For users who
switch between models, a small `ff="monospace" size="xs"` line showing the
current model slug would be helpful context.

### 9. No skip history / session stats (Low-Medium)

The toast disappears after 2.5s with no trace. Users have no way to see how
many promos were skipped, when, or in which video. A small badge on the
extension icon (e.g., "3") or a "Skips this session: 3" line in the popup
would provide useful feedback.

### 10. No visual regression testing (Low)

The design system is now well-defined, which is the perfect setup for
screenshot-based regression tests. Playwright supports `toHaveScreenshot()`
natively — one test per surface (popup light, popup dark, options light,
options dark) would catch visual regressions permanently.

### 11. Custom model input has no format validation (Low)

The "Custom model id" field accepts any string. A simple regex check for
`vendor/model` format (e.g., `/^[\w.-]+\/[\w.-]+$/`) would catch typos before
they're saved.

### 12. No loading skeleton in popup (Low)

While preferences load, the popup renders with default values and then snaps
to the actual state. A skeleton or brief loading indicator would prevent the
flash.

## Summary Table

| # | Issue | Severity | In-scope? | Effort |
|---|-------|----------|-----------|--------|
| 1 | Toast token drift test | Medium | Yes | Small |
| 2 | axe-core E2E audit | Low-Med | Yes | Small |
| 3 | React error boundary | Low | Yes | Small |
| 4 | API key show/hide | Low | Yes | Small |
| 5 | Plan text contradiction | Low | Yes | Trivial |
| 6 | First-run onboarding hint | Medium | Follow-up | Medium |
| 7 | API key validation button | Medium | Follow-up | Medium |
| 8 | Show active model in popup | Low | Follow-up | Small |
| 9 | Skip history / badge | Low-Med | Follow-up | Medium |
| 10 | Visual regression tests | Low | Follow-up | Medium |
| 11 | Custom model format check | Low | Follow-up | Small |
| 12 | Popup loading skeleton | Low | Follow-up | Small |

## Verdict

The design system work is well-executed. Items 1-5 are worth addressing now
(all small effort, all improve robustness). Items 6-12 are genuine product
improvements that should be separate features.
