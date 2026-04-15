# Implementation Plan: Design System & UI Modernization

**Created**: 2026-04-15
**Status**: Validated
**Spec**: `design/spec.md`
**Model**: claude-opus-4.6

## Summary

Implement a cohesive design system for TopSkip by creating a shared Mantine
theme configuration, applying it to both the popup and options entry points,
refactoring the content-script toast for accessibility and design consistency,
and documenting all tokens. No new runtime dependencies are added.

## Selected UI Direction (2026-04-16)

The implementation will not follow the original "generic modernized Mantine"
approach only. It will combine the following approved directions:

- **Popup structure**: Quick Status Tap + Smart Context + Detection Timeline
- **Visual tone**: Clean Minimal + Notion-like restraint + Stripe-inspired
  settings polish
- **Options structure**: summary-first control room, not just vertically
  stacked form sections

This means the implementation work now includes:

- a dominant status card and clearer popup empty states
- a compact visual rendering of detected promo ranges
- calmer, editorial spacing and more deliberate surfaces
- an options page that surfaces current saved setup before deeper controls

## Technical Context

| Aspect | Value |
|--------|-------|
| **Language** | TypeScript 5.x strict, ESM |
| **UI framework** | Mantine 9.x, React 19, MobX 6 (popup only) |
| **Bundler** | Rspack (4 entries: background, content, popup, options) |
| **Path alias** | `@/*` → `src/*` |
| **Test runner** | Vitest 4.x (unit), Playwright (E2E) |
| **CSS strategy** | Mantine `createTheme()` + CSS variables; inline `<style>` in HTML for first-paint stability |
| **Convention** | Static-only classes as namespaces; JSDoc multi-line blocks; no Mantine in content/background bundles |

## Research

### Mantine 9 `createTheme()` API

- `primaryColor` (string): name of the default active color scale.
- `colors` (Record<string, MantineColorsTuple>): each value is a 10-element
  tuple of hex strings (shades 0-9).
- `autoContrast` (boolean): when `true`, Mantine auto-selects text color for
  sufficient contrast on filled components.
- `luminanceThreshold` (number): threshold for `autoContrast` (default 0.3).
- `fontFamily` (string): global font stack.
- `fontFamilyMonospace` (string): monospace font stack.
- `fontSizes` (Record<string, string>): keys `xs|sm|md|lg|xl`, values in `rem`.
- `lineHeights` (Record<string, string>): same keys.
- `spacing` (Record<string, string>): spacing scale, same keys.
- `radius` (Record<string, string>): border-radius scale, same keys.
- `defaultRadius` (string): default radius key.
- `respectReducedMotion` (boolean): disables transitions when OS prefers reduced
  motion.
- `focusRing` (`'auto'|'always'|'never'`): `'auto'` (default) shows focus ring
  only for keyboard navigation.
- `components` (Record<string, { defaultProps?, styles? }>): per-component
  defaults via `Component.extend({...})`.

### Color scales

Mantine requires 10 shades per color. Shade 6 is used for filled backgrounds in
light mode. Each shade must be a valid hex string.

### Content script constraint

Per AGENTS.md: "do NOT import Mantine into content/background bundles". The toast
in `youtube-watch.ts` must use raw CSS custom properties or inline styles — not
Mantine component imports. Design system tokens will be applied as hardcoded
values that match the theme, documented in the design system file.

### E2E selector stability

The E2E test at `e2e/extension.spec.ts:169` uses:

```ts
popupPage.getByRole('switch', { name: /enable/i })
```

The popup Switch must retain `role="switch"` and an accessible name matching
`/enable/i`. The current `aria-label="Enable auto-skip"` satisfies this.

## Entities

### ThemeConfig (NEW)

- **File**: `src/shared/theme.ts`
- **Type**: `Theme` (Mantine `createTheme()` return type)
- **Exports**: `topskipTheme` (the theme object)
- **Responsibility**: Single source of truth for all design tokens — colors,
  typography, spacing, radius, component defaults.
- **Used by**: `src/popup/popup.tsx`, `src/options/options.tsx`
- **Tested in**: `tests/shared/theme.test.ts`

### Popup (MODIFIED)

- **File**: `src/popup/popup.tsx`
- **Change**: Import `topskipTheme`, pass to `MantineProvider` `theme` prop.

### PopupApp (MODIFIED)

- **File**: `src/popup/PopupApp.tsx`
- **Change**: Replace the flat popup stack with a calm status-first layout,
  context-aware messaging, and a lightweight promo timeline while preserving
  the existing toggle and settings flow.

### Options (MODIFIED)

- **File**: `src/options/options.tsx`
- **Change**: Reframe the page as a summary-first control room with calmer
  section cards, a current setup overview, and more deliberate hierarchy for
  API key, model, and custom-model management.

### YoutubeWatch.showSkipToast (MODIFIED)

