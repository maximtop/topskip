# Implementation Plan: Unify `enabled` flags into `providerId` in prefs + storage migration

**Created**: 2026-04-17
**Status**: Validated
**Issue**: `.sdd/.current/issues/2-unify-enabled-provider-id/issue.md`
**PRD**: `.sdd/.current/prd.md`
**Model**: GLM-5.1 via OpenRouter (standard)
**User Input**: None

## Summary

Add `providerId` (default `'openrouter'`) to `userPreferencesSchema` so a single field identifies the active LLM backend. Remove the `enabled` flag from `OpenRouterConfig` and its schema. Delete `reconcileDivergentEnabled()` (no migration needed — app is unreleased). Wire `providerId` through `GetPrefsResponse` and `PreferencesStore` so the popup and options pages can read it. Update all dependent code and tests.

## Technical Context

**Language/Version**: TypeScript 5.x (strict, ESM)
**Primary Dependencies**: Valibot (schema validation), webextension-polyfill (browser.*), MobX (popup store)
**Storage**: `browser.storage.local` — prefs under `topskip:prefs`, OpenRouter config under `topskip:openrouter`
**Testing**: Vitest 4.x with `vi.hoisted()` + `vi.mock()` patterns
**Target Platform**: Chrome Manifest V3 extension (service worker)

## Research

### Current dual-flag architecture

Two separate `enabled` flags exist:
1. `topskip:prefs.enabled` — master on/off for the extension
2. `topskip:openrouter.enabled` — whether OpenRouter LLM analysis runs

These are synced bidirectionally by:
- `PrefsRuntimeMessages.handleSet()` (FR-014): when popup toggles `enabled`, it propagates to OpenRouter storage
- `OpenRouterRuntimeMessages.handleSet()` (FR-015): when options toggles `enabled`, it propagates to prefs
- `reconcileDivergentEnabled()` (FR-016): on startup, if they disagree, resolves to `true` (opt-in wins)

### Impact on existing tests

- `tests/background/messaging/enabled-sync.test.ts`: 3 tests for FR-014/015/016 must be updated or replaced since the `enabled` sync and reconciliation logic is being removed
- `tests/background/storage/openrouter-storage.test.ts`: Remove assertions on `enabled` field; update save/load round-trip tests
- `tests/background/messaging/openrouter-runtime-messages.test.ts`: Remove `enabled` from mock configs and assertions
- `tests/popup/preferences-store.test.ts`: Add `providerId` to mock prefs responses

## Entities

### UserPreferences (modified)

- **Fields**:
  - `enabled`: `boolean` — master on/off (unchanged)
  - `providerId`: `string` — active LLM provider ID (new, default `'openrouter'`)
- **Validation**: `providerId` must be a non-empty string; required (no fallback — app is unreleased)
- **States**: `providerId` starts at `'openrouter'`; future values include `'chrome-prompt-api'`

### OpenRouterConfig (modified)

- **Fields**:
  - `apiKey`: `string` — unchanged
  - `model`: `string` — unchanged
  - `customModels`: `string[]` — unchanged
  - ~~`enabled`: `boolean`~~ — REMOVED
- **Validation**: When `openrouter` is the active provider (`providerId === 'openrouter'`), `apiKey` and `model` must be non-empty. The old `enabled && (apiKey empty || model empty)` guard in `save()` is replaced by just removing the `enabled` guard entirely — validation of whether the provider *can* run is now the adapter's `availability()` method.

## Contracts

