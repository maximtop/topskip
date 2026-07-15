# Implementation Plan: Issue 8 - Popup: Chrome Built-in model readiness status

**Created**: 2026-04-18
**Status**: Validated
**Issue**: `.sdd/.current/issues/8-popup-chrome-readiness/issue.md`
**PRD**: `.sdd/.current/prd.md`
**Model**: GPT-5.3-Codex (copilot) high
**User Input**: None

## Summary

Add Chrome Built-in readiness messaging to the popup when the active provider is `chrome-prompt-api`. The popup view-model will show readiness-specific statuses (`downloading`, `unavailable`, `downloadable`) before normal detection-state messaging. `PreferencesStore` will track `chromeModelAvailability` by querying `GET_CHROME_PROMPT_API_STATUS` when the active provider is Chrome Built-in, and refresh it on load and provider changes.

## Technical Context

**Language/Version**: TypeScript 5.x (strict), ESM  
**Primary Dependencies**: React 19.2+, MobX 6, mobx-react-lite, Mantine 9  
**Storage**: Background-owned browser storage (`PrefsSyncStorage`), popup uses runtime messaging only  
**Testing**: Vitest 4.x (unit tests under `tests/popup`)  
**Target Platform**: Chrome MV3 extension popup (`dist/popup.html`)

## Research

### Existing popup view-model pattern

`buildPopupViewModel` in `src/popup/PopupApp.tsx` is a pure function that maps store + detection state to tone, labels, and status text. Existing tests in `tests/popup/popup-view-model.test.ts` assert provider label and selected branches. The Chrome readiness status should be implemented as additional explicit branches in this function.

### Existing popup store pattern

`PreferencesStore` in `src/popup/preferences-store.ts` currently loads prefs and active provider data in parallel (`GET_PREFS`, `GET_ACTIVE_PROVIDER`), and listens for `TOPSKIP_PREFS_UPDATED` via a long-lived port. Provider display refresh on provider changes is already implemented (`refreshProviderDisplay`), making it a suitable place to add chrome availability refresh logic.

### Existing runtime contracts available

Issue 7 already introduced `TOPSKIP_MESSAGE.GET_CHROME_PROMPT_API_STATUS` and response type `GetChromePromptApiStatusResponse` in `src/shared/messages.ts`, plus background handler wiring. This issue can consume those contracts without adding new runtime message types.

### Dependency status check

- Issue 5 status: `Validated`
- Issue 6 status: `Validated`

No dependency warnings apply.

## Entities

### PopupChromeReadinessState

- **Fields**:
  - `providerId`: `string` - active provider id from prefs
  - `chromeModelAvailability`: `ProviderAvailabilityMessage | null` - Chrome model readiness state for popup
- **Relationships**: Derived from background runtime responses (`GET_PREFS`, `GET_ACTIVE_PROVIDER`, `GET_CHROME_PROMPT_API_STATUS`), then consumed by `buildPopupViewModel`.
- **Validation**:
  - When `providerId !== 'chrome-prompt-api'`, readiness state is ignored for popup messaging.
  - Availability values are constrained to `'available' | 'downloadable' | 'downloading' | 'unavailable'`.
- **States**:
  - `null` (not fetched / not applicable)
  - `downloadable`
  - `downloading`
  - `unavailable`
  - `available`

## Contracts

N/A - no API endpoints required. This issue consumes existing extension runtime contract:

- `TOPSKIP_MESSAGE.GET_CHROME_PROMPT_API_STATUS`
  - Response: `GetChromePromptApiStatusResponse`

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `tests/popup/popup-view-model.test.ts` | Modify | Add failing tests for Chrome readiness view-model branches |
| `src/popup/PopupApp.tsx` | Modify | Add chrome readiness branches to `buildPopupViewModel`; pass new args from store |
| `tests/popup/preferences-store.test.ts` | Modify | Add failing tests for `chromeModelAvailability` load + refresh behavior |
| `src/popup/preferences-store.ts` | Modify | Add `chromeModelAvailability` observable + runtime fetch logic |

## Tasks

### [x] Task 1: Add failing popup view-model tests for Chrome readiness states

**Files:**
- Modify: `tests/popup/popup-view-model.test.ts`

- [x] **Step 1: Add failing tests for `downloading`, `unavailable`, and `downloadable` when provider is Chrome Built-in**

