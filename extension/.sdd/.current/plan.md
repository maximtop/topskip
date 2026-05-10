# Implementation Plan: TopSkip Popup and Options Redesign

**Created**: 2026-05-08
**Status**: Validated
**Input**: Feature specification from `.sdd/.current/spec.md`
**Model**: GitHub Copilot (model/version not exposed)
**User Input**: no additional constraints

## Summary

Redesign the TopSkip toolbar popup and options page to closely match the provided reference image while preserving existing behavior. The implementation should keep the current background-owned storage and runtime messaging flow, keep OpenRouter and Chrome Built-in provider behavior intact, and focus changes on React/Mantine presentation, accessibility, and responsive layout.

The safest approach is incremental TDD: add rendering tests for the new visual contract, update popup and options components, then add Playwright assertions for provider switching, popup status structure, accessibility, and responsive layout. No new extension permissions, network calls, or runtime dependencies are planned.

## Technical Context

**Language/Version**: TypeScript 6.0.2, strict, ESM.
**Primary Dependencies**: React 19.2.5, React DOM 19.2.5, Mantine 9.0.1, Mantine hooks 9.0.1, MobX 6.15.0, mobx-react-lite 4.1.1, webextension-polyfill 0.12.0, Valibot 1.3.1, XState 5.30.0 for Chrome model download flow.
**Storage**: `browser.storage.local` through background-only storage modules; popup/options use `browser.runtime.sendMessage` and `PREFS_PORT_NAME` port updates.
**Testing**: Vitest 4.1.4 for unit/server-render tests; Playwright 1.59.1 with Axe for extension e2e and accessibility.
**Target Platform**: Chrome Manifest V3 extension loaded from `dist/`.
**Project Type**: Single-package browser extension.
**Performance Goals**: Popup and options pages should render without visible layout jumps; UI updates for toggles/provider selection should reflect immediately after the existing message response. No new bundle-size-heavy dependencies.
**Constraints**: No new runtime dependencies unless explicitly approved. No direct storage access from popup/options. Use Mantine and existing `topskipTheme`. Keep content/background behavior unchanged. Follow repo TypeScript/JSDoc rules for new functions and class methods.
**Scale/Scope**: Two extension UI surfaces: fixed-size popup plus responsive options page.

## Research

### Existing UI Architecture

Popup is mounted by `src/popup/popup.tsx` and renders `src/popup/PopupApp.tsx`. It already owns `buildPopupViewModel`, polls `GET_DETECTION_STATUS`, listens for `PROMO_DETECTION_UPDATED`, and opens the options page through `browser.runtime.openOptionsPage()`.

Options are mounted by `src/options/options.tsx`. The current `OptionsApp` keeps local React state for settings, loads `GET_PREFS`, `GET_PROVIDER_LIST`, `GET_ACTIVE_PROVIDER`, and `GET_OPENROUTER_CONFIG`, persists provider changes through `SET_ACTIVE_PROVIDER`, and renders `OpenRouterConfigPanel` or `ChromeBuiltinInlineStatus` depending on provider.

Recommendation: keep data flow in place and replace layout/presentation. Do not introduce a new state manager for options in this feature.

### Mantine 9 Layout Guidance

Mantine components in use (`Box`, `Paper`, `Stack`, `Group`, `Button`, `Switch`, `Select`, `TextInput`, `Alert`, `Badge`) support responsive layout through style objects, `hiddenFrom`/`visibleFrom`, `wrap`, `flex`, and CSS media queries. Current project imports Mantine CSS once per popup/options entry and uses `topskipTheme` as the single design-system entry.

Recommendation: implement responsive shell with CSS grid/flex styles in React style props or local constants. Avoid card nesting for page sections where possible; use a single options shell plus bordered panels for actual controls.

Sources:

- Mantine layout docs: <https://mantine.dev/core/flex/>
- Mantine form controls: <https://mantine.dev/core/switch/>, <https://mantine.dev/core/select/>

### Chrome Extension UI Constraints

Extension popups have constrained viewport sizes and can close when focus leaves. The popup should not depend on horizontal scroll, expensive navigation, or hidden hover-only controls. Options pages are normal extension pages and can be tested by navigating to `chrome-extension://<id>/options.html`.

Recommendation: keep popup width fixed around the current 320px range, with stable section heights and readable text wrapping. Test options responsive behavior using Playwright viewport changes.

Sources:

- Chrome extension action popup docs: <https://developer.chrome.com/docs/extensions/reference/api/action>
- Playwright Chrome extension docs: <https://playwright.dev/docs/chrome-extensions>

### Accessibility and Regression Testing

Current e2e already runs Axe against popup and options with `color-contrast` disabled. Existing tests locate popup by a switch named `/enable/i` and options provider selector by `data-testid="provider-selector"`.

Recommendation: preserve these stable hooks, add new `data-testid` hooks for shell-level layout checks, and keep all switch/provider card controls as buttons/radios with accessible names.

## Entities

### Popup Status Summary

- **Fields**:
    - `tone`: `brand | success | warning | danger | neutral` - visual status tone from `buildPopupViewModel`.
    - `badgeLabel`: `string` - short status chip label.
    - `title`: `string` - primary popup status headline.
    - `description`: `string` - supporting status copy.
    - `statusHeadline`: `string` - current tab/detection status line.
    - `statusBody`: `string | null` - optional details.
    - `providerLabel`: `string` - active provider/model label.
- **Relationships**: Derived from `PreferencesStore` and `PromoDetectionStatePayload`.
- **Validation**: Must not display detected-block UI unless `status === 'detected'` and blocks exist.
- **States**: idle/not configured/unavailable/analyzing/detected/no promo/error/disabled.

### Promo Block Display Item

- **Fields**:
    - `startSec`: `number` - promo start in seconds.
    - `endSec`: `number | undefined` - promo end in seconds.
    - `durationSec`: `number` - derived display duration.
    - `timelineLeftPercent`: `number` - derived from start and video extent.
    - `timelineWidthPercent`: `number` - derived from duration and video extent.