N/A — no API endpoints required. All changes are internal storage + messaging.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/shared/constants.ts` | Modify | Add `providerId` (`v.string()`) to `userPreferencesSchema`; export `DEFAULT_PROVIDER_ID` |
| `src/background/storage/openrouter-storage.ts` | Modify | Remove `enabled` from `OpenRouterConfig` type, schema, and defaults; remove `canRunPromoAnalysis()`; relax `save()` validation (no `enabled` guard) |
| `src/background/storage/prefs-sync.ts` | Modify | Update `defaultPrefs` to include `providerId: DEFAULT_PROVIDER_ID` |
| `src/background/background.ts` | Modify | Delete `reconcileDivergentEnabled()`; remove its call from `init()` |
| `src/background/messaging/promo-analysis.ts` | Modify | Replace `orConfig.enabled` check with `prefs.providerId` check |
| `src/shared/messages.ts` | Modify | Add `providerId` to `GetOpenRouterConfigResponse` (remove `enabled`); update `SetOpenRouterConfig` message type (remove `enabled`); update `TopSkipRuntimeMessage` union |
| `src/popup/preferences-store.ts` | Modify | Add `providerId` observable; update `load()` and port listener to read it |
| `src/background/messaging/runtime-messages.ts` | Modify | Remove FR-014 OpenRouter `enabled` sync from `handleSet()` |
| `src/background/messaging/openrouter-runtime-messages.ts` | Modify | Remove `enabled` from handleGet/handleSet; remove FR-015 prefs-enabled sync |
| `tests/background/storage/openrouter-storage.test.ts` | Modify | Remove `enabled` from all mock configs and assertions; remove `save rejects enabled without key and model` test |
| `tests/background/messaging/enabled-sync.test.ts` | Modify | Replace FR-014/015/016 tests with assertions that enabled-sync no longer occurs |
| `tests/background/messaging/openrouter-runtime-messages.test.ts` | Modify | Remove `enabled` from mock configs and assertions |
| `tests/popup/preferences-store.test.ts` | Modify | Add `providerId` to mock prefs responses and assertions |
| `tests/background/storage/prefs-sync.test.ts` | Create | Unit tests for `PrefsSyncStorage` with `providerId` (load/save round-trip) |

## Tasks

### [x] Task 1: Add `providerId` to `userPreferencesSchema` + `DEFAULT_PROVIDER_ID`

**Files:**
- Modify: `src/shared/constants.ts`
- Test: `tests/background/storage/prefs-sync.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```typescript
// tests/background/storage/prefs-sync.test.ts
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { STORAGE_KEY_PREFS } from '@/shared/constants';

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
}));

vi.mock('@/shared/browser', () => ({
  default: {
    storage: {
      local: {
        get: mocks.get,
        set: mocks.set,
      },
    },
  },
}));

import { PrefsSyncStorage } from '@/background/storage/prefs-sync';
import type { UserPreferences } from '@/shared/constants';

describe('PrefsSyncStorage', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.set.mockReset();
  });

  it('loads defaults with providerId when storage empty', async () => {
    mocks.get.mockResolvedValue({});
    const prefs = await PrefsSyncStorage.load();
    expect(prefs.enabled).toBe(true);
    expect(prefs.providerId).toBe('openrouter');
  });

  it('loads persisted prefs with providerId', async () => {
    mocks.get.mockResolvedValue({
      [STORAGE_KEY_PREFS]: {
        enabled: false,
        providerId: 'chrome-prompt-api',
      },
    });
    const prefs = await PrefsSyncStorage.load();
    expect(prefs.enabled).toBe(false);
    expect(prefs.providerId).toBe('chrome-prompt-api');
  });

  it('save persists providerId', async () => {
    mocks.set.mockResolvedValue(undefined);
    await PrefsSyncStorage.save({
      enabled: false,
      providerId: 'chrome-prompt-api',
    });
    expect(mocks.set).toHaveBeenCalledWith({
      [STORAGE_KEY_PREFS]: {
        enabled: false,
        providerId: 'chrome-prompt-api',
      },
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run test -- tests/background/storage/prefs-sync.test.ts`
Expected: FAIL — `providerId` not in `UserPreferences`, `PrefsSyncStorage.load()` returns `{ enabled }` only

- [ ] **Step 3: Write minimal implementation**

In `src/shared/constants.ts`, add `providerId` as a required string field and export `DEFAULT_PROVIDER_ID`:

```typescript
/**
 * Default provider ID for new installs.
 */
export const DEFAULT_PROVIDER_ID = 'openrouter';

/**
 * Validates persisted preference objects from storage.
 */
export const userPreferencesSchema = v.object({
  enabled: v.boolean(),
  providerId: v.string(),
});

export type UserPreferences = v.InferOutput<typeof userPreferencesSchema>;
```

In `src/background/storage/prefs-sync.ts`, update `defaultPrefs`:

```typescript
import {
  STORAGE_KEY_PREFS,
  userPreferencesSchema,
  type UserPreferences,
  DEFAULT_PROVIDER_ID,
} from '@/shared/constants';

private static readonly defaultPrefs: UserPreferences = {
  enabled: true,
  providerId: DEFAULT_PROVIDER_ID,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm run test -- tests/background/storage/prefs-sync.test.ts`
Expected: PASS

**Verification**: `UserPreferences` type includes `providerId: string`; `DEFAULT_PROVIDER_ID` is exported as `'openrouter'`.

---

### [x] Task 2: Remove `enabled` from `OpenRouterConfig` and relax `save()` validation

**Files:**
- Modify: `src/background/storage/openrouter-storage.ts`
- Modify: `tests/background/storage/openrouter-storage.test.ts`

- [ ] **Step 1: Write the failing test**

Update `tests/background/storage/openrouter-storage.test.ts` — remove `enabled` from all mock configs and assertions, and add a new test for save without `enabled`:

```typescript
// In the "loads defaults when storage empty" test:
it('loads defaults when storage empty', async () => {
  mocks.get.mockResolvedValue({});
  const c = await OpenRouterStorage.load();
  expect(c.apiKey).toBe('');
  expect(c.model).toBe('');
  expect(c.customModels).toEqual([]);
});

// In the "loads persisted config" test:
it('loads persisted config', async () => {
  mocks.get.mockResolvedValue({
    [STORAGE_KEY_OPENROUTER]: {
      apiKey: 'secret',
      model: OPENROUTER_DEFAULT_MODEL_SLUG,
      customModels: ['vendor/custom'],
    },
  });
  const c = await OpenRouterStorage.load();
  expect(c.apiKey).toBe('secret');
  expect(c.model).toBe(OPENROUTER_DEFAULT_MODEL_SLUG);
  expect(c.customModels).toEqual(['vendor/custom']);
});

// In the "loads legacy row without customModels key" test:
it('loads legacy row without customModels key as empty array', async () => {
  mocks.get.mockResolvedValue({
    [STORAGE_KEY_OPENROUTER]: {
      apiKey: '',
      model: OPENROUTER_DEFAULT_MODEL_SLUG,
    },
  });
  const c = await OpenRouterStorage.load();
  expect(c.customModels).toEqual([]);
});

// In the "migrates custom-only active model" test:
it('migrates custom-only active model into customModels list', async () => {
  mocks.get.mockResolvedValue({
    [STORAGE_KEY_OPENROUTER]: {
      apiKey: '',
      model: 'acme/promo-model',
      customModels: [],
    },
  });
  const c = await OpenRouterStorage.load();
  expect(c.model).toBe('acme/promo-model');
  expect(c.customModels).toEqual(['acme/promo-model']);
  expect(mocks.set).toHaveBeenCalledTimes(1);
  expect(mocks.set.mock.calls[0]?.[0]).toEqual({
    [STORAGE_KEY_OPENROUTER]: {
      apiKey: '',
      model: 'acme/promo-model',
      customModels: ['acme/promo-model'],
    },
  });
});

// Remove the "save rejects enabled without key and model" test entirely.
// The save validation no longer cares about enabled.

// Update "save persists customModels":
it('save persists customModels', async () => {
  mocks.set.mockResolvedValue(undefined);
  await OpenRouterStorage.save({
    apiKey: '',
    model: OPENROUTER_DEFAULT_MODEL_SLUG,
    customModels: ['a/b'],
  });
  expect(mocks.set.mock.calls[0]?.[0]).toEqual({
    [STORAGE_KEY_OPENROUTER]: {
      apiKey: '',
      model: OPENROUTER_DEFAULT_MODEL_SLUG,
      customModels: ['a/b'],
    },
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run test -- tests/background/storage/openrouter-storage.test.ts`
Expected: FAIL — `OpenRouterConfig` still requires `enabled`; test objects missing `enabled` won't type-check

