# Implementation Plan: Issue 4 — Provider messaging + options provider selector UI

**Created**: 2026-04-17
**Status**: Validated
**Issue**: `.sdd/.current/issues/4-provider-messaging-options-ui/issue.md`
**PRD**: `.sdd/.current/prd.md`
**Model**: GPT-5.4
**User Input**: None

## Summary

Complete the provider-selection vertical slice by finishing the background-facing provider list contract and refactoring the options page into a provider-aware layout. The current codebase already contains `GET_ACTIVE_PROVIDER`, `SET_ACTIVE_PROVIDER`, and `GET_PROVIDER_LIST` message types plus a `ProviderRuntimeMessages` handler, but the production registry still exposes only `openrouter`, and the options UI is still a single-file OpenRouter-only form. This issue adds a lightweight Chrome Built-in placeholder provider entry for selection and availability display, extracts provider-specific panels, wires the options page to provider messages, and adds focused tests plus one Playwright flow for the new selector.

## Technical Context

**Language/Version**: TypeScript 6.0.x strict, ESM
**Primary Dependencies**: React 19, Mantine 9, MobX 6, webextension-polyfill, Valibot
**Storage**: `browser.storage.local` via `PrefsSyncStorage` and `OpenRouterStorage` in the background only
**Testing**: Vitest 4.x for unit tests, Playwright for extension E2E
**Target Platform**: Chrome MV3 extension

## Research

### Provider message groundwork already exists

`src/shared/messages.ts` already defines `GET_ACTIVE_PROVIDER`, `SET_ACTIVE_PROVIDER`, and `GET_PROVIDER_LIST` response types. `src/background/messaging/provider-runtime-messages.ts` already handles those messages using an injected `ProviderRegistry`, and `src/background/messaging/register-runtime-messages.ts` already routes messages to that handler.

Recommendation: do not re-plan the message contract from scratch. Treat the current implementation as partial groundwork and add tests around it first so the remaining work is tightly scoped.

### The production registry still exposes only OpenRouter

`src/background/providers/default-registry.ts` currently registers only `new OpenRouterAdapter()`. That means `GET_PROVIDER_LIST` cannot yet satisfy Issue 4’s acceptance criterion requiring both `openrouter` and `chrome-prompt-api`.

Recommendation: for Issue 4, add a lightweight placeholder adapter entry for `chrome-prompt-api` that reports availability and a display name, but intentionally returns an error from `analyzeTranscript()`. Issue 6 can replace that placeholder with the real adapter without changing the options-page contract.

### Options UI is monolithic and OpenRouter-specific

`src/options/options.tsx` currently owns all state and rendering in one file. It fetches only `GET_PREFS` and `GET_OPENROUTER_CONFIG`, renders the master enabled switch, and shows only OpenRouter controls. There is no provider list fetch, no active provider fetch, no segmented control, and no conditional panel rendering.

Recommendation: extract presentational provider panels into separate files and keep the options page container responsible for loading provider list + active provider, top-level `enabled`, and wiring `SET_ACTIVE_PROVIDER`.

### No React component-test stack is installed

The repo does not use `@testing-library/react` or `jsdom`. Existing frontend tests are store-level, not DOM-level. Playwright is already set up for extension pages.

Recommendation: use two testing layers:

1. Vitest + `react-dom/server` `renderToStaticMarkup()` for small presentational TSX panels.
2. Playwright for the interactive provider selector flow in the options page.

### Existing patterns to follow

- Background messaging handlers use static-only classes and `unknown` message parsing with `Reflect.get()`.
- Popup/options pages talk to the background only via `browser.runtime.sendMessage` or `runtime.connect`.
- Tests mirror `src/**` under `tests/**` and prefer local mocks over broad integration wiring.
- `PrefsBroadcast.sendUpdatedToAllTabs()` and `PrefsPortHub.broadcastPrefsUpdate()` are already the expected fan-out path after a prefs write.

## Entities

### ProviderListItem

- **Fields**:
  - `id`: string - provider identifier sent to the options page
  - `displayName`: string - user-facing provider label
  - `availability`: `'available' | 'downloadable' | 'downloading' | 'unavailable'` - current provider state
- **Relationships**: Returned by `GET_PROVIDER_LIST`; sourced from `ProviderRegistry.getAll()`.
- **Validation**: `id` must be unique within the provider list.
- **States**: Mirrors provider availability; no local state machine beyond the enum.

### ActiveProviderSelection

- **Fields**:
  - `providerId`: string - persisted `prefs.providerId`
  - `displayName`: string - resolved from the registry for UI display