- **Relationships**: Display projection of `PromoBlock` from `src/shared/promo-types.ts`.
- **Validation**: Missing or invalid end uses existing default fallback through `getPromoBlockEndSec`/`formatPromoBlocksSummary` behavior.
- **States**: none; derived display rows.

### Options Navigation Item

- **Fields**:
    - `id`: `general | detection | appearance | shortcuts | about`.
    - `label`: `string`.
    - `active`: `boolean`.
    - `enabled`: `boolean`.
    - `description`: `string` for placeholder/help state.
- **Relationships**: General controls existing settings. Other items are future-facing placeholders.
- **Validation**: Non-General sections must not mutate settings in this feature.
- **States**: active, inactive, placeholder.

### Provider Choice

- **Fields**:
    - `id`: provider id string from `PROVIDER_ID`.
    - `displayName`: `string`.
    - `availability`: `ProviderAvailabilityMessage`.
    - `selected`: `boolean`.
    - `description`: `string`.
- **Relationships**: Loaded from `GET_PROVIDER_LIST`; active id loaded from `GET_ACTIVE_PROVIDER` and persisted through `SET_ACTIVE_PROVIDER`.
- **Validation**: Provider card action must revert to previous provider on save failure.
- **States**: selected/unselected, available/unavailable/downloading/downloadable.

### OpenRouter Configuration

- **Fields**:
    - `apiKey`: `string` draft value.
    - `savedApiKeyMasked`: `string | null`.
    - `modelChoice`: `string`.
    - `modelSelectData`: `{ value: string; label: string }[]`.
    - `customModels`: `string[]`.
    - `newModelDraft`: `string`.
    - `validationError`: `string | null`.
    - `unverifiedModels`: `Set<string>`.
- **Relationships**: Existing options state and OpenRouter runtime messages.
- **Validation**: Saved key must stay masked; custom model slug validation must run before add.
- **States**: saved/unsaved, busy/error/unverified.

### Responsive Layout State

- **Fields**:
    - `viewportWidth`: `number`.
    - `navigationMode`: `sidebar | stacked`.
    - `providerGridColumns`: `1 | 2`.
- **Relationships**: CSS-only derivation from viewport.
- **Validation**: No horizontal scrolling at 360px, 768px, and 1024px options widths; popup no horizontal scrolling at popup viewport.
- **States**: desktop/tablet/narrow.

## Contracts

N/A - no HTTP API endpoints or external contracts required. The feature reuses existing extension runtime messages:

| Message | Direction | Purpose |
| --- | --- | --- |
| `TOPSKIP_GET_PREFS` | popup/options -> background | Load enabled/provider preference. |
| `TOPSKIP_SET_PREFS` | popup/options -> background | Save enabled state. |
| `TOPSKIP_GET_ACTIVE_PROVIDER` | popup/options -> background | Load active provider label/model. |
| `TOPSKIP_SET_ACTIVE_PROVIDER` | options -> background | Persist provider choice. |
| `TOPSKIP_GET_PROVIDER_LIST` | options -> background | Load provider cards. |
| `TOPSKIP_GET_OPENROUTER_CONFIG` | options -> background | Load masked key/model/custom models. |
| `TOPSKIP_SET_OPENROUTER_CONFIG` | options -> background | Save OpenRouter key/model. |
| `TOPSKIP_ADD_OPENROUTER_CUSTOM_MODEL` | options -> background | Add custom model slug. |
| `TOPSKIP_REMOVE_OPENROUTER_CUSTOM_MODEL` | options -> background | Remove custom model slug. |
| `TOPSKIP_VALIDATE_OPENROUTER_MODEL` | options -> background | Validate custom model slug before add. |
| `TOPSKIP_GET_DETECTION_STATUS` | popup -> background | Load current tab detection snapshot. |
| `TOPSKIP_PROMO_DETECTION_UPDATED` | background -> popup | Refresh popup detection snapshot. |

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/popup/PopupApp.tsx` | Modify | Restructure popup into reference-image sections while preserving `PreferencesStore`, detection polling, and `buildPopupViewModel`. |
| `tests/popup/popup-view-model.test.ts` | Modify | Add assertions for detected/no-promo/not-configured labels and provider copy that drive new popup sections. |
| `tests/popup/popup-render.test.tsx` | Create | Server-render popup presentation helpers or exported components for static structure checks. |
| `src/options/options.tsx` | Modify | Replace current stacked options page with responsive shell, sidebar, provider cards, General section, and placeholder section behavior. |
| `src/options/OpenRouterConfigPanel.tsx` | Modify | Rework OpenRouter panel to match screenshot: API key row, saved-key state, preset select, custom model list, compact actions. |
| `tests/options/provider-panels.test.ts` | Modify | Update server-render expectations for new provider cards, sidebar, OpenRouter settings, saved key, and custom model rows. |
| `e2e/extension-helpers.ts` | Modify | Keep popup wait helper stable and optionally add helper for options page readiness. |
| `e2e/extension.spec.ts` | Modify | Add popup/options visual contract checks and responsive viewport checks; preserve Axe audit. |
| `.sdd/.current/plan.md` | Create | This implementation plan. |

## Tasks

### [x] Task 1: Popup View-Model Contract

**Files:**

- Modify: `tests/popup/popup-view-model.test.ts`
- Modify: `src/popup/PopupApp.tsx`

- [x] **Step 1: Write the failing test**

Add these tests inside the existing `describe('buildPopupViewModel', () => { ... })` block in `tests/popup/popup-view-model.test.ts`:

```ts
it('detected state exposes block count title for compact popup summary', () => {
    const vm = buildPopupViewModel({
        ...baseArgs,
        detectionState: {
            videoId: 'v1',
            status: 'detected',
            promoBlocks: [
                { startSec: 92, endSec: 125 },
                { startSec: 490, endSec: 522 },
            ],
        },
    });

    expect(vm.badgeLabel).toBe('Detected');
    expect(vm.title).toBe('2 promo blocks found');
    expect(vm.statusHeadline).toBe('Detected windows');
    expect(vm.statusBody).toContain('1:32');
    expect(vm.statusBody).toContain('8:10');
});