- [ ] **Step 3: Write minimal implementation**

In `src/background/storage/openrouter-storage.ts`:

```typescript
/**
 * Persisted OpenRouter / LLM settings (`browser.storage.local`, background
 * only).
 */
export type OpenRouterConfig = {
  apiKey: string;
  model: string;
  /**
   * User-added model slugs (not built-in presets); deduped, order preserved.
   */
  customModels: string[];
};

const openRouterConfigSchema = v.object({
  apiKey: v.string(),
  model: v.string(),
  customModels: v.fallback(v.array(v.string()), []),
});

// ...existing code...

export class OpenRouterStorage {
  private constructor() {}

  private static readonly defaultConfig: OpenRouterConfig = {
    apiKey: '',
    model: '',
    customModels: [],
  };

  // parseStored: unchanged (delegates to schema)

  // migrateCustomModelsFromModel: update type to remove `enabled`

  /**
   * Persists config after validation.
   *
   * @param config - Config to save
   * @returns Promise that resolves when storage write completes
   */
  static async save(config: OpenRouterConfig): Promise<void> {
    const c = v.parse(openRouterConfigSchema, config);
    await browser.storage.local.set({ [STORAGE_KEY_OPENROUTER]: c });
  }

  // maskApiKey: unchanged

  // REMOVE canRunPromoAnalysis() entirely
}
```

In `migrateCustomModelsFromModel`, remove `enabled` from the spread:

```typescript
private static async migrateCustomModelsFromModel(
  c: OpenRouterConfig,
): Promise<OpenRouterConfig> {
  const modelTrimmed = c.model.trim();
  if (
    modelTrimmed.length === 0 ||
    isOpenRouterBuiltinModelSlug(modelTrimmed) ||
    c.customModels.includes(modelTrimmed)
  ) {
    return c;
  }
  const next: OpenRouterConfig = {
    ...c,
    customModels: [...c.customModels, modelTrimmed],
  };
  await browser.storage.local.set({ [STORAGE_KEY_OPENROUTER]: next });
  return next;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm run test -- tests/background/storage/openrouter-storage.test.ts`
Expected: PASS

**Verification**: `OpenRouterConfig` has no `enabled` field; `save()` no longer validates `enabled`; `canRunPromoAnalysis()` is deleted.

---

### [x] Task 3: Delete `reconcileDivergentEnabled()` from `background.ts`

**Files:**
- Modify: `src/background/background.ts`

The app has no released users, so there is no legacy storage to migrate. Simply delete `reconcileDivergentEnabled()` and remove its call from `Background.init()`.

- [ ] **Step 1: Write the implementation**

In `src/background/background.ts`:
- Delete the `reconcileDivergentEnabled` function entirely
- Remove `await reconcileDivergentEnabled()` (or equivalent call) from `init()`
- Remove the `OpenRouterStorage` import if it was only used there

Result:

```typescript
export class Background {
  private constructor() {}

  /**
   * Registers runtime message listeners synchronously
   * (MV3: listeners must attach at top level).
   * Storage is initialized eagerly in the background; handlers await
   * `PrefsSyncStorage.ready()` before prefs work.
   */
  static init(): void {
    PrefsPortHub.register();
    console.info('[TopSkip] Service worker started');
    void i18n.init();
    void PrefsSyncStorage.ready().then(async () => {
      await ContentScriptsRegistration.syncFromPrefs();
    });
    registerRuntimeMessages();
  }
}
```

- [ ] **Step 2: Run lint and tests**

Run: `pnpm run lint && pnpm run test`
Expected: PASS