```ts
it('chrome downloading shows model_downloading messaging', () => {
  const vm = buildPopupViewModel({
    ...baseArgs,
    providerId: 'chrome-prompt-api',
    providerDisplayName: 'Chrome Built-in',
    modelDisplayName: 'Gemini Nano',
    chromeModelAvailability: 'downloading',
    detectionState: { videoId: 'v1', status: 'analyzing' },
  });

  expect(vm.tone).toBe('brand');
  expect(vm.badgeLabel).toBe('Downloading');
  expect(vm.statusHeadline).toContain('Model downloading');
});

it('chrome unavailable shows model_unavailable messaging', () => {
  const vm = buildPopupViewModel({
    ...baseArgs,
    providerId: 'chrome-prompt-api',
    providerDisplayName: 'Chrome Built-in',
    modelDisplayName: 'Gemini Nano',
    chromeModelAvailability: 'unavailable',
    detectionState: { videoId: 'v1', status: 'unavailable' },
  });

  expect(vm.tone).toBe('warning');
  expect(vm.badgeLabel).toBe('Unavailable');
  expect(vm.statusHeadline).toContain('Model unavailable');
  expect(vm.statusBody).toContain('Open settings');
});

it('chrome downloadable shows setup messaging', () => {
  const vm = buildPopupViewModel({
    ...baseArgs,
    providerId: 'chrome-prompt-api',
    providerDisplayName: 'Chrome Built-in',
    modelDisplayName: 'Gemini Nano',
    chromeModelAvailability: 'downloadable',
    detectionState: { videoId: 'v1', status: 'not_configured' },
  });

  expect(vm.tone).toBe('neutral');
  expect(vm.badgeLabel).toBe('Setup');
  expect(vm.statusHeadline).toContain('Model not downloaded yet');
});

it('openrouter ignores chrome readiness state', () => {
  const vm = buildPopupViewModel({
    ...baseArgs,
    providerId: 'openrouter',
    chromeModelAvailability: 'downloading',
    detectionState: { videoId: 'v1', status: 'analyzing' },
  });

  expect(vm.statusHeadline).toBe('Analysis is in progress.');
});
```

- [x] **Step 2: Run popup view-model tests to verify failure**

Run: `pnpm vitest run tests/popup/popup-view-model.test.ts`  
Expected: FAIL with type errors for missing args (`providerId`, `chromeModelAvailability`) and/or assertion mismatches.

**Verification**: New tests fail for expected reasons before implementation.

---

### [x] Task 2: Implement Chrome readiness branches in popup view-model

**Files:**
- Modify: `src/popup/PopupApp.tsx`

- [x] **Step 1: Extend `buildPopupViewModel` args and add Chrome readiness early branches**

```ts
export function buildPopupViewModel(args: {
  enabled: boolean;
  detectionState: PromoDetectionStatePayload | null;
  prefsError: string | null;
  detectionError: string | null;
  providerId: string;
  providerDisplayName: string;
  modelDisplayName: string;
  chromeModelAvailability: ProviderAvailabilityMessage | null;
}): PopupViewModel {
  const {
    enabled,
    detectionState,
    prefsError,
    detectionError,
    providerId,
    providerDisplayName,
    modelDisplayName,
    chromeModelAvailability,
  } = args;

  // ...existing providerLabel and error/off/idle branches...

  if (providerId === 'chrome-prompt-api') {
    if (chromeModelAvailability === 'downloading') {
      return {
        tone: 'brand',
        badgeLabel: 'Downloading',
        badgeColor: 'brand',
        title: 'Preparing Chrome Built-in model',
        description: 'Gemini Nano is downloading on this device.',
        statusHeadline: 'Model downloading...',
        statusBody: 'Keep this popup open or check settings for progress.',
        settingsLabel: 'Open settings',
        providerLabel,
      };
    }

    if (chromeModelAvailability === 'unavailable') {
      return {
        tone: 'warning',
        badgeLabel: 'Unavailable',
        badgeColor: 'warning',
        title: 'Chrome model unavailable',
        description: 'This device does not currently meet Chrome Built-in requirements.',
        statusHeadline: 'Model unavailable - check settings',
        statusBody: 'Open settings to see compatibility requirements and setup guidance.',
        settingsLabel: 'Open settings',
        providerLabel,
      };
    }

    if (chromeModelAvailability === 'downloadable') {
      return {
        tone: 'neutral',
        badgeLabel: 'Setup',
        badgeColor: 'gray',
        title: 'Download required',
        description: 'Chrome Built-in is selected but Gemini Nano is not downloaded yet.',
        statusHeadline: 'Model not downloaded yet',
        statusBody: 'Open settings to download the model and enable on-device analysis.',
        settingsLabel: 'Open settings',
        providerLabel,
      };
    }
  }

  // existing detection-state switch remains unchanged
}
```

