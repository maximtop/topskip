# TopSkip Design System

Reference document for the TopSkip design system. All tokens are defined in
`src/shared/theme.ts` and applied via Mantine's `createTheme()` API.

## Selected Product Expression

The design system is no longer aiming for a generic "modern extension" look.
The selected direction combines:

- **Clean Minimal** for low-noise structure and whitespace
- **Notion-like** restraint for editorial typography and understated borders
- **Stripe-inspired** polish for settings framing, summary cards, and action
  hierarchy

Interaction-wise, the popup should combine:

- **Quick Status Tap**: a dominant status/control card
- **Smart Context**: different content states when unsupported, unconfigured,
  idle, or actively detecting
- **Detection Timeline**: compact visual segmentation when promo blocks exist

This means TopSkip should feel trustworthy, crisp, and productized rather than
experimental, playful, or visually loud.

## Color Palette

### Brand (Primary)

The primary brand color is **teal** — a calm functional accent used sparingly
for primary actions, positive active states, and detection emphasis. Neutrals
and surface hierarchy should do most of the visual work.

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

```text
system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif,
"Apple Color Emoji", "Segoe UI Emoji"
```

No web fonts are downloaded. The system font stack renders natively on every OS.

### Monospace Font Stack

```text
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

**Default radius**: `md` (`0.5rem` / 8px). Interactive controls may use larger
rounding, but information containers should stay restrained rather than overly
soft.

## Surface Language

- Primary surfaces: white or near-white with subtle border separation
- Section cards: soft border, low shadow, no heavy glass or saturated fills
- Accent fills: reserved for primary status cards and primary CTA moments
- Informational notices: collapsed or secondary by default
- Status summaries: use small badges/chips plus plain-language copy

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

- **Contrast**: All text/background combinations must meet WCAG 2.1 AA
  (4.5:1 for body text, 3:1 for large text and UI components). The
  `autoContrast` theme setting handles this automatically for filled
  components.
- **Focus indicators**: Mantine's `focusRing: 'auto'` (default) shows focus
  ring only on keyboard navigation. No custom override needed.
- **Reduced motion**: `respectReducedMotion: true` disables Mantine
  transitions when the user prefers reduced motion. The content-script toast
  also checks `prefers-reduced-motion` manually.
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