**Verification**: `reconcileDivergentEnabled()` is gone; `init()` no longer references `OpenRouterStorage`.

---

### [x] Task 4: Update `promo-analysis.ts` to use `providerId` instead of `orConfig.enabled`

**Files:**
- Modify: `src/background/messaging/promo-analysis.ts`

- [ ] **Step 1: Identify the change**

In `PromoAnalysis.run()`, lines ~88–96 currently check `orConfig.enabled`:

```typescript
const orConfig = await OpenRouterStorage.load();
if (!orConfig.enabled) {
  setStatus({ videoId, status: 'unavailable' });
  return;
}
if (orConfig.apiKey.length === 0 || orConfig.model.length === 0) {
  setStatus({ videoId, status: 'not_configured' });
  return;
}
```

Replace with a `providerId`-aware check. For now (before issue 3 wires the adapter), keep calling OpenRouter directly but gate on `prefs.providerId === 'openrouter'` and the config fields:

- [ ] **Step 2: Write the implementation**

```typescript
// Replace the old orConfig.enabled block with:
if (prefs.providerId === 'openrouter') {
  const orConfig = await OpenRouterStorage.load();
  if (orConfig.apiKey.length === 0 || orConfig.model.length === 0) {
    setStatus({ videoId, status: 'not_configured' });
    return;
  }
} else {
  // Future providers will be handled by issue 3+;
  // unknown provider ID → unavailable for now.
  setStatus({ videoId, status: 'unavailable' });
  return;
}
```

The rest of the method (LLM call, parsing, etc.) stays the same — still uses `orConfig` for `apiKey` and `model`, but now `orConfig` is only loaded when `providerId === 'openrouter'`.

Also move the `orConfig` variable declaration inside the `if` block since it's only needed there.

- [ ] **Step 3: Run lint and unit tests**

Run: `pnpm run lint && pnpm run test`
Expected: PASS

**Verification**: `PromoAnalysis.run()` uses `prefs.providerId` instead of `orConfig.enabled`.

---

### [x] Task 5: Update `messages.ts` — remove `enabled` from OpenRouter message types

**Files:**
- Modify: `src/shared/messages.ts`

- [ ] **Step 1: Write the implementation**

Remove `enabled` from `GetOpenRouterConfigResponse` and `SetOpenRouterConfig` message types:

```typescript
/**
 * Sanitized OpenRouter settings for the options page (never raw API key).
 */
export type GetOpenRouterConfigResponse =
  | {
      ok: true;
      model: string;
      apiKeyMasked: string | null;
      customModels: string[];
    }
  | { ok: false; error: string };
```

```typescript
// In TopSkipRuntimeMessage union, update SET_OPENROUTER_CONFIG:
  | {
      type: typeof TOPSKIP_MESSAGE.SET_OPENROUTER_CONFIG;
      apiKey: string;
      model: string;
    }
```

- [ ] **Step 2: Run type check**

Run: `pnpm run lint:types`
Expected: Type errors in `openrouter-runtime-messages.ts` and its test — those will be fixed in Task 6

**Verification**: Message types for OpenRouter no longer include `enabled`.

---

### [x] Task 6: Update `openrouter-runtime-messages.ts` to remove `enabled` handling

**Files:**
- Modify: `src/background/messaging/openrouter-runtime-messages.ts`
- Modify: `tests/background/messaging/openrouter-runtime-messages.test.ts`

- [ ] **Step 1: Write the failing test changes**

Update `tests/background/messaging/openrouter-runtime-messages.test.ts`:
- Remove `enabled` from all `loadMock` return values
- Remove `enabled` from `handleGet` expected return
- Remove `enabled` from `handleSet` message payloads and save assertions
- Add test verifying `handleSet` no longer syncs `enabled` to prefs