- **File**: `src/content/youtube-watch.ts`
- **Change**: Keep accessibility behavior but align the toast surface with the
  calmer editorial/Stripe-like visual language chosen for popup and options.

### PopupHTML (MODIFIED)

- **File**: `src/popup/index.html`
- **Change**: Update inline `<style>` to use the design system font stack.

### OptionsHTML (MODIFIED)

- **File**: `src/options/index.html`
- **Change**: Update inline `<style>` to use the design system font stack.

### DesignSystemDocs (NEW)

- **File**: `design/DESIGN_SYSTEM.md`
- **Responsibility**: Documents all tokens, usage guidelines, and accessibility
  requirements.

## Contracts

N/A — no new API boundaries, network endpoints, or message types are introduced.
All changes are within the existing UI rendering layer.

## File Structure

```
src/
├── shared/
│   └── theme.ts              # NEW — createTheme() config
├── popup/
│   ├── index.html            # MODIFY — font stack
│   ├── popup.tsx             # MODIFY — import theme
│   └── PopupApp.tsx          # MODIFY — ARIA live region, hierarchy
├── options/
│   ├── index.html            # MODIFY — font stack
│   └── options.tsx           # MODIFY — import theme, sections, alerts
└── content/
    └── youtube-watch.ts      # MODIFY — toast a11y + design tokens

tests/
└── shared/
    └── theme.test.ts         # NEW — theme validation tests

design/
├── spec.md                   # EXISTS — specification
├── plan.md                   # THIS FILE
└── DESIGN_SYSTEM.md          # NEW — token documentation
```

## Tasks

### Phase 1: Theme Foundation

#### Task 1.1 — Write theme unit tests (RED)

**File**: `tests/shared/theme.test.ts` (CREATE)

Create the test file that validates the theme object's structure and values.
These tests will fail until we create the theme module.

**Steps**:

1. Create `tests/shared/theme.test.ts` with the following content:

```ts
import { describe, expect, it } from 'vitest';

import { topskipTheme } from '@/shared/theme';

describe('topskipTheme', () => {
  it('exports a theme object', () => {
    expect(topskipTheme).toBeDefined();
    expect(typeof topskipTheme).toBe('object');
  });

  it('sets a custom primary color (not default blue)', () => {
    expect(topskipTheme.primaryColor).toBeDefined();
    expect(topskipTheme.primaryColor).not.toBe('blue');
  });

  it('defines the primary color scale with 10 shades', () => {
    const name = topskipTheme.primaryColor!;
    const scale = topskipTheme.colors?.[name];
    expect(scale).toBeDefined();
    expect(scale).toHaveLength(10);
    for (const shade of scale!) {
      expect(shade).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });

  it('defines semantic color scales (success, warning, error)', () => {
    for (const name of ['success', 'warning', 'error']) {
      const scale = topskipTheme.colors?.[name];
      expect(scale, `missing color scale: ${name}`).toBeDefined();
      expect(scale, `${name} must have 10 shades`).toHaveLength(10);
    }
  });

  it('uses a system font stack (no web fonts)', () => {
    expect(topskipTheme.fontFamily).toBeDefined();
    expect(topskipTheme.fontFamily).toContain('system-ui');
    expect(topskipTheme.fontFamily).not.toContain('Inter');
    expect(topskipTheme.fontFamily).not.toContain('Inter');
  });

  it('defines fontSizes with at least xs, sm, md, lg, xl', () => {
    const fs = topskipTheme.fontSizes;
    expect(fs).toBeDefined();
    for (const key of ['xs', 'sm', 'md', 'lg', 'xl']) {
      expect(fs?.[key], `missing fontSizes.${key}`).toBeDefined();
    }
  });

  it('defines lineHeights with at least xs, sm, md, lg, xl', () => {
    const lh = topskipTheme.lineHeights;
    expect(lh).toBeDefined();
    for (const key of ['xs', 'sm', 'md', 'lg', 'xl']) {
      expect(lh?.[key], `missing lineHeights.${key}`).toBeDefined();
    }
  });

  it('defines spacing scale', () => {
    const sp = topskipTheme.spacing;
    expect(sp).toBeDefined();
    for (const key of ['xs', 'sm', 'md', 'lg', 'xl']) {
      expect(sp?.[key], `missing spacing.${key}`).toBeDefined();
    }
  });

  it('defines radius scale and a default radius', () => {
    expect(topskipTheme.radius).toBeDefined();
    expect(topskipTheme.defaultRadius).toBeDefined();
  });

  it('enables autoContrast', () => {
    expect(topskipTheme.autoContrast).toBe(true);
  });

  it('enables respectReducedMotion', () => {
    expect(topskipTheme.respectReducedMotion).toBe(true);
  });

  it('defines component defaults for key components', () => {
    const comps = topskipTheme.components;
    expect(comps).toBeDefined();
    for (const name of [
      'Button',
      'TextInput',
      'Select',
      'Switch',
      'Checkbox',
      'Alert',
      'Text',
      'Stack',
    ]) {
      expect(comps?.[name], `missing component default: ${name}`).toBeDefined();
    }
  });
});
```