- **Relationships**: Returned by `GET_ACTIVE_PROVIDER`; updated by `SET_ACTIVE_PROVIDER`.
- **Validation**: `providerId` must resolve to a registered provider before save.
- **States**: `openrouter` ↔ `chrome-prompt-api` for this issue.

### ChromeBuiltinPlaceholderProvider

- **Fields**:
  - `id`: `'chrome-prompt-api'`
  - `displayName`: `'Chrome Built-in'`
- **Relationships**: Registered in `defaultRegistry` so options/background can enumerate it before the real adapter exists.
- **Validation**: Must implement `LlmProviderAdapter` and return a non-throwing availability value.
- **States**: For this issue, `availability()` returns `'unavailable'` until Issue 6 replaces the placeholder with the real adapter.

## Contracts

N/A — no API endpoints required. This issue uses existing runtime message contracts in `src/shared/messages.ts`.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/background/providers/chrome-builtin-placeholder-adapter.ts` | Create | Lightweight provider entry for `chrome-prompt-api` until Issue 6 ships the real adapter |
| `src/background/providers/default-registry.ts` | Modify | Register the placeholder provider alongside OpenRouter |
| `src/background/messaging/provider-runtime-messages.ts` | Modify | Adjust message handling only if tests expose gaps in list/active/set behavior |
| `src/options/OpenRouterConfigPanel.tsx` | Create | Extract the existing OpenRouter form UI into a reusable presentational component |
| `src/options/ChromeBuiltinPanel.tsx` | Create | Placeholder provider panel showing availability status text and next-step copy |
| `src/options/options.tsx` | Modify | Load provider list + active provider, render segmented control, keep enabled switch top-level, and switch between provider panels |
| `tests/background/providers/default-registry.test.ts` | Create | Verify the production registry now exposes both provider IDs |
| `tests/background/messaging/provider-runtime-messages.test.ts` | Create | Verify `GET_PROVIDER_LIST`, `GET_ACTIVE_PROVIDER`, and `SET_ACTIVE_PROVIDER` semantics |
| `tests/options/provider-panels.test.tsx` | Create | Static-render tests for the extracted provider panels |
| `e2e/extension.spec.ts` | Modify | Add provider-selector coverage for the options page without regressing existing flows |

## Tasks

### [ ] Task 1: Register a Chrome Built-in placeholder provider

**Files:**
- Create: `src/background/providers/chrome-builtin-placeholder-adapter.ts`
- Modify: `src/background/providers/default-registry.ts`
- Test: `tests/background/providers/default-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it } from 'vitest';

import { defaultRegistry } from '@/background/providers/default-registry';