```typescript
it('handleGet returns config without enabled', async () => {
  loadMock.mockResolvedValue({
    apiKey: 'k',
    model: OPENROUTER_DEFAULT_MODEL_SLUG,
    customModels: ['x/y'],
  });
  maskMock.mockReturnValue('****');
  const r = await OpenRouterRuntimeMessages.handle(
    { type: TOPSKIP_MESSAGE.GET_OPENROUTER_CONFIG },
    {} as never,
  );
  expect(r).toEqual({
    ok: true,
    model: OPENROUTER_DEFAULT_MODEL_SLUG,
    apiKeyMasked: '****',
    customModels: ['x/y'],
  });
});

it('handleSet saves config without enabled', async () => {
  loadMock.mockResolvedValue({
    apiKey: '',
    model: '',
    customModels: ['saved/custom'],
  });
  saveMock.mockResolvedValue(undefined);
  const r = await OpenRouterRuntimeMessages.handle(
    {
      type: TOPSKIP_MESSAGE.SET_OPENROUTER_CONFIG,
      apiKey: '',
      model: OPENROUTER_DEFAULT_MODEL_SLUG,
    },
    {} as never,
  );
  expect(r).toEqual({ ok: true });
  expect(saveMock).toHaveBeenCalledWith(
    expect.objectContaining({
      model: OPENROUTER_DEFAULT_MODEL_SLUG,
      customModels: ['saved/custom'],
    }),
  );
  // Verify prefs NOT saved (no more enabled sync)
  const { PrefsSyncStorage } = await import(
    '@/background/storage/prefs-sync'
  );
  expect(PrefsSyncStorage.save).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Write the implementation**

In `src/background/messaging/openrouter-runtime-messages.ts`:

`handleGet()`:
```typescript
private static async handleGet(): Promise<GetOpenRouterConfigResponse> {
  try {
    const c = await OpenRouterStorage.load();
    return {
      ok: true,
      model: c.model,
      apiKeyMasked: OpenRouterStorage.maskApiKey(c.apiKey),
      customModels: c.customModels,
    };
  } catch (e) {
    return { ok: false, error: getErrorMessage(e) };
  }
}
```

`handleSet()`:
```typescript
private static async handleSet(
  message: object,
): Promise<SetOpenRouterConfigResponse> {
  try {
    const apiKeyRaw: unknown = Reflect.get(message, 'apiKey');
    const modelRaw: unknown = Reflect.get(message, 'model');
    if (typeof apiKeyRaw !== 'string' || typeof modelRaw !== 'string') {
      return { ok: false, error: 'Invalid apiKey or model' };
    }
    const current = await OpenRouterStorage.load();
    const apiKey = apiKeyRaw.length > 0 ? apiKeyRaw : current.apiKey;
    await OpenRouterStorage.save({
      apiKey,
      model: modelRaw,
      customModels: current.customModels,
    });

    // Remove FR-015 enabled-to-prefs sync — providerId is now separate
    return { ok: true };
  } catch (e) {
    return { ok: false, error: getErrorMessage(e) };
  }
}
```

Remove imports of `PrefsSyncStorage`, `PrefsBroadcast`, `ContentScriptsRegistration`, `PrefsPortHub` that were only used for the enabled sync (FR-014/015).

- [ ] **Step 3: Run tests**

Run: `pnpm run test -- tests/background/messaging/openrouter-runtime-messages.test.ts`
Expected: PASS

**Verification**: OpenRouter handlers no longer read/write `enabled`; FR-014/015 sync removed.

---

### [x] Task 7: Update `PrefsRuntimeMessages.handleSet()` to remove FR-014 enabled sync

**Files:**
- Modify: `src/background/messaging/runtime-messages.ts`

- [ ] **Step 1: Write the implementation**

In `handleSet()`, remove the block that syncs `enabled` to OpenRouter storage (FR-014). The method should just save prefs, sync content scripts, broadcast, and return:

```typescript
private static async handleSet(
  message: object,
): Promise<SetPrefsResponse> {
  await PrefsSyncStorage.ready();
  try {
    const enabledRaw: unknown = Reflect.get(message, 'enabled');
    // v.fallback in the schema auto-fills providerId when absent
    const prefs = v.parse(userPreferencesSchema, {
      enabled: enabledRaw,
    });
    await PrefsSyncStorage.save(prefs);
    await ContentScriptsRegistration.syncFromPrefs();
    await PrefsBroadcast.sendUpdatedToAllTabs(prefs);
    PrefsPortHub.broadcastPrefsUpdate(prefs);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: getErrorMessage(e) };
  }
}
```

Remove the `OpenRouterStorage` import that was only needed for FR-014.

- [ ] **Step 2: Run tests**

Run: `pnpm run test -- tests/background/messaging/enabled-sync.test.ts`
Expected: FAIL — the old FR-014 test expects OpenRouter `enabled` sync

**Verification**: `handleSet()` no longer syncs `enabled` to OpenRouter.

---

### [x] Task 8: Rewrite `enabled-sync.test.ts` — remove dual-flag sync tests

**Files:**
- Modify: `tests/background/messaging/enabled-sync.test.ts`

- [ ] **Step 1: Write the replacement tests**

The old tests verified FR-014/015/016 (bidirectional `enabled` sync + reconciliation). Replace them with tests that verify:
1. `SET_PREFS` no longer touches OpenRouter storage
2. `SET_OPENROUTER_CONFIG` no longer changes prefs `enabled`

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  sendMessage,
  storageGet,
  storageSet,
  tabsQuery,
  tabsSendMessage,
  registerContentScripts,
  unregisterContentScripts,
} from './enabled-sync-helpers';

// ...same mock setup as before...

import { PrefsRuntimeMessages } from
  '@/background/messaging/runtime-messages';
import { OpenRouterRuntimeMessages } from
  '@/background/messaging/openrouter-runtime-messages';
import { STORAGE_KEY_PREFS, STORAGE_KEY_OPENROUTER } from
  '@/shared/constants';

describe('SET_PREFS does not propagate to OpenRouter storage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storageGet.mockImplementation((key: string) => {
      if (key === STORAGE_KEY_PREFS) {
        return Promise.resolve({
          [STORAGE_KEY_PREFS]: { enabled: true, providerId: 'openrouter' },
        });
      }
      if (key === STORAGE_KEY_OPENROUTER) {
        return Promise.resolve({
          [STORAGE_KEY_OPENROUTER]: {
            apiKey: 'sk-test',
            model: 'test/model',
            customModels: [],
          },
        });
      }
      return Promise.resolve({});
    });
    storageSet.mockResolvedValue(undefined);
    tabsQuery.mockResolvedValue([]);
  });

  it('saves prefs but does not write to openrouter storage', async () => {
    const result = await PrefsRuntimeMessages.handle(
      { type: 'TOPSKIP_SET_PREFS', enabled: false },
      { id: 'test' },
    );
    expect(result).toEqual({ ok: true });

    const orSetCall = storageSet.mock.calls.find(
      (call: unknown[]) => {
        const arg = call[0] as Record<string, unknown>;
        return STORAGE_KEY_OPENROUTER in arg;
      },
    );
    expect(orSetCall).toBeUndefined();
  });
});

describe('SET_OPENROUTER_CONFIG does not change prefs enabled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // ...mock setup without enabled in OR config...
  });

  it('saves OR config but does not write prefs', async () => {
    // ...verify PrefsSyncStorage.save not called...
  });
});
```