2. Run the tests and verify failure:

```bash
pnpm run test -- tests/shared/theme.test.ts
```

**Expected**: All tests fail with `Cannot find module '@/shared/theme'` (or
similar import error).

---

#### Task 1.2 — Create the shared theme module (GREEN)

**File**: `src/shared/theme.ts` (CREATE)

Create the theme configuration that satisfies all the tests from Task 1.1.

**Steps**:

1. Create `src/shared/theme.ts` with the following content:

```ts
import { createTheme, type MantineColorsTuple } from '@mantine/core';

/**
 * TopSkip brand teal — a clean, modern teal that conveys reliability and
 * tech-savviness without being Mantine's default blue.
 *
 * Shade 6 is the primary filled-background color in light mode.
 */
const brand: MantineColorsTuple = [
  '#e6fcf5',
  '#c3fae8',
  '#96f2d7',
  '#63e6be',
  '#38d9a9',
  '#20c997',
  '#12b886',
  '#0ca678',
  '#099268',
  '#087f5b',
];

/**
 * Success green (distinct from brand teal for semantic clarity).
 */
const success: MantineColorsTuple = [
  '#ebfbee',
  '#d3f9d8',
  '#b2f2bb',
  '#8ce99a',
  '#69db7c',
  '#51cf66',
  '#40c057',
  '#37b24d',
  '#2f9e44',
  '#2b8a3e',
];

/**
 * Warning amber.
 */
const warning: MantineColorsTuple = [
  '#fff9db',
  '#fff3bf',
  '#ffec99',
  '#ffe066',
  '#ffd43b',
  '#fcc419',
  '#fab005',
  '#f59f00',
  '#f08c00',
  '#e67700',
];

/**
 * Error red.
 */
const error: MantineColorsTuple = [
  '#fff5f5',
  '#ffe3e3',
  '#ffc9c9',
  '#ffa8a8',
  '#ff8787',
  '#ff6b6b',
  '#fa5252',
  '#f03e3e',
  '#e03131',
  '#c92a2a',
];

/**
 * Shared Mantine theme for popup and options entry points.
 *
 * This is the single source of truth for the TopSkip design system.
 * All color, typography, spacing, radius, and component defaults live here.
 */
export const topskipTheme = createTheme({
  primaryColor: 'brand',
  colors: {
    brand,
    success,
    warning,
    error,
  },

  autoContrast: true,
  luminanceThreshold: 0.3,

  fontFamily: [
    'system-ui',
    '-apple-system',
    '"Segoe UI"',
    'Roboto',
    'Helvetica',
    'Arial',
    'sans-serif',
    '"Apple Color Emoji"',
    '"Segoe UI Emoji"',
  ].join(', '),

  fontFamilyMonospace: [
    'ui-monospace',
    'SFMono-Regular',
    '"SF Mono"',
    'Menlo',
    'Consolas',
    '"Liberation Mono"',
    'monospace',
  ].join(', '),

  fontSizes: {
    xs: '0.6875rem',
    sm: '0.8125rem',
    md: '0.9375rem',
    lg: '1.0625rem',
    xl: '1.25rem',
  },

  lineHeights: {
    xs: '1.35',
    sm: '1.4',
    md: '1.5',
    lg: '1.55',
    xl: '1.6',
  },

  spacing: {
    xs: '0.375rem',
    sm: '0.625rem',
    md: '1rem',
    lg: '1.25rem',
    xl: '1.75rem',
  },

  radius: {
    xs: '0.125rem',
    sm: '0.25rem',
    md: '0.5rem',
    lg: '0.75rem',
    xl: '1rem',
  },
  defaultRadius: 'md',

  respectReducedMotion: true,

  components: {
    Button: {
      defaultProps: {
        radius: 'md',
      },
    },
    TextInput: {
      defaultProps: {
        radius: 'md',
      },
    },
    Select: {
      defaultProps: {
        radius: 'md',
      },
    },
    Switch: {
      defaultProps: {
        radius: 'xl',
      },
    },
    Checkbox: {
      defaultProps: {
        radius: 'sm',
      },
    },
    Alert: {
      defaultProps: {
        radius: 'md',
        variant: 'light',
      },
    },
    Text: {
      defaultProps: {
        size: 'sm',
      },
    },
    Stack: {
      defaultProps: {
        gap: 'md',
      },
    },
  },
});
```

2. Run the tests and verify they pass:

```bash
pnpm run test -- tests/shared/theme.test.ts
```

**Expected**: All tests pass (11 of 11).

3. Run the linter to confirm no style violations:

```bash
pnpm run lint
```

**Expected**: No new errors.

---

### Phase 2: Wire Theme to Entry Points

#### Task 2.1 — Apply theme to popup entry

**File**: `src/popup/popup.tsx` (MODIFY)

**Steps**:

1. Add the theme import and pass it to `MantineProvider`. Replace the full
   file content:

In `src/popup/popup.tsx`, add the import of `topskipTheme`:

```ts
import { topskipTheme } from '@/shared/theme';
```

Then change the `MantineProvider` to include the `theme` prop:

```tsx
<MantineProvider theme={topskipTheme} defaultColorScheme="auto">
```

The full file after edits:

```tsx
import '@mantine/core/styles.css';

import { MantineProvider } from '@mantine/core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { PopupApp } from './PopupApp';
import { topskipTheme } from '@/shared/theme';

/**
 * Popup bundle bootstrap; not instantiable.
 */
export class Popup {
  private constructor() {}

  /**
   * Mounts the React app under `#root`.
   */
  static init(): void {
    const rootEl = document.getElementById('root');
    if (!rootEl) {
      throw new Error('Missing #root');
    }

    createRoot(rootEl).render(
      <StrictMode>
        <MantineProvider theme={topskipTheme} defaultColorScheme="auto">
          <PopupApp />
        </MantineProvider>
      </StrictMode>,
    );
  }
}
```

2. Run lint + build to verify:

```bash
pnpm run lint && pnpm run build
```

**Expected**: No errors.

---

#### Task 2.2 — Apply theme to options entry

**File**: `src/options/options.tsx` (MODIFY)

**Steps**:

1. Add the theme import at the top of the file (after existing imports from
   `@/shared/`):

```ts
import { topskipTheme } from '@/shared/theme';
```

2. Change the `MantineProvider` in `Options.init()` (line 182) to include the
   `theme` prop:

```tsx
<MantineProvider theme={topskipTheme} defaultColorScheme="auto">
```

3. Run lint + build:

```bash
pnpm run lint && pnpm run build
```

**Expected**: No errors.

---

#### Task 2.3 — Run E2E tests to verify no regressions

**Steps**:

1. Run the full E2E suite:

```bash
pnpm run build && pnpm run test:e2e
```

**Expected**: All 3 E2E tests pass. The popup toggle E2E test
(`getByRole('switch', { name: /enable/i })`) still finds the switch because
the `aria-label="Enable auto-skip"` is unchanged.

---

### Phase 3: Popup Accessibility & Visual Hierarchy

#### Task 3.1 — Add ARIA live region and improve popup layout

**File**: `src/popup/PopupApp.tsx` (MODIFY)

This task addresses FR-009 (visual hierarchy), FR-018 (ARIA live region),
FR-020 (color not sole state indicator), and FR-025 (de-emphasized notice).

**Steps**:

1. Replace the `PopupApp` component's return JSX (lines 120–163) with an
   improved version that adds:
   - A branded header with the product name styled as a heading (`fw={700}`,
     `size="lg"`)
   - An ARIA live region (`aria-live="polite"`, `role="status"`) wrapping the
     detection status text
   - The reliability notice as a collapsible `details` element to de-emphasize
     it

Replace the return statement in `PopupApp` (the JSX from line 120 `return (`
through line 163 `);`) with:

```tsx
  return (
    <Stack gap="sm" p="md" maw={320}>
      <Text fw={700} size="lg">
        TopSkip
      </Text>
      <Group justify="space-between" wrap="nowrap" gap="md">
        <Text size="sm">Enable promo skip (YouTube)</Text>
        <Switch
          checked={store.enabled}
          onChange={(e) => {
            void store.setEnabled(e.currentTarget.checked);
          }}
          aria-label="Enable auto-skip"
        />
      </Group>
      <div role="status" aria-live="polite">
        {detectionLine ? (
          <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-line' }}>
            Active tab: {detectionLine}
          </Text>
        ) : null}
      </div>
      <Button
        variant="light"
        size="xs"
        onClick={() => {
          void browser.runtime.openOptionsPage();
        }}
      >
        Open settings (OpenRouter)
      </Button>
      <details>
        <summary
          style={{
            cursor: 'pointer',
            fontSize: 'var(--mantine-font-size-xs)',
            color: 'var(--mantine-color-dimmed)',
          }}
        >
          Reliability notice
        </summary>
        <Alert color="warning" title="Reliability notice" mt="xs">
          <Text size="xs">
            TopSkip may rely on parts of YouTube&apos;s site that are not a
            documented public API—the same general area the YouTube web client
            uses. There is no guarantee that auto-skip will keep working if
            YouTube changes how the page behaves.
          </Text>
          <Text size="xs" mt="xs">
            If it stops working, please report it where you installed this
            extension (for example the Chrome Web Store support options, if you
            installed it from there).
          </Text>
        </Alert>
      </details>
    </Stack>
  );
```

Note: The `Alert` now uses `color="warning"` (our semantic warning color) and
has no explicit `variant` (it inherits `variant="light"` from the theme's
component defaults).

2. Run lint + build:

```bash
pnpm run lint && pnpm run build
```

**Expected**: No errors.

3. Run E2E tests:

```bash
pnpm run test:e2e
```

**Expected**: All 3 tests pass. The switch still has `aria-label="Enable
auto-skip"` matching `/enable/i`.