describe('defaultRegistry', () => {
  it('registers both selectable providers for the options UI', () => {
    const ids = defaultRegistry.getAll().map((adapter) => adapter.id).sort();
    expect(ids).toEqual(['chrome-prompt-api', 'openrouter']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run test -- tests/background/providers/default-registry.test.ts`
Expected: FAIL because `defaultRegistry` currently returns only `['openrouter']`

- [ ] **Step 3: Write minimal implementation**

```typescript
import {
  PROVIDER_AVAILABILITY,
  PROVIDER_ID,
  type AnalyzeTranscriptParams,
  type AnalyzeTranscriptResult,
  type LlmProviderAdapter,
  type ProviderAvailability,
} from '@/background/providers/llm-provider-adapter';

export class ChromeBuiltinPlaceholderAdapter implements LlmProviderAdapter {
  readonly id = PROVIDER_ID.ChromePromptApi;

  readonly displayName = 'Chrome Built-in';

  async availability(): Promise<ProviderAvailability> {
    return PROVIDER_AVAILABILITY.Unavailable;
  }

  async analyzeTranscript(
    _params: AnalyzeTranscriptParams,
  ): Promise<AnalyzeTranscriptResult> {
    return {
      ok: false,
      error: 'Chrome Built-in is not available yet',
    };
  }
}
```

Then register it in `default-registry.ts`:

```typescript
export const defaultRegistry = new ProviderRegistry([
  new OpenRouterAdapter(),
  new ChromeBuiltinPlaceholderAdapter(),
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm run test -- tests/background/providers/default-registry.test.ts`
Expected: PASS

**Verification**: `defaultRegistry.getAll()` returns both `openrouter` and `chrome-prompt-api` in production code.

### [ ] Task 2: Add provider runtime message coverage

**Files:**
- Test: `tests/background/messaging/provider-runtime-messages.test.ts`
- Modify: `src/background/messaging/provider-runtime-messages.ts` (only if tests expose gaps)

- [ ] **Step 1: Write the failing tests**

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderRuntimeMessages } from
  '@/background/messaging/provider-runtime-messages';
import { ProviderRegistry } from
  '@/background/providers/provider-registry';
import { TOPSKIP_MESSAGE } from '@/shared/messages';

const loadMock = vi.fn();
const saveMock = vi.fn();
const sendUpdatedToAllTabsMock = vi.fn();
const broadcastPrefsUpdateMock = vi.fn();

vi.mock('@/background/storage/prefs-sync', () => ({
  PrefsSyncStorage: {
    ready: vi.fn().mockResolvedValue(undefined),
    load: () => loadMock(),
    save: (prefs: unknown) => saveMock(prefs),
  },
}));

vi.mock('@/background/messaging/broadcast-prefs-updated', () => ({
  PrefsBroadcast: {
    sendUpdatedToAllTabs: (prefs: unknown) => sendUpdatedToAllTabsMock(prefs),
  },
}));

vi.mock('@/background/messaging/prefs-port-hub', () => ({
  PrefsPortHub: {
    broadcastPrefsUpdate: (prefs: unknown) => broadcastPrefsUpdateMock(prefs),
  },
}));

describe('ProviderRuntimeMessages', () => {
  beforeEach(() => {
    loadMock.mockReset();
    saveMock.mockReset();
    sendUpdatedToAllTabsMock.mockReset();
    broadcastPrefsUpdateMock.mockReset();

    ProviderRuntimeMessages.setRegistry(new ProviderRegistry([
      {
        id: 'openrouter',
        displayName: 'OpenRouter',
        availability: async () => 'available',
        analyzeTranscript: async () => ({
          ok: false,
          error: 'unused',
        }),
      },
      {
        id: 'chrome-prompt-api',
        displayName: 'Chrome Built-in',
        availability: async () => 'unavailable',
        analyzeTranscript: async () => ({
          ok: false,
          error: 'unused',
        }),
      },
    ]));
  });

  it('GET_PROVIDER_LIST returns both providers with availability', async () => {
    const res = await ProviderRuntimeMessages.handle(
      { type: TOPSKIP_MESSAGE.GET_PROVIDER_LIST },
      {} as never,
    );
    expect(res).toEqual({
      ok: true,
      providers: [
        {
          id: 'openrouter',
          displayName: 'OpenRouter',
          availability: 'available',
        },
        {
          id: 'chrome-prompt-api',
          displayName: 'Chrome Built-in',
          availability: 'unavailable',
        },
      ],
    });
  });

  it('GET_ACTIVE_PROVIDER returns providerId and displayName', async () => {
    loadMock.mockResolvedValue({ enabled: true, providerId: 'openrouter' });
    const res = await ProviderRuntimeMessages.handle(
      { type: TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER },
      {} as never,
    );
    expect(res).toEqual({
      ok: true,
      providerId: 'openrouter',
      displayName: 'OpenRouter',
    });
  });

  it('SET_ACTIVE_PROVIDER writes prefs and returns ok', async () => {
    loadMock.mockResolvedValue({ enabled: true, providerId: 'openrouter' });
    saveMock.mockResolvedValue(undefined);
    sendUpdatedToAllTabsMock.mockResolvedValue(undefined);

    const res = await ProviderRuntimeMessages.handle(
      {
        type: TOPSKIP_MESSAGE.SET_ACTIVE_PROVIDER,
        providerId: 'chrome-prompt-api',
      },
      {} as never,
    );

    expect(res).toEqual({ ok: true });
    expect(saveMock).toHaveBeenCalledWith({
      enabled: true,
      providerId: 'chrome-prompt-api',
    });
  });

  it('SET_ACTIVE_PROVIDER rejects an unknown provider id', async () => {
    const res = await ProviderRuntimeMessages.handle(
      {
        type: TOPSKIP_MESSAGE.SET_ACTIVE_PROVIDER,
        providerId: 'does-not-exist',
      },
      {} as never,
    );

    expect(res).toEqual({
      ok: false,
      error: 'Unknown provider: does-not-exist',
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run test -- tests/background/messaging/provider-runtime-messages.test.ts`
Expected: If the handler contract is incomplete, FAIL with a mismatched response shape or missing prefs write/broadcast assertion. If it already passes, keep the test as regression coverage and move to Step 3 with no production changes.

- [ ] **Step 3: Write minimal implementation**

Adjust `provider-runtime-messages.ts` only where needed so that:

```typescript
return {
  ok: true,
  providerId: prefs.providerId,
  displayName: adapter?.displayName ?? prefs.providerId,
};
```

and:

```typescript
const providers = await Promise.all(
  ProviderRuntimeMessages.registry.getAll().map(async (adapter) => ({
    id: adapter.id,
    displayName: adapter.displayName,
    availability: await adapter.availability(),
  })),
);
return { ok: true, providers };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm run test -- tests/background/messaging/provider-runtime-messages.test.ts`
Expected: PASS

**Verification**: Background messaging now fully covers `GET_PROVIDER_LIST`, `GET_ACTIVE_PROVIDER`, and both valid/invalid `SET_ACTIVE_PROVIDER` flows.

### [ ] Task 3: Extract provider-specific options panels

**Files:**
- Create: `src/options/OpenRouterConfigPanel.tsx`
- Create: `src/options/ChromeBuiltinPanel.tsx`
- Test: `tests/options/provider-panels.test.tsx`

- [ ] **Step 1: Write the failing tests**

```tsx
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

import { ChromeBuiltinPanel } from '@/options/ChromeBuiltinPanel';
import { OpenRouterConfigPanel } from '@/options/OpenRouterConfigPanel';

describe('provider panels', () => {
  it('renders the extracted OpenRouter controls', () => {
    const html = renderToStaticMarkup(
      <OpenRouterConfigPanel
        apiKey=""
        apiKeyVisible={false}
        savedApiKeyMasked={null}
        modelChoice="google/gemini-2.5-flash-lite"
        modelSelectData={[
          {
            value: 'google/gemini-2.5-flash-lite',
            label: 'google/gemini-2.5-flash-lite',
          },
        ]}
        customModels={[]}
        newModelDraft=""
        addBusy={false}
        removeBusySlug={null}
        onApiKeyChange={() => {}}
        onToggleApiKeyVisibility={() => {}}
        onModelChoiceChange={() => {}}
        onNewModelDraftChange={() => {}}
        onAddCustomModel={() => {}}
        onRemoveCustomModel={() => {}}
      />,
    );

    expect(html).toContain('Custom models');
    expect(html).toContain('Secure connection');
  });

  it('renders the Chrome Built-in placeholder copy', () => {
    const html = renderToStaticMarkup(
      <ChromeBuiltinPanel availability="unavailable" />,
    );

    expect(html).toContain('Chrome Built-in');
    expect(html).toContain('Coming soon');
    expect(html).toContain('unavailable');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run test -- tests/options/provider-panels.test.tsx`
Expected: FAIL because the panel components do not exist yet

- [ ] **Step 3: Write minimal implementation**

Extract the current OpenRouter sections from `options.tsx` into a presentational component:

```tsx
export function OpenRouterConfigPanel(props: {
  apiKey: string;
  apiKeyVisible: boolean;
  savedApiKeyMasked: string | null;
  modelChoice: string;
  modelSelectData: { value: string; label: string }[];
  customModels: string[];
  newModelDraft: string;
  addBusy: boolean;
  removeBusySlug: string | null;
  onApiKeyChange(value: string): void;
  onToggleApiKeyVisibility(): void;
  onModelChoiceChange(value: string | null): void;
  onNewModelDraftChange(value: string): void;
  onAddCustomModel(): void;
  onRemoveCustomModel(slug: string): void;
}): ReactElement {
  // move the existing OpenRouter form markup here unchanged
}
```

Create the placeholder panel:

```tsx
export function ChromeBuiltinPanel(props: {
  availability: 'available' | 'downloadable' | 'downloading' | 'unavailable';
}): ReactElement {
  return (
    <Paper p="lg" radius="xl">
      <Stack gap="sm">
        <Text size="xs" c="dimmed" tt="uppercase" fw={700}>
          Chrome Built-in
        </Text>
        <Title order={3} size="h3">
          Coming soon
        </Title>
        <Text size="sm" c="dimmed">
          Availability: {props.availability}
        </Text>
        <Text size="sm" c="dimmed">
          Full download and readiness onboarding lands in Issue 7.
        </Text>
      </Stack>
    </Paper>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm run test -- tests/options/provider-panels.test.tsx`
Expected: PASS

**Verification**: The provider-specific UI is now factored into dedicated components, with OpenRouter behavior preserved and Chrome Built-in represented by a placeholder panel.

### [ ] Task 4: Refactor the options page into a provider selector

**Files:**
- Modify: `src/options/options.tsx`
- Modify: `e2e/extension.spec.ts`

- [ ] **Step 1: Write the failing Playwright test**

Add this test near the existing options-page coverage in `e2e/extension.spec.ts`:

```typescript
test('options page switches between provider panels', async () => {
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

    await page.getByRole('radio', { name: 'OpenRouter' }).waitFor();
    await expect(page.getByText('Custom models')).toBeVisible();

    await page.getByRole('radio', { name: 'Chrome Built-in' }).click();
    await expect(page.getByText('Coming soon')).toBeVisible();
    await expect(page.getByText(/Availability:/i)).toBeVisible();
    await expect(page.getByRole('switch', { name: /enable/i })).toBeVisible();

    expectNoCollectedErrors(errors);
  } finally {
    await context.close();
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec playwright test e2e/extension.spec.ts -g "options page switches between provider panels"`
Expected: FAIL because the options page does not yet render provider tabs or the Chrome Built-in panel

- [ ] **Step 3: Write minimal implementation**

Refactor `options.tsx` so it loads provider metadata and renders a segmented control above the provider panels.

Add provider-loading state:

```tsx
const [providers, setProviders] = useState<ProviderListItem[]>([]);
const [activeProviderId, setActiveProviderId] = useState(DEFAULT_PROVIDER_ID);
```

Load provider list + active provider inside `load()`:

```tsx
const providerListRes: unknown = await browser.runtime.sendMessage({
  type: TOPSKIP_MESSAGE.GET_PROVIDER_LIST,
});
const activeProviderRes: unknown = await browser.runtime.sendMessage({
  type: TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER,
});
```

Render the selector at top level:

```tsx
<SegmentedControl
  fullWidth
  value={activeProviderId}
  onChange={(nextId) => {
    setActiveProviderId(nextId);
    void browser.runtime.sendMessage({
      type: TOPSKIP_MESSAGE.SET_ACTIVE_PROVIDER,
      providerId: nextId,
    });
  }}
  data={providers.map((provider) => ({
    value: provider.id,
    label: provider.displayName,
  }))}
/>
```

Derive the placeholder panel availability from the loaded provider list:

```tsx
const chromeAvailability =
  providers.find((provider) => provider.id === 'chrome-prompt-api')
    ?.availability ?? 'unavailable';
```

Then render the panels conditionally:

```tsx
{activeProviderId === 'openrouter' ? (
  <OpenRouterConfigPanel ... />
) : (
  <ChromeBuiltinPanel availability={chromeAvailability} />
)}
```

Keep the master enabled switch in the existing top-level controls section; do not move it into either provider panel.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec playwright test e2e/extension.spec.ts -g "options page switches between provider panels"`
Expected: PASS

**Verification**: The options page shows two provider tabs, keeps the master enabled switch at the top level, preserves the OpenRouter form, and shows a Chrome Built-in placeholder panel.

### [ ] Task 5: Full verification

- [ ] **Step 1: Run unit tests for the new coverage**

Run: `pnpm run test -- tests/background/providers/default-registry.test.ts tests/background/messaging/provider-runtime-messages.test.ts tests/options/provider-panels.test.tsx`
Expected: PASS

- [ ] **Step 2: Run lint**

Run: `pnpm run lint`
Expected: PASS

- [ ] **Step 3: Run the full unit suite**

Run: `pnpm run test`
Expected: PASS

- [ ] **Step 4: Run E2E**

Run: `pnpm run test:e2e`
Expected: PASS

- [ ] **Step 5: Run build**

Run: `pnpm run build`
Expected: PASS (existing asset-size warnings are acceptable)

**Verification**: Issue 4 acceptance criteria are covered by automated tests and the existing extension flows remain green.

## Issue Coverage Check

- `GET_PROVIDER_LIST` returns both providers: covered by Task 1 and Task 2.
- `GET_ACTIVE_PROVIDER` returns `providerId` and `displayName`: covered by Task 2.
- `SET_ACTIVE_PROVIDER` valid and invalid flows: covered by Task 2.
- Options page segmented control with two provider tabs: covered by Task 4.
- OpenRouter panel remains visible and behavior-preserving: covered by Task 3 and Task 4.
- Chrome Built-in placeholder panel with availability status: covered by Task 3 and Task 4.
- Master enabled switch remains top-level: covered by Task 4.
- Lint passes: covered by Task 5.

## Self-Review

- Placeholder scan complete: no `TBD`, `TODO`, or deferred “similar to Task N” steps remain.
- Type consistency check: the plan uses `providerId`, `displayName`, and `availability` consistently across shared messages, runtime handlers, and options UI.
- Scope check: the plan intentionally stops at a placeholder Chrome Built-in panel and placeholder provider registration. Full Prompt API adapter work remains in Issue 6, and download onboarding remains in Issue 7.