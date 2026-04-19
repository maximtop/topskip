# Implementation Plan: Popup — Display Active Provider & Model Label

**Created**: 2026-04-17
**Status**: Validated
**Issue**: `.sdd/.current/issues/5-popup-provider-label/issue.md`
**PRD**: `.sdd/.current/prd.md`
**Model**: github-copilot/claude-sonnet-4.6
**User Input**: None

## Summary

Display the active LLM provider and model name in the popup status area
(e.g. "OpenRouter · gemini-3.1-pro-preview" or "Chrome Built-in · Gemini
Nano"). Three new MobX observables are added to `PreferencesStore`; the
data is fetched via `GET_ACTIVE_PROVIDER` (extended with a `modelName`
field). `PopupApp` renders the label in the hero area and includes it in
the `buildPopupViewModel` output. Port-message-driven provider changes
refresh the label.

## Technical Context

**Language/Version**: TypeScript 5.x strict, ESM
**Primary Dependencies**: React 19, Mantine 9, MobX 6, Valibot, webextension-polyfill
**Storage**: `browser.storage.local` — read/written only in background; popup uses messaging
**Testing**: Vitest 4.x (node environment); `tests/` mirrors `src/`
**Target Platform**: Chrome MV3 extension popup

## Research

### `GET_ACTIVE_PROVIDER` response shape (current)

`src/shared/messages.ts:114`:

```typescript
export type GetActiveProviderResponse =
  | { ok: true; providerId: string; displayName: string }
  | { ok: false; error: string };
```

`src/background/messaging/provider-runtime-messages.ts:71` — the handler
returns the adapter's `displayName` but does not include model info.

**Gap**: The popup needs a `modelName` field (e.g. `"gemini-3.1-pro-preview"`
for OpenRouter, `"Gemini Nano"` for Chrome Built-in) to render the full
label. The cleanest fix is to extend the response type and the handler —
one message round-trip covers everything.

### `PreferencesStore` current state (`src/popup/preferences-store.ts`)

Already has `enabled` (boolean) and `providerId` (string) observables.
`load()` sends `GET_PREFS` only. The port listener updates `enabled` and
`providerId` from `PREFS_UPDATED` messages. The issue refers to
`activeProviderId` as a new observable name, but to preserve existing
tests and call sites the existing `providerId` field is kept; two new
fields (`providerDisplayName`, `modelDisplayName`) are added.

### Port message refresh strategy

When `PREFS_UPDATED` arrives with a changed `providerId`, a second
`GET_ACTIVE_PROVIDER` call is needed to refresh `providerDisplayName` and
`modelDisplayName`. The port listener is synchronous, so the async refresh
is kicked off with `void this.refreshProviderDisplay()` — a private async
helper that calls `GET_ACTIVE_PROVIDER` and calls `runInAction` on the
result.

### Model name derivation in the background handler

The background handler already imports `PrefsSyncStorage` and
`defaultRegistry`. For OpenRouter, `OpenRouterStorage.load().model` is
the configured slug (empty string if unconfigured). For Chrome Built-in,
`"Gemini Nano"` is hardcoded (the real model name; there is no
user-configurable model for this adapter). For any unknown provider the
handler returns `""`.

Using `PROVIDER_ID.OpenRouter` / `PROVIDER_ID.ChromePromptApi` constants
(already imported in sibling files) avoids magic strings.

### `buildPopupViewModel` and provider label

`buildPopupViewModel` is a pure function inside `PopupApp.tsx:100`. It
currently accepts `{ enabled, detectionState, prefsError, detectionError
}`. To include provider info in the `not_configured` case (and to make
the function unit-testable) two additional args are added:
`providerDisplayName` and `modelDisplayName`. A new `providerLabel: string`
field is added to `PopupViewModel` so that the test can assert on it
without rendering React.

`buildPopupViewModel` is exported (named export) so it can be tested in
isolation in `tests/popup/popup-view-model.test.ts`.

### Existing test that must be updated

`tests/background/messaging/provider-runtime-messages.test.ts:119` asserts
`toEqual({ ok: true, providerId: 'openrouter', displayName: 'OpenRouter' })`.
After `modelName` is added to the response this assertion will fail.
The test must be updated to include `modelName: ''` (the mock returns an
empty model) and a new mock for `OpenRouterStorage.load` must be added.

## Entities

N/A — no new persistent entities. Changes are to message payload shape
and observable state only.

## Contracts

No new API endpoints. Message contract change: `GetActiveProviderResponse`
success branch gains one field (`modelName: string`).

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/shared/messages.ts` | Modify | Add `modelName: string` to `GetActiveProviderResponse` success branch |
| `src/background/messaging/provider-runtime-messages.ts` | Modify | Compute and return `modelName` in `handleGetActive()` |
| `src/popup/preferences-store.ts` | Modify | Add `providerDisplayName`, `modelDisplayName` observables; fetch via `GET_ACTIVE_PROVIDER` in `load()`; refresh on port provider change |
| `src/popup/PopupApp.tsx` | Modify | Export `buildPopupViewModel`; add `providerDisplayName`/`modelDisplayName` args and `providerLabel` field; render label in hero area; update `not_configured` copy |
| `tests/background/messaging/provider-runtime-messages.test.ts` | Modify | Add `OpenRouterStorage` mock; update `GET_ACTIVE_PROVIDER` assertion to include `modelName`; add test for model name population |
| `tests/popup/preferences-store.test.ts` | Modify | Add tests for `providerDisplayName`/`modelDisplayName` load, port-message update, and refresh-on-provider-change |
| `tests/popup/popup-view-model.test.ts` | Create | Unit-test `buildPopupViewModel` for provider label field across relevant states |

## Tasks

---

### [ ] Task 1: Extend `GetActiveProviderResponse` with `modelName`

**Files:**
- Modify: `src/shared/messages.ts`

- [ ] **Step 1: Write the failing test**

In `tests/background/messaging/provider-runtime-messages.test.ts`, update
the existing `GET_ACTIVE_PROVIDER` test and add a new one.

First, add `OpenRouterStorage` to the `vi.hoisted` mocks block and the
`vi.mock` call (add after the existing `PrefsSyncStorage` mock):

```typescript
const mocks = vi.hoisted(() => ({
  prefsReady: vi.fn().mockResolvedValue(undefined),
  prefsLoad: vi.fn(),
  prefsSave: vi.fn().mockResolvedValue(undefined),
  sendUpdatedToAllTabs: vi.fn().mockResolvedValue(undefined),
  broadcastPrefsUpdate: vi.fn(),
  abortForProviderChange: vi.fn(),
  openRouterLoad: vi.fn(),          // ← new
}));
```

Add mock for `OpenRouterStorage` after the existing `PrefsSyncStorage`
mock (line 22–27 area):

```typescript
vi.mock('@/background/storage/openrouter-storage', () => ({
  OpenRouterStorage: {
    load: mocks.openRouterLoad,
  },
}));
```

In `beforeEach`, seed `openRouterLoad` with an empty config (matching the
default state already used in other tests):

```typescript
mocks.openRouterLoad.mockResolvedValue({
  apiKey: '',
  model: '',
  customModels: [],
});
```

Update the existing assertion at line 119–130 to include the new field
(change `toEqual` object):

```typescript
it('GET_ACTIVE_PROVIDER returns providerId and displayName', async () => {
  const res = await ProviderRuntimeMessages.handle(
    { type: TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER },
    {} as never,
  );

  expect(res).toEqual({
    ok: true,
    providerId: 'openrouter',
    displayName: 'OpenRouter',
    modelName: '',          // ← new; empty because mock returns model: ''
  });
});
```

Add a second test for when a model is configured:

```typescript
it('GET_ACTIVE_PROVIDER includes configured model slug for openrouter', async () => {
  mocks.openRouterLoad.mockResolvedValueOnce({
    apiKey: 'sk-test',
    model: 'google/gemini-2.0-flash',
    customModels: [],
  });

  const res = await ProviderRuntimeMessages.handle(
    { type: TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER },
    {} as never,
  );

  expect(res).toEqual({
    ok: true,
    providerId: 'openrouter',
    displayName: 'OpenRouter',
    modelName: 'google/gemini-2.0-flash',
  });
});
```

Add a test for chrome-prompt-api:

```typescript
it('GET_ACTIVE_PROVIDER returns "Gemini Nano" as modelName for chrome-prompt-api', async () => {
  mocks.prefsLoad.mockResolvedValueOnce({
    enabled: true,
    providerId: 'chrome-prompt-api',
  });

  const res = await ProviderRuntimeMessages.handle(
    { type: TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER },
    {} as never,
  );

  expect(res).toEqual({
    ok: true,
    providerId: 'chrome-prompt-api',
    displayName: 'Chrome Built-in',
    modelName: 'Gemini Nano',
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm run test -- --reporter=verbose tests/background/messaging/provider-runtime-messages.test.ts`
Expected: FAIL — the existing assertion fails on the unexpected `modelName`
field, and the new tests fail because the field doesn't exist yet.

- [ ] **Step 3: Add `modelName` to `GetActiveProviderResponse` in `src/shared/messages.ts`**

Change lines 114–116:

```typescript
export type GetActiveProviderResponse =
  | { ok: true; providerId: string; displayName: string; modelName: string }
  | { ok: false; error: string };
```

- [ ] **Step 4: Run test to verify it still fails (handler not updated yet)**

Run: `pnpm run test -- --reporter=verbose tests/background/messaging/provider-runtime-messages.test.ts`
Expected: FAIL — TypeScript error or runtime assertion mismatch because
handler still returns `{ ok, providerId, displayName }` without `modelName`.

**Verification**: The type change compiles correctly with `pnpm run lint:types`.

---

### [ ] Task 2: Update `handleGetActive()` to populate `modelName`

**Files:**
- Modify: `src/background/messaging/provider-runtime-messages.ts`

- [ ] **Step 1: Add imports**

At the top of `src/background/messaging/provider-runtime-messages.ts`,
add two imports after the existing ones:

```typescript
import { OpenRouterStorage } from
  '@/background/storage/openrouter-storage';
import { PROVIDER_ID } from
  '@/background/providers/llm-provider-adapter';
```

- [ ] **Step 2: Update `handleGetActive()`**

Replace the existing `handleGetActive` method body (lines 71–84):

```typescript
private static async handleGetActive(): Promise<GetActiveProviderResponse> {
  await PrefsSyncStorage.ready();
  try {
    const prefs = await PrefsSyncStorage.load();
    const adapter = ProviderRuntimeMessages.registry.get(prefs.providerId);

    let modelName = '';
    if (prefs.providerId === PROVIDER_ID.OpenRouter) {
      const orConfig = await OpenRouterStorage.load();
      modelName = orConfig.model;
    } else if (prefs.providerId === PROVIDER_ID.ChromePromptApi) {
      modelName = 'Gemini Nano';
    }

    return {
      ok: true,
      providerId: prefs.providerId,
      displayName: adapter?.displayName ?? prefs.providerId,
      modelName,
    };
  } catch (e) {
    return { ok: false, error: getErrorMessage(e) };
  }
}
```

- [ ] **Step 3: Run tests to verify they pass**

Run: `pnpm run test -- --reporter=verbose tests/background/messaging/provider-runtime-messages.test.ts`
Expected: PASS — all three new GET_ACTIVE_PROVIDER assertions pass.

- [ ] **Step 4: Run full lint**

Run: `pnpm run lint`
Expected: PASS (no type errors, no lint warnings).

**Verification**: `pnpm run lint:types` exits 0.

---

### [ ] Task 3: Add `providerDisplayName` and `modelDisplayName` to `PreferencesStore`

**Files:**
- Modify: `src/popup/preferences-store.ts`
- Modify: `tests/popup/preferences-store.test.ts`

- [ ] **Step 1: Write failing tests for the new observables**

Append the following tests to the `describe('PreferencesStore', ...)` block
in `tests/popup/preferences-store.test.ts`. First, update `beforeEach` so
that `sendMessage` can return different values for different message types
(use `mockImplementation` instead of `mockResolvedValue`):

```typescript
// Replace the existing beforeEach mock setup:
beforeEach(() => {
  mocks.sendMessage.mockReset();
  mocks.sendMessage.mockImplementation((msg: unknown) => {
    if (
      msg &&
      typeof msg === 'object' &&
      Reflect.get(msg, 'type') === TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER
    ) {
      return Promise.resolve({
        ok: true,
        providerId: 'openrouter',
        displayName: 'OpenRouter',
        modelName: 'google/gemini-2.0-flash',
      });
    }
    // Default: prefs response
    return Promise.resolve({
      ok: true,
      prefs: { enabled: false, providerId: 'openrouter' },
    });
  });
});
```

Add new tests:

```typescript
it('load populates providerDisplayName and modelDisplayName from GET_ACTIVE_PROVIDER', async () => {
  const store = new PreferencesStore();
  await store.load();
  expect(store.providerDisplayName).toBe('OpenRouter');
  expect(store.modelDisplayName).toBe('google/gemini-2.0-flash');
  expect(mocks.sendMessage).toHaveBeenCalledWith({
    type: TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER,
  });
});

it('load sets empty modelDisplayName when GET_ACTIVE_PROVIDER fails', async () => {
  mocks.sendMessage.mockImplementation((msg: unknown) => {
    if (
      msg &&
      typeof msg === 'object' &&
      Reflect.get(msg, 'type') === TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER
    ) {
      return Promise.resolve({ ok: false, error: 'unavailable' });
    }
    return Promise.resolve({
      ok: true,
      prefs: { enabled: true, providerId: 'openrouter' },
    });
  });
  const store = new PreferencesStore();
  await store.load();
  expect(store.providerDisplayName).toBe('');
  expect(store.modelDisplayName).toBe('');
});

it('port message with changed providerId triggers refreshProviderDisplay', async () => {
  const store = new PreferencesStore();
  await store.load();

  // Seed new response for the refresh call triggered by provider change
  mocks.sendMessage.mockImplementation((msg: unknown) => {
    if (
      msg &&
      typeof msg === 'object' &&
      Reflect.get(msg, 'type') === TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER
    ) {
      return Promise.resolve({
        ok: true,
        providerId: 'chrome-prompt-api',
        displayName: 'Chrome Built-in',
        modelName: 'Gemini Nano',
      });
    }
    return Promise.resolve({ ok: true });
  });

  store.connectPort();

  const listener = mocks.connectOnMessage.addListener.mock
    .calls[0][0] as (msg: unknown) => void;

  // Simulate provider change arriving on port
  listener({
    type: 'TOPSKIP_PREFS_UPDATED',
    prefs: { enabled: true, providerId: 'chrome-prompt-api' },
  });

  // refreshProviderDisplay is async; wait one microtask tick
  await Promise.resolve();
  await Promise.resolve();

  expect(store.providerDisplayName).toBe('Chrome Built-in');
  expect(store.modelDisplayName).toBe('Gemini Nano');
});

it('port message with same providerId does NOT call GET_ACTIVE_PROVIDER', async () => {
  const store = new PreferencesStore();
  await store.load();
  const callsBefore = mocks.sendMessage.mock.calls.length;

  store.connectPort();
  const listener = mocks.connectOnMessage.addListener.mock
    .calls[0][0] as (msg: unknown) => void;

  // Same provider as loaded
  listener({
    type: 'TOPSKIP_PREFS_UPDATED',
    prefs: { enabled: false, providerId: 'openrouter' },
  });

  await Promise.resolve();

  // No extra sendMessage call for GET_ACTIVE_PROVIDER
  expect(mocks.sendMessage.mock.calls.length).toBe(callsBefore);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm run test -- --reporter=verbose tests/popup/preferences-store.test.ts`
Expected: FAIL — `providerDisplayName` and `modelDisplayName` properties
do not exist on the store yet.

- [ ] **Step 3: Implement the changes in `preferences-store.ts`**

Add type guard for `GetActiveProviderResponse` after the existing `isSetPrefsOk`
function (around line 50):

```typescript
/**
 * Type guard for a successful GET_ACTIVE_PROVIDER response.
 *
 * @param res - Untyped `runtime.sendMessage` result.
 * @returns Whether `res` is `{ ok: true, providerId, displayName, modelName }`.
 */
function isGetActiveProviderOk(
  res: unknown,
): res is Extract<GetActiveProviderResponse, { ok: true }> {
  return (
    typeof res === 'object' &&
    res !== null &&
    'ok' in res &&
    (res as { ok: boolean }).ok === true &&
    'displayName' in res &&
    typeof (res as { displayName: unknown }).displayName === 'string'
  );
}
```

Add the import for `GetActiveProviderResponse` to the existing import from
`@/shared/messages` (lines 8–13):

```typescript
import {
  TOPSKIP_MESSAGE,
  type GetPrefsResponse,
  type SetPrefsResponse,
  type GetActiveProviderResponse,
  isPrefsPortMessage,
} from '@/shared/messages';
```

Add two new observable fields on the class (after line 58 `providerId`):

```typescript
providerDisplayName: string = '';
modelDisplayName: string = '';
```

Add a private helper method for refreshing provider display info (insert
before `connectPort()`):

```typescript
/**
 * Fetches the active provider display name and model name from the
 * background and updates the corresponding observables.
 *
 * @returns Promise that resolves when the observables are updated.
 */
private async refreshProviderDisplay(): Promise<void> {
  const res = await browser.runtime.sendMessage({
    type: TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER,
  });
  if (isGetActiveProviderOk(res)) {
    runInAction(() => {
      this.providerDisplayName = res.displayName;
      this.modelDisplayName = res.modelName;
    });
  }
}
```

Update `load()` to call `GET_ACTIVE_PROVIDER` in parallel with `GET_PREFS`:

```typescript
async load(): Promise<void> {
  const [prefsRes, providerRes] = await Promise.all([
    browser.runtime.sendMessage({ type: TOPSKIP_MESSAGE.GET_PREFS }),
    browser.runtime.sendMessage({ type: TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER }),
  ]);

  if (!isGetPrefsOk(prefsRes)) {
    const err =
      prefsRes && typeof prefsRes === 'object' && 'error' in prefsRes
        ? String((prefsRes as { error: string }).error)
        : translator.getMessage('prefs_error_load');
    throw new Error(err);
  }

  runInAction(() => {
    this.enabled = prefsRes.prefs.enabled;
    if (typeof prefsRes.prefs.providerId === 'string') {
      this.providerId = prefsRes.prefs.providerId;
    }
    if (isGetActiveProviderOk(providerRes)) {
      this.providerDisplayName = providerRes.displayName;
      this.modelDisplayName = providerRes.modelName;
    }
  });
}
```

Update `connectPort()` to refresh display names when the provider ID changes:

```typescript
connectPort(): void {
  this.port = browser.runtime.connect({ name: PREFS_PORT_NAME });
  this.port.onMessage.addListener((msg: unknown) => {
    if (isPrefsPortMessage(msg)) {
      const prevProviderId = this.providerId;
      runInAction(() => {
        this.enabled = msg.prefs.enabled;
        if (typeof msg.prefs.providerId === 'string') {
          this.providerId = msg.prefs.providerId;
        }
      });
      if (msg.prefs.providerId !== prevProviderId) {
        void this.refreshProviderDisplay();
      }
    }
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm run test -- --reporter=verbose tests/popup/preferences-store.test.ts`
Expected: PASS — all existing tests still pass; new tests pass.

- [ ] **Step 5: Run full lint**

Run: `pnpm run lint`
Expected: PASS.

**Verification**: `store.providerDisplayName` and `store.modelDisplayName`
are populated after `load()` and refresh correctly when a port message
changes the provider.

---

### [ ] Task 4: Export `buildPopupViewModel` and add `providerLabel` to view model

**Files:**
- Modify: `src/popup/PopupApp.tsx`
- Create: `tests/popup/popup-view-model.test.ts`

- [ ] **Step 1: Write failing tests for the updated view model**

Create `tests/popup/popup-view-model.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';

import { buildPopupViewModel } from '@/popup/PopupApp';

describe('buildPopupViewModel', () => {
  const baseArgs = {
    enabled: true,
    detectionState: null,
    prefsError: null,
    detectionError: null,
    providerDisplayName: 'OpenRouter',
    modelDisplayName: 'google/gemini-2.0-flash',
  };

  it('idle state includes provider label', () => {
    const vm = buildPopupViewModel(baseArgs);
    expect(vm.providerLabel).toBe('OpenRouter · google/gemini-2.0-flash');
  });

  it('providerLabel omits separator when modelDisplayName is empty', () => {
    const vm = buildPopupViewModel({
      ...baseArgs,
      modelDisplayName: '',
    });
    expect(vm.providerLabel).toBe('OpenRouter');
  });

  it('not_configured description includes provider name', () => {
    const vm = buildPopupViewModel({
      ...baseArgs,
      detectionState: { videoId: 'v1', status: 'not_configured' },
    });
    expect(vm.description).toContain('OpenRouter');
    expect(vm.providerLabel).toBe('OpenRouter · google/gemini-2.0-flash');
  });

  it('Chrome Built-in provider label shows "Chrome Built-in · Gemini Nano"', () => {
    const vm = buildPopupViewModel({
      ...baseArgs,
      providerDisplayName: 'Chrome Built-in',
      modelDisplayName: 'Gemini Nano',
      detectionState: { videoId: 'v1', status: 'analyzing' },
    });
    expect(vm.providerLabel).toBe('Chrome Built-in · Gemini Nano');
  });

  it('openrouter not_configured shows "Not configured" as model portion', () => {
    const vm = buildPopupViewModel({
      ...baseArgs,
      modelDisplayName: '',
      detectionState: { videoId: 'v1', status: 'not_configured' },
    });
    // Label should convey not configured state
    expect(vm.providerLabel).toBe('OpenRouter');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm run test -- --reporter=verbose tests/popup/popup-view-model.test.ts`
Expected: FAIL — `buildPopupViewModel` is not exported; `providerLabel`
field doesn't exist on `PopupViewModel`.

- [ ] **Step 3: Update `PopupApp.tsx`**

**3a. Export `buildPopupViewModel`**

Change:
```typescript
function buildPopupViewModel(args: {
```
To:
```typescript
export function buildPopupViewModel(args: {
```

**3b. Add `providerDisplayName` and `modelDisplayName` to the args**

Add after `detectionError: string | null;`:

```typescript
  providerDisplayName: string;
  modelDisplayName: string;
```

**3c. Add `providerLabel` to `PopupViewModel` type**

Add after `settingsLabel: string;` in the `PopupViewModel` type (around line 90):

```typescript
  providerLabel: string;
```

**3d. Add `providerLabel` computation and update destructuring**

At the top of `buildPopupViewModel`, after the destructuring line
`const { enabled, detectionState, prefsError, detectionError } = args;`,
add:

```typescript
  const { providerDisplayName, modelDisplayName } = args;

  const providerLabel = modelDisplayName
    ? `${providerDisplayName} · ${modelDisplayName}`
    : providerDisplayName;
```

**3e. Add `providerLabel` to every return object in the function**

Every `return { tone, badgeLabel, ..., settingsLabel }` block must include
`providerLabel`. All branches can use the same value — it is computed once
above.

For example, the error branch (currently returns without it) becomes:

```typescript
return {
  tone: 'danger',
  badgeLabel: 'Error',
  badgeColor: 'error',
  title: 'Status unavailable',
  description: 'TopSkip could not refresh its current state.',
  statusHeadline: message,
  statusBody: null,
  settingsLabel: 'Open settings',
  providerLabel,
};
```

Apply the same addition to every other branch (`!enabled`, `null state`,
all `switch` cases including `not_configured`, `unavailable`, `analyzing`,
`detected`, `no_promo`, `error`, `default`).

**3f. Update `not_configured` description to include provider name**

In the `case 'not_configured':` block, replace the hardcoded description:

```typescript
// Before:
description:
  'Add your OpenRouter key to enable ' +
  'transcript analysis for promo detection.',

// After:
description:
  `Configure ${providerDisplayName || 'your LLM provider'} to enable ` +
  'transcript analysis for promo detection.',
```

**3g. Update `buildPopupViewModel` call-site in the component**

The component calls `buildPopupViewModel` near line 452. Update:

```typescript
const view = buildPopupViewModel({
  enabled: store.enabled,
  detectionState,
  prefsError,
  detectionError,
  providerDisplayName: store.providerDisplayName,
  modelDisplayName: store.modelDisplayName,
});
```

**3h. Add provider label element inside the hero `Paper`**

After the `Switch` control Paper (the inner `<Paper>` that wraps the switch,
ending around line 530), add the provider label row:

```tsx
<Group gap={4} mt={8} align="center">
  <Text size="xs" c="dimmed">
    {view.providerLabel
      ? `⚡ ${view.providerLabel}`
      : null}
  </Text>
  {detectionState?.status === 'not_configured' &&
    store.providerId === 'openrouter' &&
    store.modelDisplayName === '' ? (
    <Badge size="xs" color="warning" variant="light">
      Not configured
    </Badge>
  ) : null}
</Group>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm run test -- --reporter=verbose tests/popup/popup-view-model.test.ts`
Expected: PASS — all five view-model tests pass.

Run: `pnpm run test -- --reporter=verbose tests/popup/preferences-store.test.ts`
Expected: PASS — no regressions.

- [ ] **Step 5: Run full lint**

Run: `pnpm run lint`
Expected: PASS.

**Verification**: The `providerLabel` field is populated correctly; the
`not_configured` description references the provider name; lint is clean.

---

### [ ] Task 5: Full test suite and build verification

- [ ] **Step 1: Run all unit tests**

Run: `pnpm run test`
Expected: PASS — all tests green.

- [ ] **Step 2: Run coverage**

Run: `pnpm run test:coverage`
Expected: PASS — `src/popup/preferences-store.ts` coverage thresholds met
(lines ≥ 80 %, branches ≥ 75 %, functions ≥ 80 %, statements ≥ 80 %).

- [ ] **Step 3: Build extension**

Run: `pnpm run build`
Expected: PASS — `dist/popup.js` emitted without errors.

- [ ] **Step 4: Run E2E tests**

Run: `pnpm run test:e2e`
Expected: PASS — no regressions (E2E tests do not interact with provider
label; OpenRouter path is unchanged behind adapter).

**Verification**: All CI steps pass locally before pushing.