---

### Phase 4: Options Page Improvements

#### Task 4.1 — Group options into sections with headings and styled messages

**File**: `src/options/options.tsx` (MODIFY)

This task addresses FR-010 (section grouping with headings), FR-022 (visible
labels), and improves success/error feedback with `Alert` components.

**Steps**:

1. Add `Alert` and `Title` to the Mantine imports at the top of the file.
   Replace the existing Mantine import block (lines 3-12):

```ts
import {
  Alert,
  Button,
  Checkbox,
  Group,
  MantineProvider,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
```

2. In the `OptionsApp` function, replace the return JSX (lines 375-487) with
   the following version that groups settings into sections, uses `Title`
   components for section headings, and replaces plain colored text with
   `Alert` components for success/error:

```tsx
  return (
    <Stack gap="lg" p="lg" maw={520}>
      <Stack gap="xs">
        <Title order={2} size="h4">
          TopSkip — LLM promo detection
        </Title>
        <Text size="sm" c="dimmed">
          Configure OpenRouter for transcript analysis. The API key is stored
          only in this browser profile (extension local storage).
        </Text>
      </Stack>

      <Stack gap="md">
        <Title order={3} size="h5">
          LLM Configuration
        </Title>
        <Checkbox
          label="Enable LLM promo detection"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.currentTarget.checked);
          }}
        />
        <TextInput
          label="OpenRouter API key"
          placeholder="sk-or-…"
          type="password"
          autoComplete="off"
          value={apiKey}
          onChange={(e) => {
            setApiKey(e.currentTarget.value);
          }}
          description={
            savedApiKeyMasked !== null
              ? `Saved key: ${savedApiKeyMasked} - leave blank to keep it.`
              : 'No key saved yet.'
          }
        />
      </Stack>

      <Stack gap="md">
        <Title order={3} size="h5">
          Model Selection
        </Title>
        <Select
          label="Model"
          description="Built-in presets and models you added below."
          data={modelSelectData}
          value={modelChoice}
          onChange={(v) => {
            setModelChoice(v ?? OPENROUTER_DEFAULT_MODEL_SLUG);
          }}
        />
      </Stack>

      <Stack gap="md">
        <Title order={3} size="h5">
          Custom Models
        </Title>
        <Text size="xs" c="dimmed">
          Type an OpenRouter model id (for example vendor/model), then Add to
          keep it for later sessions. This is not the same as Save below.
        </Text>
        <Group align="flex-end" wrap="nowrap" gap="sm">
          <TextInput
            style={{ flex: 1 }}
            label="Custom model id"
            placeholder="vendor/model"
            value={newModelDraft}
            onChange={(e) => {
              setNewModelDraft(e.currentTarget.value);
            }}
          />
          <Button
            loading={addBusy}
            disabled={newModelDraft.trim().length === 0}
            onClick={() => void onAddCustomModel()}
          >
            Add
          </Button>
        </Group>
        {customModels.length > 0 ? (
          <Stack gap="xs">
            <Text size="sm" fw={500}>
              Your added models
            </Text>
            {customModels.map((slug) => (
              <Group key={slug} justify="space-between" wrap="nowrap">
                <Text size="sm" ff="monospace">
                  {slug}
                </Text>
                <Button
                  size="xs"
                  variant="light"
                  color="error"
                  loading={removeBusySlug === slug}
                  disabled={
                    removeBusySlug !== null && removeBusySlug !== slug
                  }
                  onClick={() => void onRemoveCustomModel(slug)}
                >
                  Remove
                </Button>
              </Group>
            ))}
          </Stack>
        ) : null}
      </Stack>

      {error ? (
        <Alert color="error" variant="light" role="alert">
          {error}
        </Alert>
      ) : null}
      {saved ? (
        <Alert color="success" variant="light" role="status">
          Settings saved successfully.
        </Alert>
      ) : null}

      <Group>
        <Button loading={loading} onClick={() => void onSave()}>
          Save
        </Button>
        <Button variant="default" onClick={() => void load()}>
          Reload
        </Button>
      </Group>
      <Text size="xs" c="dimmed">
        Save applies the detection toggle, API key (if changed), and the
        selected model. Use Add to store extra model ids in your list.
      </Text>
    </Stack>
  );
```

3. Run lint + build:

```bash
pnpm run lint && pnpm run build
```

**Expected**: No errors.

---

### Phase 5: Toast Accessibility & Design Tokens

#### Task 5.1 — Refactor `showSkipToast` for accessibility

**File**: `src/content/youtube-watch.ts` (MODIFY)

This task addresses FR-019 (ARIA live region on toast), FR-021 (reduced motion),
and FR-026 (design system tokens instead of hardcoded inline styles).