- [x] **Step 2: Pass new args from `PopupApp` into `buildPopupViewModel`**

```ts
const view = buildPopupViewModel({
  enabled: store.enabled,
  detectionState,
  prefsError,
  detectionError,
  providerId: store.providerId,
  providerDisplayName: store.providerDisplayName,
  modelDisplayName: store.modelDisplayName,
  chromeModelAvailability: store.chromeModelAvailability,
});
```

- [x] **Step 3: Run view-model tests to verify pass**

Run: `pnpm vitest run tests/popup/popup-view-model.test.ts`  
Expected: PASS.

**Verification**: `buildPopupViewModel` emits chrome readiness-specific tone/headline/body only for `chrome-prompt-api` and defers to existing logic when availability is `available`.

---

### [x] Task 3: Add failing store tests for Chrome availability loading and refresh

**Files:**
- Modify: `tests/popup/preferences-store.test.ts`

- [x] **Step 1: Add failing tests for `chromeModelAvailability` behavior**

```ts
it('load fetches chrome model availability for chrome provider', async () => {
  mocks.sendMessage.mockImplementation((msg: unknown) => {
    const type = msg && typeof msg === 'object'
      ? Reflect.get(msg, 'type')
      : undefined;

    if (type === TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER) {
      return Promise.resolve({
        ok: true,
        providerId: 'chrome-prompt-api',
        displayName: 'Chrome Built-in',
        modelName: 'Gemini Nano',
      });
    }
    if (type === TOPSKIP_MESSAGE.GET_CHROME_PROMPT_API_STATUS) {
      return Promise.resolve({
        ok: true,
        availability: 'downloading',
        downloadProgress: 25,
      });
    }
    return Promise.resolve({
      ok: true,
      prefs: { enabled: true, providerId: 'chrome-prompt-api' },
    });
  });

  const store = new PreferencesStore();
  await store.load();

  expect(store.chromeModelAvailability).toBe('downloading');
  expect(mocks.sendMessage).toHaveBeenCalledWith({
    type: TOPSKIP_MESSAGE.GET_CHROME_PROMPT_API_STATUS,
  });
});

it('load does not fetch chrome model availability for openrouter', async () => {
  const store = new PreferencesStore();
  await store.load();

  expect(store.chromeModelAvailability).toBeNull();
  expect(mocks.sendMessage).not.toHaveBeenCalledWith({
    type: TOPSKIP_MESSAGE.GET_CHROME_PROMPT_API_STATUS,
  });
});

it('port provider switch to chrome refreshes chrome model availability', async () => {
  const store = new PreferencesStore();
  await store.load();

  mocks.sendMessage.mockImplementation((msg: unknown) => {
    const type = msg && typeof msg === 'object'
      ? Reflect.get(msg, 'type')
      : undefined;

    if (type === TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER) {
      return Promise.resolve({
        ok: true,
        providerId: 'chrome-prompt-api',
        displayName: 'Chrome Built-in',
        modelName: 'Gemini Nano',
      });
    }
    if (type === TOPSKIP_MESSAGE.GET_CHROME_PROMPT_API_STATUS) {
      return Promise.resolve({
        ok: true,
        availability: 'downloadable',
        downloadProgress: null,
      });
    }
    return Promise.resolve({ ok: true });
  });

  store.connectPort();
  const listener = mocks.connectOnMessage.addListener.mock
    .calls[0][0] as (msg: unknown) => void;

  listener({
    type: TOPSKIP_MESSAGE.PREFS_UPDATED,
    prefs: { enabled: true, providerId: 'chrome-prompt-api' },
  });

  await Promise.resolve();
  await Promise.resolve();

  expect(store.chromeModelAvailability).toBe('downloadable');
});
```

- [x] **Step 2: Run store tests to verify failure**

Run: `pnpm vitest run tests/popup/preferences-store.test.ts`  
Expected: FAIL because `PreferencesStore` does not yet define `chromeModelAvailability` or status refresh logic.

**Verification**: Tests fail prior to implementation.

---

### [x] Task 4: Implement `chromeModelAvailability` in `PreferencesStore`

**Files:**
- Modify: `src/popup/preferences-store.ts`

- [x] **Step 1: Add state, type guard, and refresh method**