it('no promo state remains positive without detected block wording', () => {
    const vm = buildPopupViewModel({
        ...baseArgs,
        detectionState: { videoId: 'v1', status: 'no_promo' },
    });

    expect(vm.tone).toBe('success');
    expect(vm.badgeLabel).toBe('Clear');
    expect(vm.title).toBe('Watching clean');
    expect(vm.statusHeadline).toBe('No promo blocks detected.');
});
```

- [x] **Step 2: Run test to verify it fails or documents current behavior**

Run:

```bash
pnpm exec vitest run tests/popup/popup-view-model.test.ts
```

Expected: PASS if current view-model already satisfies the contract, or FAIL with an assertion showing exact copy that needs to be preserved/adjusted.

- [x] **Step 3: Write minimal implementation**

If tests fail because copy differs, update only the matching `case 'detected'` or `case 'no_promo'` branch in `buildPopupViewModel` in `src/popup/PopupApp.tsx` so the returned fields match the test.

```ts
case 'detected': {
    const count = detectionState.promoBlocks?.length ?? 0;
    return {
        tone: 'brand',
        badgeLabel: 'Detected',
        badgeColor: 'brand',
        title: `${count} promo ${count === 1 ? 'block' : 'blocks'} found`,
        description:
            'TopSkip has marked the current sponsor windows for this video.',
        statusHeadline: 'Detected windows',
        statusBody:
            detectionState.promoBlocks !== undefined &&
            detectionState.promoBlocks.length > 0
                ? formatPromoBlocksSummary(detectionState.promoBlocks)
                : null,
        settingsLabel: 'Open settings',
        providerLabel,
    };
}
case 'no_promo':
    return {
        tone: 'success',
        badgeLabel: 'Clear',
        badgeColor: 'success',
        title: 'Watching clean',
        description: 'No sponsor segments were found in the current transcript window.',
        statusHeadline: 'No promo blocks detected.',
        statusBody: 'TopSkip will keep monitoring the video as captions update.',
        settingsLabel: 'Open settings',
        providerLabel,
    };
```

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm exec vitest run tests/popup/popup-view-model.test.ts
```

Expected: PASS.

**Verification**: View-model tests pass and no data-fetching logic changed.

### [x] Task 2: Popup Reference Layout E2E Test

**Files:**

- Modify: `e2e/extension.spec.ts`
- Modify: `src/popup/PopupApp.tsx`

- [x] **Step 1: Write the failing test**

Add this test before the existing Axe audit in `e2e/extension.spec.ts`:

```ts
test('popup renders reference layout sections', async () => {
    const errors: string[] = [];
    const context = await chromium.launchPersistentContext(
        '',
        extensionContextOptions(),
    );

    try {
        trackServiceWorkerConsoleErrors(context, errors);
        const extensionId = await getExtensionId(context);
        const popupPage = await openPopupAndWaitForUi(
            context,
            extensionId,
            errors,
        );

        await expect(popupPage.getByTestId('popup-shell')).toBeVisible();
        await expect(popupPage.getByTestId('popup-current-video')).toBeVisible();
        await expect(popupPage.getByTestId('popup-auto-skip')).toBeVisible();
        await expect(popupPage.getByTestId('popup-promo-blocks')).toBeVisible();
        await expect(
            popupPage.getByRole('button', { name: /open settings|open options/i }),
        ).toBeVisible();
        await expect(popupPage.getByText(/v0\.1\.0|version/i)).toBeVisible();

        const horizontalOverflow = await popupPage.evaluate(() => {
            return document.documentElement.scrollWidth > document.documentElement.clientWidth;
        });
        expect(horizontalOverflow).toBe(false);

        expectNoCollectedErrors(errors);
        await popupPage.close();
    } finally {
        await context.close();
    }
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm run build && pnpm exec playwright test e2e/extension.spec.ts -g "popup renders reference layout sections"
```

Expected: FAIL with missing `data-testid="popup-shell"` or missing version/footer text.

- [x] **Step 3: Write minimal implementation**

In `src/popup/PopupApp.tsx`, add the test ids to the existing popup structure first. Use this exact attribute mapping:

```tsx
<Stack data-testid="popup-shell" ...>
    <Paper data-testid="popup-current-video" ...>
        ...
    </Paper>
    <Paper data-testid="popup-auto-skip" ...>
        ...
    </Paper>
    <Paper data-testid="popup-promo-blocks" ...>
        ...
    </Paper>
    <Group data-testid="popup-footer" ...>
        ...
    </Group>
</Stack>
```

Then move the existing switch section out of the hero `Paper` into its own `Paper` so the high-level order is header/status, auto-skip, promo blocks, footer. Keep the existing switch handler unchanged:

```tsx
<Switch
    checked={store.enabled}
    onChange={(e) => {
        setPrefsError(null);
        void store.setEnabled(e.currentTarget.checked).catch((err: unknown) => {
            setPrefsError(getErrorMessage(err));
        });
    }}
    aria-label={translator.getMessage('popup_enable_auto_skip_aria')}
/>
```

Add footer text using the current package version shown in the reference image:

```tsx
<Text size="xs" c="dimmed">
    v0.1.0
</Text>
```

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm run build && pnpm exec playwright test e2e/extension.spec.ts -g "popup renders reference layout sections"
```

Expected: PASS.

**Verification**: Popup e2e finds all reference sections, no horizontal overflow, no collected console/page errors.

### [x] Task 3: Popup Visual Structure Implementation

**Files:**

- Modify: `src/popup/PopupApp.tsx`
- Test: `e2e/extension.spec.ts`

- [x] **Step 1: Write the failing test**

Extend the Task 2 e2e test with these assertions after `popup-promo-blocks` is visible:

```ts
await expect(popupPage.getByText(/auto-skip promo segments/i)).toBeVisible();
await expect(popupPage.getByText(/promo blocks detected/i)).toBeVisible();
await expect(popupPage.getByRole('switch', { name: /enable/i })).toBeVisible();
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm run build && pnpm exec playwright test e2e/extension.spec.ts -g "popup renders reference layout sections"
```

Expected: FAIL until visible copy matches the reference-oriented labels.

- [x] **Step 3: Write minimal implementation**

Update popup visible labels in `src/popup/PopupApp.tsx` to use this section structure. Preserve existing runtime behavior and switch handler.

```tsx
<Paper data-testid="popup-auto-skip" p="md" radius="md">
    <Group justify="space-between" wrap="nowrap" align="center" gap="md">
        <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
            <Text fw={700} size="sm">
                Auto-skip promo segments
            </Text>
            <Text size="xs" c="dimmed">
                Automatically skip detected sponsor & promo segments
            </Text>
            <Text size="xs" c={store.enabled ? 'brand' : 'dimmed'} fw={700}>
                {store.enabled ? 'ON' : 'OFF'}
            </Text>
        </Stack>
        <Switch
            checked={store.enabled}
            onChange={(e) => {
                setPrefsError(null);
                void store.setEnabled(e.currentTarget.checked).catch((err: unknown) => {
                    setPrefsError(getErrorMessage(err));
                });
            }}
            aria-label={translator.getMessage('popup_enable_auto_skip_aria')}
        />
    </Group>
</Paper>
```

Use this header for the promo block section:

```tsx
<Group justify="space-between" wrap="nowrap" gap="sm">
    <Group gap="xs" wrap="nowrap">
        <Text fw={700} size="sm">
            Promo blocks detected
        </Text>
    </Group>
    <Badge color="brand" variant="light">
        {`${detectedBlocks.length} ${detectedBlocks.length === 1 ? 'block' : 'blocks'}`}
    </Badge>
</Group>
```

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm run build && pnpm exec playwright test e2e/extension.spec.ts -g "popup renders reference layout sections"
```

Expected: PASS.

**Verification**: Popup has reference-oriented section labels and switch remains accessible.

### [x] Task 4: Promo Block Rows and Timeline Display

**Files:**

- Modify: `src/popup/PopupApp.tsx`
- Modify: `tests/popup/popup-view-model.test.ts`

- [x] **Step 1: Write the failing test**

Add this test to `tests/popup/popup-view-model.test.ts` to protect row time formatting through existing summary logic:

```ts
it('detected block summary formats exact start and end timecodes', () => {
    const vm = buildPopupViewModel({
        ...baseArgs,
        detectionState: {
            videoId: 'v1',
            status: 'detected',
            promoBlocks: [{ startSec: 92, endSec: 125 }],
        },
    });

    expect(vm.statusBody).toBe('1:32–2:05');
});
```

- [x] **Step 2: Run test to verify it fails or passes current formatter**

Run:

```bash
pnpm exec vitest run tests/popup/popup-view-model.test.ts
```

Expected: PASS if existing formatter is already correct. If FAIL, expected failure shows current formatting mismatch.

- [x] **Step 3: Write minimal implementation**

If needed, update only `formatPromoBlocksSummary` usage or `formatSecondsAsTimecode` in `src/shared/promo-range-format.ts`. Do not add duplicate time formatting in popup. Popup row rendering should call `formatSecondsAsTimecode(block.startSec)` and `formatSecondsAsTimecode(end)` from the existing shared formatter.

Add a local row map in `src/popup/PopupApp.tsx`:

```tsx
{detectedBlocks.map((block, index) => {
    const end = getPromoBlockEndSec(block);
    const duration = Math.max(0, end - block.startSec);
    return (
        <Group
            key={`${block.startSec}-${end}-${index}`}
            justify="space-between"
            wrap="nowrap"
            gap="sm"
        >
            <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                <Badge radius="xl" variant="filled" color="brand">
                    {index + 1}
                </Badge>
                <Text size="sm" fw={600} style={{ whiteSpace: 'nowrap' }}>
                    {`${formatSecondsAsTimecode(block.startSec)} - ${formatSecondsAsTimecode(end)}`}
                </Text>
            </Group>
            <Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
                {`${Math.round(duration)}s`}
            </Text>
        </Group>
    );
})}
```

- [x] **Step 4: Run tests to verify pass**

Run:

```bash
pnpm exec vitest run tests/popup/popup-view-model.test.ts
pnpm run build
```

Expected: PASS and build succeeds.

**Verification**: Popup uses existing shared time formatting and displays each detected block with index, range, and duration.

### [x] Task 5: Options Sidebar Render Test

**Files:**

- Modify: `tests/options/provider-panels.test.ts`
- Modify: `src/options/options.tsx`

- [x] **Step 1: Write the failing test**

Add this test to `tests/options/provider-panels.test.ts`:

```ts
import { OptionsSidebar } from '@/options/options';

describe('OptionsSidebar', () => {
    it('renders general as active and future sections as visible placeholders', () => {
        const html = renderWithMantine(
            createElement(OptionsSidebar, {
                activeSection: 'general',
                onSectionChange: () => {},
            }),
        );

        expect(html).toContain('TopSkip');
        expect(html).toContain('General');
        expect(html).toContain('Detection');
        expect(html).toContain('Appearance');
        expect(html).toContain('Shortcuts');
        expect(html).toContain('About');
        expect(html).toContain('aria-current="page"');
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm exec vitest run tests/options/provider-panels.test.ts
```

Expected: FAIL with missing export `OptionsSidebar` from `@/options/options`.

- [x] **Step 3: Write minimal implementation**

In `src/options/options.tsx`, export these types/constants near the other local types:

```ts
export type OptionsSectionId =
    | 'general'
    | 'detection'
    | 'appearance'
    | 'shortcuts'
    | 'about';

const OPTIONS_SECTIONS: { id: OptionsSectionId; label: string }[] = [
    { id: 'general', label: 'General' },
    { id: 'detection', label: 'Detection' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'shortcuts', label: 'Shortcuts' },
    { id: 'about', label: 'About' },
];
```

Then export this component from the same file:

```tsx
export function OptionsSidebar(props: {
    activeSection: OptionsSectionId;
    onSectionChange(sectionId: OptionsSectionId): void;
}): ReactElement {
    return (
        <Stack gap="xl" p="lg" data-testid="options-sidebar">
            <Group gap="sm" wrap="nowrap">
                <Text fw={800} size="lg">
                    TopSkip
                </Text>
            </Group>
            <Stack gap={4} component="nav" aria-label="Settings sections">
                {OPTIONS_SECTIONS.map((section) => {
                    const active = section.id === props.activeSection;
                    return (
                        <Button
                            key={section.id}
                            variant={active ? 'light' : 'subtle'}
                            justify="flex-start"
                            color={active ? 'brand' : 'slate'}
                            aria-current={active ? 'page' : undefined}
                            onClick={() => props.onSectionChange(section.id)}
                        >
                            {section.label}
                        </Button>
                    );
                })}
            </Stack>
        </Stack>
    );
}
```

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm exec vitest run tests/options/provider-panels.test.ts
```

Expected: PASS.

**Verification**: Sidebar section list exists and General has `aria-current="page"`.

### [x] Task 6: Options Shell Layout

**Files:**

- Modify: `src/options/options.tsx`
- Modify: `e2e/extension.spec.ts`

- [x] **Step 1: Write the failing test**

Add this e2e test before the provider switching test in `e2e/extension.spec.ts`:

```ts
test('options page renders redesigned shell', async () => {
    const errors: string[] = [];
    const context = await chromium.launchPersistentContext(
        '',
        extensionContextOptions(),
    );

    try {
        trackServiceWorkerConsoleErrors(context, errors);
        const extensionId = await getExtensionId(context);
        const page = await context.newPage();
        trackPageErrors(page, 'options', errors);
        await page.goto(`chrome-extension://${extensionId}/options.html`, {
            waitUntil: 'domcontentloaded',
        });

        await expect(page.getByTestId('options-shell')).toBeVisible();
        await expect(page.getByTestId('options-sidebar')).toBeVisible();
        await expect(page.getByRole('heading', { name: 'TopSkip Settings' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'General' })).toHaveAttribute(
            'aria-current',
            'page',
        );
        await expect(page.getByRole('button', { name: 'Detection' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Appearance' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'Shortcuts' })).toBeVisible();
        await expect(page.getByRole('button', { name: 'About' })).toBeVisible();

        expectNoCollectedErrors(errors);
    } finally {
        await context.close();
    }
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm run build && pnpm exec playwright test e2e/extension.spec.ts -g "options page renders redesigned shell"
```

Expected: FAIL with missing `options-shell` or missing `TopSkip Settings` heading.

- [x] **Step 3: Write minimal implementation**

In `OptionsApp` in `src/options/options.tsx`, add local section state:

```tsx
const [activeSection, setActiveSection] =
    useState<OptionsSectionId>('general');
```

Replace the outer `return` shell with this layout while moving the existing settings content into the `General` branch:

```tsx
return (
    <Box
        data-testid="options-shell"
        style={{
            minHeight: '100vh',
            background: '#f8fafc',
            color: 'var(--mantine-color-slate-9)',
        }}
    >
        <Box
            style={{
                display: 'grid',
                gridTemplateColumns: '220px minmax(0, 1fr)',
                maxWidth: '78rem',
                margin: '0 auto',
                minHeight: '100vh',
                background: '#fff',
                borderLeft: '1px solid var(--mantine-color-slate-2)',
                borderRight: '1px solid var(--mantine-color-slate-2)',
            }}
        >
            <Box style={{ borderRight: '1px solid var(--mantine-color-slate-2)' }}>
                <OptionsSidebar
                    activeSection={activeSection}
                    onSectionChange={setActiveSection}
                />
            </Box>
            <Box p="xl" style={{ minWidth: 0 }}>
                {activeSection === 'general' ? (
                    <GeneralSettingsContent />
                ) : (
                    <PlaceholderSettingsSection sectionId={activeSection} />
                )}
            </Box>
        </Box>
    </Box>
);
```

If extracting `GeneralSettingsContent` is too large for one edit, first keep the existing current content inline where `<GeneralSettingsContent />` appears, then extract in Task 7.

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm run build && pnpm exec playwright test e2e/extension.spec.ts -g "options page renders redesigned shell"
```

Expected: PASS.

**Verification**: Options page has shell/sidebar/main structure and General active state.

### [x] Task 7: Future Sidebar Placeholder Sections

**Files:**

- Modify: `tests/options/provider-panels.test.ts`
- Modify: `src/options/options.tsx`

- [x] **Step 1: Write the failing test**

Add this test to `tests/options/provider-panels.test.ts`:

```ts
import { PlaceholderSettingsSection } from '@/options/options';

describe('PlaceholderSettingsSection', () => {
    it('renders safe placeholder copy for Detection', () => {
        const html = renderWithMantine(
            createElement(PlaceholderSettingsSection, { sectionId: 'detection' }),
        );

        expect(html).toContain('Detection');
        expect(html).toContain('not configurable yet');
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm exec vitest run tests/options/provider-panels.test.ts
```

Expected: FAIL with missing export `PlaceholderSettingsSection`.

- [x] **Step 3: Write minimal implementation**

Add this exported component to `src/options/options.tsx`:

```tsx
export function PlaceholderSettingsSection(props: {
    sectionId: Exclude<OptionsSectionId, 'general'>;
}): ReactElement {
    const title = OPTIONS_SECTIONS.find((section) => section.id === props.sectionId)?.label ?? 'Settings';
    return (
        <Stack gap="md" maw={640} data-testid="options-placeholder-section">
            <Title order={2}>{title}</Title>
            <Alert color="slate" role="status">
                {`${title} settings are visible for navigation preview, but not configurable yet.`}
            </Alert>
        </Stack>
    );
}
```

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm exec vitest run tests/options/provider-panels.test.ts
```

Expected: PASS.

**Verification**: Future sidebar sections are visible but safe and non-mutating.

### [x] Task 8: Provider Card Selection Contract

**Files:**

- Modify: `tests/options/provider-panels.test.ts`
- Modify: `src/options/options.tsx`

- [x] **Step 1: Write the failing test**

Add this test to `tests/options/provider-panels.test.ts`:

```ts
import { ProviderChoiceCards } from '@/options/options';

describe('ProviderChoiceCards', () => {
    it('renders OpenRouter and Chrome provider cards with selected radio state', () => {
        const html = renderWithMantine(
            createElement(ProviderChoiceCards, {
                providers: [
                    { id: 'chrome-prompt-api', displayName: 'Chrome Built-in', availability: 'available' },
                    { id: 'openrouter', displayName: 'OpenRouter', availability: 'available' },
                ],
                activeProviderId: 'openrouter',
                onProviderChange: () => {},
            }),
        );

        expect(html).toContain('Chrome Built-in Prompt API');
        expect(html).toContain('OpenRouter BYOK');
        expect(html).toContain('Use Chrome');
        expect(html).toContain('Use OpenRouter');
        expect(html).toContain('aria-checked="true"');
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm exec vitest run tests/options/provider-panels.test.ts
```

Expected: FAIL with missing export `ProviderChoiceCards`.

- [x] **Step 3: Write minimal implementation**

Export this component from `src/options/options.tsx`:

```tsx
export function ProviderChoiceCards(props: {
    providers: ProviderListItem[];
    activeProviderId: string;
    onProviderChange(providerId: string): void;
}): ReactElement {
    return (
        <Group data-testid="provider-selector" role="radiogroup" gap="md" align="stretch" wrap="wrap">
            {props.providers.map((provider) => {
                const selected = provider.id === props.activeProviderId;
                const isOpenRouter = provider.id === PROVIDER_ID.OpenRouter;
                const title = isOpenRouter ? 'OpenRouter BYOK' : 'Chrome Built-in Prompt API';
                const description = isOpenRouter
                    ? 'Use OpenRouter with your own API key. Supports many leading models.'
                    : 'Use Chrome built-in on-device Prompt API. No external key required.';
                return (
                    <Paper
                        key={provider.id}
                        component="button"
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => props.onProviderChange(provider.id)}
                        p="md"
                        radius="md"
                        style={{
                            flex: '1 1 16rem',
                            textAlign: 'left',
                            border: selected
                                ? '2px solid var(--mantine-color-brand-6)'
                                : '1px solid var(--mantine-color-slate-2)',
                            background: selected ? '#f8fbff' : '#fff',
                            cursor: 'pointer',
                        }}
                    >
                        <Stack gap={4}>
                            <Text fw={700} size="sm">
                                {title}
                            </Text>
                            <Text size="xs" c="dimmed">
                                {description}
                            </Text>
                        </Stack>
                    </Paper>
                );
            })}
        </Group>
    );
}
```

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm exec vitest run tests/options/provider-panels.test.ts
```

Expected: PASS.

**Verification**: Provider selection is represented as accessible radio-card controls and keeps existing `provider-selector` test id.

### [x] Task 9: Integrate Provider Cards Into Options Page

**Files:**

- Modify: `src/options/options.tsx`
- Modify: `e2e/extension.spec.ts`

- [x] **Step 1: Write the failing test**

Update the existing `options page switches between provider panels` test in `e2e/extension.spec.ts` so provider selection clicks the new card/radio instead of segmented control text:

```ts
await page.getByTestId('provider-selector').waitFor();
await expect(page.getByText('OpenRouter BYOK')).toBeVisible();
await page.getByRole('radio', { name: /Chrome Built-in Prompt API/i }).click({ force: true });
await expect(page.getByText('not available').first()).toBeVisible();
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm run build && pnpm exec playwright test e2e/extension.spec.ts -g "options page switches between provider panels"
```

Expected: FAIL until `ProviderChoiceCards` is used in `OptionsApp`.

- [x] **Step 3: Write minimal implementation**

Replace the current `SegmentedControl` in `OptionsApp` with:

```tsx
<ProviderChoiceCards
    providers={providers}
    activeProviderId={activeProviderId}
    onProviderChange={(nextId) => {
        void onProviderChange(nextId);
    }}
/>
```

Remove the `SegmentedControl` import from `@mantine/core` if it is no longer used.

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm run build && pnpm exec playwright test e2e/extension.spec.ts -g "options page switches between provider panels"
```

Expected: PASS.

**Verification**: Provider card selection persists through existing handler and e2e still sees Chrome Built-in panel.

### [x] Task 10: OpenRouter Panel Reference Layout Test

**Files:**

- Modify: `tests/options/provider-panels.test.ts`
- Modify: `src/options/OpenRouterConfigPanel.tsx`

- [x] **Step 1: Write the failing test**

Update the existing `renders the OpenRouter panel with required props` test in `tests/options/provider-panels.test.ts` to pass a saved key and custom models:

```ts
it('renders the redesigned OpenRouter panel with key, preset, and custom models', () => {
    const html = renderWithMantine(
        createElement(OpenRouterConfigPanel, {
            apiKey: '',
            apiKeyVisible: false,
            savedApiKeyMasked: 'sk-or-...abcd',
            modelChoice: 'openai/gpt-4.1-mini',
            modelSelectData: [
                { value: 'openai/gpt-4.1-mini', label: 'openai/gpt-4.1-mini' },
                { value: 'meta-llama/llama-3.1-8b-instruct', label: 'meta-llama/llama-3.1-8b-instruct' },
            ],
            customModels: ['meta-llama/llama-3.1-8b-instruct'],
            newModelDraft: '',
            addBusy: false,
            removeBusySlug: null,
            validationError: null,
            unverifiedModels: new Set<string>(),
            onApiKeyChange: () => {},
            onToggleApiKeyVisibility: () => {},
            onModelChoiceChange: () => {},
            onNewModelDraftChange: () => {},
            onAddCustomModel: () => {},
            onRemoveCustomModel: () => {},
        }),
    );

    expect(html).toContain('OpenRouter BYOK settings');
    expect(html).toContain('Key saved');
    expect(html).toContain('Built-in model presets');
    expect(html).toContain('Custom OpenRouter models');
    expect(html).toContain('meta-llama/llama-3.1-8b-instruct');
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm exec vitest run tests/options/provider-panels.test.ts
```

Expected: FAIL with missing new headings/copy.

- [x] **Step 3: Write minimal implementation**

In `src/options/OpenRouterConfigPanel.tsx`, keep props unchanged and reorganize visible content. Use these exact headings and status text:

```tsx
<Paper p="md" radius="md" style={{ background: '#f8fbff', border: '1px solid var(--mantine-color-slate-2)' }}>
    <Stack gap="md">
        <Group justify="space-between" align="center" wrap="wrap" gap="sm">
            <Title order={3} size="h4">
                OpenRouter BYOK settings
            </Title>
            {props.savedApiKeyMasked !== null ? (
                <Badge color="success" variant="light">
                    Key saved
                </Badge>
            ) : (
                <Badge color="warning" variant="light">
                    Key missing
                </Badge>
            )}
        </Group>
        <TextInput
            label="OpenRouter API key"
            placeholder="sk-or-v1-..."
            type={props.apiKeyVisible ? 'text' : 'password'}
            autoComplete="off"
            value={props.apiKey}
            onChange={(event) => props.onApiKeyChange(event.currentTarget.value)}
            description="Your key is stored locally and never shared."
        />
        <Select
            label="Built-in model presets"
            data={props.modelSelectData}
            value={props.modelChoice}
            onChange={(value) => props.onModelChoiceChange(value)}
        />
    </Stack>
</Paper>
```

Add the custom model section heading below it:

```tsx
<Title order={3} size="h4">
    Custom OpenRouter models
</Title>
```

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm exec vitest run tests/options/provider-panels.test.ts
```

Expected: PASS.

**Verification**: OpenRouter panel exposes screenshot-aligned headings and saved-key badge without prop changes.

### [x] Task 11: Options Responsive E2E Test

**Files:**

- Modify: `e2e/extension.spec.ts`
- Modify: `src/options/options.tsx`

- [x] **Step 1: Write the failing test**

Add this test after the options shell test in `e2e/extension.spec.ts`:

```ts
test('options page has no horizontal overflow at supported widths', async () => {
    const errors: string[] = [];
    const context = await chromium.launchPersistentContext(
        '',
        extensionContextOptions(),
    );

    try {
        trackServiceWorkerConsoleErrors(context, errors);
        const extensionId = await getExtensionId(context);
        const page = await context.newPage();
        trackPageErrors(page, 'options', errors);

        for (const width of [360, 768, 1024]) {
            await page.setViewportSize({ width, height: 900 });
            await page.goto(`chrome-extension://${extensionId}/options.html`, {
                waitUntil: 'domcontentloaded',
            });
            await page.getByTestId('options-shell').waitFor({ state: 'visible' });
            const hasOverflow = await page.evaluate(() => {
                return document.documentElement.scrollWidth > document.documentElement.clientWidth;
            });
            expect(hasOverflow, `horizontal overflow at ${width}px`).toBe(false);
        }

        expectNoCollectedErrors(errors);
    } finally {
        await context.close();
    }
});
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm run build && pnpm exec playwright test e2e/extension.spec.ts -g "options page has no horizontal overflow"
```

Expected: FAIL at 360px until shell/sidebar stack responsively.

- [x] **Step 3: Write minimal implementation**

In `src/options/options.tsx`, change the shell grid style to use a media query via CSS class or inline `<style>` injected near the shell. Use a local style element because this bundle has no CSS module:

```tsx
<style>
    {`
        .topskip-options-frame {
            display: grid;
            grid-template-columns: 220px minmax(0, 1fr);
        }
        @media (max-width: 720px) {
            .topskip-options-frame {
                grid-template-columns: minmax(0, 1fr);
            }
            .topskip-options-sidebar {
                border-right: 0 !important;
                border-bottom: 1px solid var(--mantine-color-slate-2);
            }
        }
    `}
</style>
```

Apply classes:

```tsx
<Box className="topskip-options-frame" ...>
    <Box className="topskip-options-sidebar" ...>
        <OptionsSidebar ... />
    </Box>
    <Box p="xl" style={{ minWidth: 0 }}>
        ...
    </Box>
</Box>
```

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm run build && pnpm exec playwright test e2e/extension.spec.ts -g "options page has no horizontal overflow"
```

Expected: PASS.

**Verification**: Options page works at 360px, 768px, and 1024px without horizontal overflow.

### [x] Task 12: Popup Responsive Overflow Check

**Files:**

- Modify: `e2e/extension.spec.ts`
- Modify: `src/popup/PopupApp.tsx`

- [x] **Step 1: Write the failing test**

Extend `popup renders reference layout sections` with this check after shell visible:

```ts
await popupPage.setViewportSize({ width: 340, height: 700 });
const popupOverflow = await popupPage.evaluate(() => {
    return document.documentElement.scrollWidth > document.documentElement.clientWidth;
});
expect(popupOverflow).toBe(false);
```

- [x] **Step 2: Run test to verify it fails or confirms current layout**

Run:

```bash
pnpm run build && pnpm exec playwright test e2e/extension.spec.ts -g "popup renders reference layout sections"
```

Expected: PASS if popup already has no horizontal overflow; otherwise FAIL with overflow assertion.

- [x] **Step 3: Write minimal implementation**

If it fails, update the root popup container styles in `src/popup/PopupApp.tsx`:

```tsx
<Stack
    data-testid="popup-shell"
    gap={0}
    w={320}
    maw="100vw"
    style={{
        background: '#fff',
        overflowX: 'hidden',
        border: '1px solid var(--mantine-color-slate-2)',
    }}
>
```

For long model/provider text, add `minWidth: 0` and wrapping to the text container:

```tsx
<Text size="xs" c="dimmed" style={{ overflowWrap: 'anywhere' }}>
    {view.providerLabel}
</Text>
```

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm run build && pnpm exec playwright test e2e/extension.spec.ts -g "popup renders reference layout sections"
```

Expected: PASS.

**Verification**: Popup has no horizontal overflow at 340px viewport.

### [x] Task 13: Accessibility Audit Preservation

**Files:**

- Modify: `e2e/extension.spec.ts`
- Modify: `src/popup/PopupApp.tsx`
- Modify: `src/options/options.tsx`
- Modify: `src/options/OpenRouterConfigPanel.tsx`

- [x] **Step 1: Write the failing test**

Keep the existing test named `popup and options pages pass axe accessibility audit`. Add one keyboard check for provider cards inside it before the options Axe analysis:

```ts
await optionsPage.getByRole('radio', { name: /OpenRouter BYOK/i }).focus();
await expect(optionsPage.getByRole('radio', { name: /OpenRouter BYOK/i })).toBeFocused();
```

- [x] **Step 2: Run test to verify it fails if provider card focus is missing**

Run:

```bash
pnpm run build && pnpm exec playwright test e2e/extension.spec.ts -g "popup and options pages pass axe accessibility audit"
```

Expected: PASS if provider cards are focusable `button`/`radio` controls; otherwise FAIL on focus or Axe violation.

- [x] **Step 3: Write minimal implementation**

If Axe reports radio role naming issues, add explicit aria labels to provider cards:

```tsx
aria-label={title}
```

If future section buttons confuse screen readers, add disabled-state copy through visible placeholder instead of `disabled` buttons. Keep sidebar buttons enabled so users can read placeholder sections.

If switch labels fail, ensure both switches keep existing accessible names:

```tsx
aria-label={translator.getMessage('popup_enable_auto_skip_aria')}
```

and

```tsx
aria-label={translator.getMessage('options_enable_detection')}
```

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm run build && pnpm exec playwright test e2e/extension.spec.ts -g "popup and options pages pass axe accessibility audit"
```

Expected: PASS.

**Verification**: Axe audit remains green and keyboard focus reaches provider cards.

### [x] Task 14: Typecheck and Lint Cleanup

**Files:**

- Modify only files changed by prior tasks.

- [x] **Step 1: Run formatter**

Run:

```bash
pnpm run format
```

Expected: command exits 0 and formats changed TypeScript/Markdown files.

- [x] **Step 2: Run typecheck**

Run:

```bash
pnpm run lint:types
```

Expected: PASS. If it fails, fix only reported TypeScript errors in changed files.

- [x] **Step 3: Run source lint**

Run:

```bash
pnpm run lint:ox && pnpm run lint:eslint
```

Expected: PASS. Fix JSDoc, import, assertion, or React lint errors in changed files only.

- [x] **Step 4: Run markdown lint on SDD files**

Run:

```bash
pnpm exec markdownlint-cli2 .sdd/.current/spec.md .sdd/.current/plan.md
```

Expected: PASS.

**Verification**: Formatter, TypeScript, oxlint, ESLint, and Markdown checks pass.

### [x] Task 15: Full Test and Build Verification

**Files:**

- No code changes unless a verification command exposes a defect in changed files.

- [x] **Step 1: Run focused unit tests**

Run:

```bash
pnpm exec vitest run tests/popup/popup-view-model.test.ts tests/options/provider-panels.test.ts tests/popup/preferences-store.test.ts
```

Expected: PASS.

- [x] **Step 2: Run build**

Run:

```bash
pnpm run build
```

Expected: PASS and `dist/` contains updated `popup.js`, `options.js`, `popup.css`, and `options.css`.

- [x] **Step 3: Run focused e2e tests**

Run:

```bash
pnpm exec playwright test e2e/extension.spec.ts -g "popup renders reference layout sections|options page renders redesigned shell|options page switches between provider panels|options page has no horizontal overflow|popup and options pages pass axe accessibility audit"
```

Expected: PASS.

- [x] **Step 4: Run full local confidence suite**

Run:

```bash
pnpm run lint
pnpm run test
pnpm run test:coverage
pnpm run test:e2e
```

Expected: PASS. If Playwright browser dependencies are missing, run `pnpm exec playwright install chromium` once and rerun `pnpm run test:e2e`.

**Verification**: All project checks relevant to UI redesign pass.

## Spec Coverage Self-Review

| Spec Item | Covered By |
| --- | --- |
| Popup reference structure (FR-001) | Tasks 2, 3 |
| Popup detection state clarity (FR-002, FR-005) | Tasks 1, 2, 3, 4 |
| Popup auto-skip switch (FR-003) | Tasks 2, 3, 12, 13 |
| Promo blocks count/timeline/rows (FR-004) | Tasks 3, 4 |
| Open options action (FR-006) | Task 2 |
| Options sidebar shell (FR-007, FR-008) | Tasks 5, 6 |
| Future sidebar sections (FR-009) | Task 7 |
| Provider choice cards (FR-010, FR-011, FR-012, FR-013) | Tasks 8, 9, 13 |
| OpenRouter key/model/custom model management (FR-014 through FR-017) | Task 10 plus existing handlers preserved in `OptionsApp` |
| Storage/messaging boundaries (FR-018) | Tasks 2, 3, 9, 10 preserve existing handlers; no direct storage calls added |
| Responsive behavior (FR-019, FR-022) | Tasks 11, 12 |
| Keyboard/accessibility semantics (FR-020, FR-021) | Tasks 5, 8, 13 |
| Visual match without new permissions/network/data (FR-023, FR-024) | Tasks 3, 6, 8, 10, 14 |
| Regression tests (FR-025) | Tasks 1, 2, 5, 8, 10, 11, 12, 13, 15 |
| Success criteria SC-001 through SC-010 | Tasks 2 through 15 |

## Placeholder Scan

Placeholder keyword scan is clean. All code-oriented tasks include concrete snippets, exact paths, exact commands, and expected outcomes. Any implementation failure should be resolved in the named changed files only, preserving existing behavior outside popup/options UI.