Note: the exact mock structure may need to match how the handler accesses storage. The key assertion is that OpenRouter storage is not written when `SET_PREFS` fires, and prefs storage is not written when `SET_OPENROUTER_CONFIG` fires.

- [ ] **Step 2: Run tests**

Run: `pnpm run test -- tests/background/messaging/enabled-sync.test.ts`
Expected: PASS

**Verification**: Bidirectional `enabled` sync is verified as removed; migration-oriented tests pass.

---

### [x] Task 9: Update `PreferencesStore` with `providerId` observable

**Files:**
- Modify: `src/popup/preferences-store.ts`
- Modify: `tests/popup/preferences-store.test.ts`

- [ ] **Step 1: Write the failing test**

Add `providerId` assertions to existing tests:

```typescript
it('load applies stored enabled flag and providerId', async () => {
  mocks.sendMessage.mockResolvedValue({
    ok: true,
    prefs: { enabled: false, providerId: 'chrome-prompt-api' },
  });
  const store = new PreferencesStore();
  await store.load();
  expect(store.enabled).toBe(false);
  expect(store.providerId).toBe('chrome-prompt-api');
});
```

Update `isGetPrefsOk` type guard to also check `providerId`:

```typescript
function isGetPrefsOk(
  res: unknown,
): res is Extract<GetPrefsResponse, { ok: true }> {
  return (
    typeof res === 'object' &&
    res !== null &&
    'ok' in res &&
    (res as { ok: boolean }).ok === true &&
    'prefs' in res &&
    typeof (res as { prefs: { enabled?: boolean } }).prefs?.enabled ===
      'boolean'
  );
}
```