**Important**: Per AGENTS.md, we must NOT import Mantine into the content bundle.
Design token values are hardcoded to match the theme but expressed as plain CSS.

**Steps**:

1. Replace the `showSkipToast` method (lines 89-118) with the following:

```ts
  /**
   * Brief on-screen confirmation after a skip seek is applied.
   *
   * Uses `role="status"` and `aria-live="polite"` so screen readers announce
   * the skip. Respects `prefers-reduced-motion` by skipping the fade-out
   * transition. Design token values (colors, radius, font) are aligned with
   * the shared theme but hardcoded here because the content bundle must not
   * import Mantine (see AGENTS.md).
   */
  private static showSkipToast(): void {
    const id = 'topskip-toast';
    let root = document.getElementById(id);
    if (!root) {
      root = document.createElement('div');
      root.id = id;
      root.setAttribute('role', 'status');
      root.setAttribute('aria-live', 'polite');
      root.style.cssText = [
        'position:fixed',
        'bottom:88px',
        'left:50%',
        'transform:translateX(-50%)',
        'z-index:10000',
        'background:rgba(0,0,0,0.85)',
        'color:#fff',
        'padding:0.625rem 1rem',
        'border-radius:0.5rem',
        'font:0.8125rem/1.4 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
        'pointer-events:none',
        'transition:opacity 200ms ease-out',
      ].join(';');
      document.documentElement.appendChild(root);
    }
    root.textContent = 'Skip applied';
    root.style.opacity = '1';

    const prefersReducedMotion = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches;

    window.setTimeout(() => {
      if (prefersReducedMotion) {
        root.style.opacity = '0';
        root.remove();
      } else {
        root.style.opacity = '0';
        window.setTimeout(() => {
          root.remove();
        }, 200);
      }
    }, 2500);
  }
```

Key changes from the original:
- Added `role="status"` and `aria-live="polite"` (FR-019)
- Added `prefers-reduced-motion` check — instant removal when enabled (FR-021)
- Token-aligned values: `padding:0.625rem 1rem` (spacing.sm + spacing.md),
  `border-radius:0.5rem` (radius.md), `font:0.8125rem/1.4` (fontSizes.sm /
  lineHeights.sm), system font stack matching theme (FR-026)
- Added `transition:opacity 200ms ease-out` for smoother fade (only applied
  when reduced motion is not active)

2. Run lint + build:

```bash
pnpm run lint && pnpm run build
```

**Expected**: No errors.

3. Run E2E tests to confirm no regressions:

```bash
pnpm run test:e2e
```

**Expected**: All 3 tests pass.

---

### Phase 6: HTML First-Paint Stability

#### Task 6.1 — Update popup and options HTML inline styles

**Files**: `src/popup/index.html`, `src/options/index.html` (MODIFY)

Align the inline `<style>` blocks with the theme's font stack. The existing
font stacks are already close but we add the complete system stack for
consistency.

**Steps**:

1. In `src/popup/index.html`, replace the `<style>` block (lines 12-28) with:

```html
    <style>
      html {
        min-width: 320px;
      }
      body {
        margin: 0;
        min-width: 320px;
        font-family:
          system-ui,
          -apple-system,
          'Segoe UI',
          Roboto,
          Helvetica,
          Arial,
          sans-serif,
          'Apple Color Emoji',
          'Segoe UI Emoji';
      }
      #root {
        min-width: 320px;
      }
    </style>
```

2. In `src/options/index.html`, replace the `<style>` block (lines 8-25) with
   the identical style block as above.

3. Run build:

```bash
pnpm run build
```

**Expected**: No errors.

---

### Phase 7: Design System Documentation

#### Task 7.1 — Create design system reference document

**File**: `design/DESIGN_SYSTEM.md` (CREATE)

This task addresses FR-027 and FR-028.

**Steps**:

1. Create `design/DESIGN_SYSTEM.md` with the following content:

```md
# TopSkip Design System

Reference document for the TopSkip design system. All tokens are defined in
`src/shared/theme.ts` and applied via Mantine's `createTheme()` API.

## Color Palette

### Brand (Primary)

The primary brand color is **teal** — a clean, modern color that conveys
reliability and technical competence. Used for primary buttons, active states,
and the primary accent across all surfaces.

| Shade | Hex | Usage |
|-------|-----|-------|
| 0 | `#e6fcf5` | Lightest tint (light backgrounds) |
| 1 | `#c3fae8` | Light hover states |
| 2 | `#96f2d7` | Light active states |
| 3 | `#63e6be` | Borders, decorative |
| 4 | `#38d9a9` | Secondary accent |
| 5 | `#20c997` | Hover on filled components |
| 6 | `#12b886` | **Primary filled** (buttons, switches) |
| 7 | `#0ca678` | Active on filled components |
| 8 | `#099268` | Emphasis |
| 9 | `#087f5b` | Darkest (text on light bg) |

### Semantic Colors