```ts
import {
  TOPSKIP_MESSAGE,
  type GetActiveProviderResponse,
  type GetChromePromptApiStatusResponse,
  type GetPrefsResponse,
  type ProviderAvailabilityMessage,
  type SetPrefsResponse,
  isPrefsPortMessage,
} from '@/shared/messages';

function isGetChromePromptApiStatusOk(
  res: unknown,
): res is Extract<GetChromePromptApiStatusResponse, { ok: true }> {
  return (
    typeof res === 'object' &&
    res !== null &&
    'ok' in res &&
    (res as { ok: boolean }).ok === true &&
    'availability' in res &&
    typeof (res as { availability: unknown }).availability === 'string'
  );
}

export class PreferencesStore {
  // ...existing fields...
  chromeModelAvailability: ProviderAvailabilityMessage | null = null;

  private async refreshChromeModelAvailability(): Promise<void> {
    if (this.providerId !== 'chrome-prompt-api') {
      runInAction(() => {
        this.chromeModelAvailability = null;
      });
      return;
    }

    const res = await browser.runtime.sendMessage({
      type: TOPSKIP_MESSAGE.GET_CHROME_PROMPT_API_STATUS,
    });

    runInAction(() => {
      if (isGetChromePromptApiStatusOk(res)) {
        this.chromeModelAvailability = res.availability;
      } else {
        this.chromeModelAvailability = null;
      }
    });
  }
}
```

- [x] **Step 2: Call refresh during `load()` and on provider changes via port**

```ts
async load(): Promise<void> {
  const [prefsRes, providerRes] = await Promise.all([
    browser.runtime.sendMessage({ type: TOPSKIP_MESSAGE.GET_PREFS }),
    browser.runtime.sendMessage({ type: TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER }),
  ]);

  // ...existing prefs/provider assignment...

  await this.refreshChromeModelAvailability();
}

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
        void this.refreshChromeModelAvailability();
      }
    }
  });
}
```

- [x] **Step 3: Run store tests to verify pass**

Run: `pnpm vitest run tests/popup/preferences-store.test.ts`  
Expected: PASS.

**Verification**: Store fetches Chrome status when provider is Chrome Built-in and clears state for OpenRouter.

---

### [x] Task 5: Verify provider readiness messaging integration in popup app

**Files:**
- Modify: `src/popup/PopupApp.tsx`
- Modify: `tests/popup/popup-view-model.test.ts`

- [x] **Step 1: Ensure Chrome readiness state takes precedence only when provider is chrome and availability is not `available`**

```ts
if (
  providerId === 'chrome-prompt-api' &&
  chromeModelAvailability !== null &&
  chromeModelAvailability !== 'available'
) {
  // readiness state branches
}
```

- [x] **Step 2: Add test that `available` falls through to existing detection logic**

```ts
it('chrome available falls back to detection logic', () => {
  const vm = buildPopupViewModel({
    ...baseArgs,
    providerId: 'chrome-prompt-api',
    providerDisplayName: 'Chrome Built-in',
    modelDisplayName: 'Gemini Nano',
    chromeModelAvailability: 'available',
    detectionState: { videoId: 'v1', status: 'analyzing' },
  });

  expect(vm.statusHeadline).toBe('Analysis is in progress.');
});
```

- [x] **Step 3: Run targeted popup tests**

Run: `pnpm vitest run tests/popup/popup-view-model.test.ts tests/popup/preferences-store.test.ts`  
Expected: PASS.

**Verification**: All acceptance-state branches are covered in tests and no regression in existing popup model-status behavior.

---

### [x] Task 6: Final validation for the issue slice

**Files:**
- No new files

- [x] **Step 1: Run lint**

Run: `pnpm run lint`  
Expected: PASS.

- [x] **Step 2: Run full unit tests**

Run: `pnpm run test`  
Expected: PASS.

- [x] **Step 3: (Optional for this slice) run e2e if popup text assertions are present**

Run: `pnpm run test:e2e`  
Expected: PASS.

**Verification**: All acceptance criteria for popup readiness states are validated and lint is clean.

## Acceptance Criteria Coverage Check

- **AC1** downloading shows “Model downloading…”: Task 1 test + Task 2 implementation.
- **AC2** unavailable shows “Model unavailable” + link: Task 1 test + Task 2 implementation (`statusBody` directs to settings and popup action button opens options).
- **AC3** downloadable shows “Model not downloaded yet”: Task 1 test + Task 2 implementation.
- **AC4** available defers to existing detection logic: Task 5 explicit test + guard condition.
- **AC5** openrouter does not show chrome readiness states: Task 1 explicit openrouter test.
- **AC6** lint passes: Task 6.

## Self-Review

- **Issue coverage**: Every acceptance criterion maps to at least one task and explicit test.
- **Placeholder scan**: No unresolved placeholders remain.
- **Type consistency**: Uses existing `ProviderAvailabilityMessage` and `GetChromePromptApiStatusResponse` contracts; `buildPopupViewModel` args are consistently named across plan tasks.