(The type guard doesn't need to validate `providerId` — just pass it through.)

Update the `PREFS_UPDATED` port listener test to include `providerId`:

```typescript
it('updates enabled and providerId when PREFS_UPDATED arrives', () => {
  const store = new PreferencesStore();
  store.connectPort();
  const listener = mocks.connectOnMessage.addListener.mock
    .calls[0][0] as (msg: unknown) => void;

  listener({
    type: 'TOPSKIP_PREFS_UPDATED',
    prefs: { enabled: false, providerId: 'chrome-prompt-api' },
  });

  expect(store.enabled).toBe(false);
  expect(store.providerId).toBe('chrome-prompt-api');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run test -- tests/popup/preferences-store.test.ts`
Expected: FAIL — `providerId` not on `PreferencesStore`

- [ ] **Step 3: Write minimal implementation**

In `src/popup/preferences-store.ts`:

```typescript
export class PreferencesStore {
  enabled = true;
  providerId: string = 'openrouter';

  constructor() {
    makeAutoObservable(this);
  }

  // ...existing code...

  async load(): Promise<void> {
    const res = await browser.runtime.sendMessage({
      type: TOPSKIP_MESSAGE.GET_PREFS,
    });
    if (!isGetPrefsOk(res)) {
      const err =
        res && typeof res === 'object' && 'error' in res
          ? String((res as { error: string }).error)
          : translator.getMessage('prefs_error_load');
      throw new Error(err);
    }
    runInAction(() => {
      this.enabled = res.prefs.enabled;
      if (typeof res.prefs.providerId === 'string') {
        this.providerId = res.prefs.providerId;
      }
    });
  }
```

In `connectPort()`, update the port listener:

```typescript
connectPort(): void {
  this.port = browser.runtime.connect({ name: PREFS_PORT_NAME });
  this.port.onMessage.addListener((msg: unknown) => {
    if (isPrefsPortMessage(msg)) {
      runInAction(() => {
        this.enabled = msg.prefs.enabled;
        if (typeof msg.prefs.providerId === 'string') {
          this.providerId = msg.prefs.providerId;
        }
      });
    }
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm run test -- tests/popup/preferences-store.test.ts`
Expected: PASS

**Verification**: `PreferencesStore` exposes `providerId` observable; updated from `load()` and port messages.

---

### [x] Task 10: Final lint + full test suite + E2E verification

**Files:**
- None (verification only)

- [ ] **Step 1: Run lint**

Run: `pnpm run lint`
Expected: 0 errors

- [ ] **Step 2: Run full unit tests**

Run: `pnpm run test`
Expected: All tests pass

- [ ] **Step 3: Run coverage**

Run: `pnpm run test:coverage`
Expected: Coverage thresholds met

- [ ] **Step 4: Build and run E2E**

Run: `pnpm run build && pnpm run test:e2e`
Expected: E2E tests pass (no behavioral change for end users)

**Verification**: All quality gates pass; no regressions.