| Name | Shade 6 | Purpose |
|------|---------|---------|
| `success` | `#40c057` | Save confirmations, positive states |
| `warning` | `#fab005` | Reliability notices, caution states |
| `error` | `#fa5252` | Validation errors, destructive actions |

Each semantic color has a full 10-shade scale defined in the theme.

### Usage in Dark Mode

Mantine automatically adjusts shade usage in dark mode (lighter shades for
backgrounds, darker for text). The `autoContrast: true` setting ensures text
on filled components always has sufficient contrast.

## Typography

### Font Stack

```
system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif,
"Apple Color Emoji", "Segoe UI Emoji"
```

No web fonts are downloaded. The system font stack renders natively on every OS.

### Monospace Font Stack

```
ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono",
monospace
```

Used for model slugs and code-like content.

### Type Scale

| Level | Size | Line Height | CSS Variable |
|-------|------|-------------|-------------|
| `xs` (caption) | `0.6875rem` (11px) | 1.35 | `--mantine-font-size-xs` |
| `sm` (body) | `0.8125rem` (13px) | 1.4 | `--mantine-font-size-sm` |
| `md` (body+) | `0.9375rem` (15px) | 1.5 | `--mantine-font-size-md` |
| `lg` (subheading) | `1.0625rem` (17px) | 1.55 | `--mantine-font-size-lg` |
| `xl` (heading) | `1.25rem` (20px) | 1.6 | `--mantine-font-size-xl` |

## Spacing Scale

| Key | Value | CSS Variable |
|-----|-------|-------------|
| `xs` | `0.375rem` (6px) | `--mantine-spacing-xs` |
| `sm` | `0.625rem` (10px) | `--mantine-spacing-sm` |
| `md` | `1rem` (16px) | `--mantine-spacing-md` |
| `lg` | `1.25rem` (20px) | `--mantine-spacing-lg` |
| `xl` | `1.75rem` (28px) | `--mantine-spacing-xl` |

## Border Radius

| Key | Value | CSS Variable |
|-----|-------|-------------|
| `xs` | `0.125rem` (2px) | `--mantine-radius-xs` |
| `sm` | `0.25rem` (4px) | `--mantine-radius-sm` |
| `md` | `0.5rem` (8px) | `--mantine-radius-md` |
| `lg` | `0.75rem` (12px) | `--mantine-radius-lg` |
| `xl` | `1rem` (16px) | `--mantine-radius-xl` |

**Default radius**: `md` (`0.5rem` / 8px). All components use this unless
overridden.

## Component Defaults

These defaults are set in the theme so every instance gets consistent styling
without per-use props.

| Component | Default Props | Notes |
|-----------|--------------|-------|
| `Button` | `radius: 'md'` | Consistent rounded corners |
| `TextInput` | `radius: 'md'` | Matches button radius |
| `Select` | `radius: 'md'` | Matches input radius |
| `Switch` | `radius: 'xl'` | Pill-shaped toggle |
| `Checkbox` | `radius: 'sm'` | Slightly rounded square |
| `Alert` | `radius: 'md', variant: 'light'` | Light variant for notices |
| `Text` | `size: 'sm'` | Default body text size |
| `Stack` | `gap: 'md'` | Default vertical spacing |

## Accessibility

### Requirements

- **Contrast**: All text/background combinations must meet WCAG 2.1 AA (4.5:1
  for body text, 3:1 for large text and UI components). The `autoContrast`
  theme setting handles this automatically for filled components.
- **Focus indicators**: Mantine's `focusRing: 'auto'` (default) shows focus
  ring only on keyboard navigation. No custom override needed.
- **Reduced motion**: `respectReducedMotion: true` disables Mantine transitions
  when the user prefers reduced motion. The content-script toast also checks
  `prefers-reduced-motion` manually.
- **Color independence**: State (enabled/disabled, success/error) is always
  conveyed with text labels or icons, never color alone.

### ARIA Patterns

| Surface | Pattern | Purpose |
|---------|---------|---------|
| Popup detection status | `role="status"`, `aria-live="polite"` | Announces status changes to screen readers |
| Content-script toast | `role="status"`, `aria-live="polite"` | Announces skip events |
| Options error alert | `role="alert"` | Announces save errors |
| Options success alert | `role="status"` | Announces save success |
| Popup switch | `aria-label="Enable auto-skip"` | Descriptive label for toggle |

## Content-Script Toast Tokens

The content script (`src/content/youtube-watch.ts`) cannot import Mantine.
The toast uses hardcoded CSS values that align with the design system:

| Token | Theme Key | Toast Value |
|-------|-----------|-------------|
| Font family | `fontFamily` | `system-ui, -apple-system, "Segoe UI", ...` |
| Font size | `fontSizes.sm` | `0.8125rem` |
| Line height | `lineHeights.sm` | `1.4` |
| Padding | `spacing.sm` + `spacing.md` | `0.625rem 1rem` |
| Border radius | `radius.md` | `0.5rem` |
| Background | Custom | `rgba(0,0,0,0.85)` |
| Text color | Custom | `#fff` |

When updating the theme, these hardcoded values in the toast must be updated
manually to stay in sync.
```

2. Run markdownlint to verify:

```bash
pnpm exec markdownlint-cli2 design/DESIGN_SYSTEM.md
```

**Expected**: No errors (or only informational).

---

### Phase 8: Final Verification

#### Task 8.1 — Run full CI pipeline locally

**Steps**:

1. Run the full lint + build + test + E2E pipeline:

```bash
pnpm run lint && pnpm run build && pnpm run test && pnpm run test:e2e
```

**Expected**:
- Lint: 0 errors
- Build: success (4 entries)
- Unit tests: all pass (including new theme tests)
- E2E: all 3 tests pass

2. Verify no new dependencies were added:

```bash
git diff package.json
```

**Expected**: No changes to `dependencies` or `devDependencies` (SC-009).

---

## Requirement Traceability

| Requirement | Task(s) | Verification |
|-------------|---------|-------------|
| FR-001 (createTheme) | 1.2 | Theme tests pass |
| FR-002 (shared module) | 1.2, 2.1, 2.2 | Both entries import same module |
| FR-003 (custom colors, 10 shades) | 1.1, 1.2 | Theme tests verify 10-shade scales |
| FR-004 (component defaults) | 1.1, 1.2 | Theme tests verify component keys |
| FR-005 (typographic scale, 4+ levels) | 1.1, 1.2 | Theme tests verify fontSizes |
| FR-006 (system font stack) | 1.1, 1.2 | Theme tests verify no web fonts |
| FR-007 (line heights) | 1.1, 1.2 | Theme tests verify lineHeights |
| FR-008 (spacing scale) | 1.1, 1.2 | Theme tests verify spacing keys |
| FR-009 (popup visual hierarchy) | 3.1 | Manual inspection: header > toggle > status > actions > notice |
| FR-010 (options section grouping) | 4.1 | Title components with section headings |
| FR-011 (responsive options) | 4.1 | Mantine Stack/Group handle responsiveness; manual test at 320px/768px/1200px |
| FR-012 (brand color, not blue) | 1.1, 1.2 | Theme test verifies `primaryColor !== 'blue'` |
| FR-013 (semantic colors) | 1.1, 1.2 | Theme tests verify success, warning, error scales |
| FR-014 (WCAG AA contrast) | 1.2 | `autoContrast: true`; manual verification |
| FR-015 (defaultColorScheme auto) | 2.1, 2.2 | Both MantineProviders keep `defaultColorScheme="auto"` |
| FR-016 (keyboard navigation) | N/A | Mantine handles this by default; manual verification |
| FR-017 (focus indicators) | N/A | Mantine `focusRing: 'auto'` (default) |
| FR-018 (ARIA live on detection status) | 3.1 | `role="status"` + `aria-live="polite"` div |
| FR-019 (toast role/aria-live) | 5.1 | `role="status"` + `aria-live="polite"` on toast |
| FR-020 (color not sole indicator) | 3.1 | Text labels always present alongside color |
| FR-021 (reduced motion on toast) | 5.1 | `prefers-reduced-motion` check in toast |
| FR-022 (visible labels on inputs) | 4.1 | All TextInput/Select have `label` props |
| FR-023 (consistent button sizing) | 1.2 | Button default `radius: 'md'` in theme |
| FR-024 (consistent form controls) | 1.2 | TextInput/Select/Checkbox defaults in theme |
| FR-025 (de-emphasized notice) | 3.1 | Collapsible `<details>` element |
| FR-026 (toast uses design tokens) | 5.1 | Token-aligned CSS values documented |
| FR-027 (design system documentation) | 7.1 | `design/DESIGN_SYSTEM.md` |
| FR-028 (visual examples/token values) | 7.1 | Full token tables in documentation |
| SC-001 (WCAG AA contrast) | 1.2, 5.1 | `autoContrast: true`; toast contrast ratio ~14:1 |
| SC-002 (keyboard-only operation) | N/A | Mantine default; E2E test uses programmatic click |
| SC-003 (axe-core zero violations) | N/A | Manual axe-core audit recommended post-implementation |
| SC-004 (toast screen reader) | 5.1 | `role="status"` + `aria-live="polite"` |
| SC-005 (single shared theme) | 1.2, 2.1, 2.2 | Code review: one import, no inline overrides |
| SC-006 (light/dark mode) | 1.2 | `autoContrast: true`; manual verification |
| SC-007 (no layout shift) | 6.1 | Inline `<style>` matches theme font stack |
| SC-008 (responsive 320–1200px) | 4.1 | Stack/Group responsive; manual verification |
| SC-009 (no new dependencies) | 8.1 | `git diff package.json` shows no changes |
| SC-010 (100% tokens documented) | 7.1 | All colors, fonts, spacing, radii in doc |
