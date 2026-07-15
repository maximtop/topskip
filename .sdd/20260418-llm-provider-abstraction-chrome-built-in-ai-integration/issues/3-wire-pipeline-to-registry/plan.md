# Implementation Plan: Wire `PromoAnalysis` pipeline to resolve adapter from registry

**Created**: 2026-04-17
**Status**: Validated
**Issue**: `.sdd/.current/issues/3-wire-pipeline-to-registry/issue.md`
**PRD**: `.sdd/.current/prd.md`
**Model**: Qwen3.6 Plus via OpenRouter (standard)
**User Input**: None

## Summary

Refactor `src/background/messaging/promo-analysis.ts` to resolve the active provider adapter from `ProviderRegistry` (created in issue 1) and use `providerId` from prefs (created in issue 2) instead of directly calling `callOpenRouterChat()` + `OpenRouterStorage.load()`. The `OpenRouterAdapter` (already created in issue 1) becomes the sole path for OpenRouter analysis. The `defaultRegistry` is wired into `Background.init()`. The log bundle gains `providerId` for traceability.

## Technical Context

**Language/Version**: TypeScript 5.x strict, ESM
**Primary Dependencies**: `webextension-polyfill`, `valibot`
**Storage**: `browser.storage.local` (prefs + OpenRouter config)
**Testing**: Vitest 4.x (`vi.hoisted()` + `vi.mock()` pattern)
**Target Platform**: Chrome MV3 service worker

## Research

### Current PromoAnalysis architecture

`prom-analysis.ts` currently:
1. Imports `callOpenRouterChat`, `parseLlmPromoResponse`, `OpenRouterStorage` directly.
2. `run()` loads prefs → checks `prefs.enabled` → loads OR config → checks `apiKey/model` → calls `callOpenRouterChat()`.
3. The `prefs.providerId === 'openrouter'` guard was added in issue 2; other providerIds currently fall through to `status: 'unavailable'`.

### Issue 1 artifacts (already done)

- `src/background/providers/llm-provider-adapter.ts` — `LlmProviderAdapter` interface, `ProviderAvailability`, `AnalyzeTranscriptParams`, `AnalyzeTranscriptResult`, `ProviderMeta` types.
- `src/background/providers/provider-registry.ts` — `ProviderRegistry` class with `get()` / `getAll()`.
- `src/background/providers/openrouter-adapter.ts` — `OpenRouterAdapter` implementing the interface.
- `src/background/providers/default-registry.ts` — `defaultRegistry` singleton with OpenRouter adapter only.

### Current build-globals.d.ts

`src/build-globals.d.ts` exposes `__TOPSKIP_PROVIDER_MODULE__` which controls the `import.meta.resolve`-style resolution for the OpenRouter adapter module (used as a build-time constant).

### Log bundle

`buildPromoAnalysisLogBundle()` currently takes `model: string` and includes `openRouterModel: ...` in the output. It will gain `providerId` and the header label will become provider-agnostic.

## Entities

### PromoAnalysisPipeline

- **Current**: Static class with `onCaptionsReady()` / `run()`
- **Change**: `run()` now receives the `ProviderRegistry` instance (injected parameter) and reads `providerId` from `PrefsSyncStorage`.
- **Validation**: If `registry.get(providerId)` returns `undefined` or `adapter.availability() === 'unavailable'`, status → `not_configured`.

### Log Bundle

- **Current**: Provider-specific (`openRouterModel` field)
- **Change**: Add `providerId` param → output becomes `provider: <id>`, `model: <model>`.

## Contracts

N/A — no new API endpoints. Internal interface (`LlmProviderAdapter`) and registry were created in issue 1.

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/background/messaging/promo-analysis.ts` | Modify | Replace direct OpenRouter imports with `ProviderRegistry` usage |
| `src/background/openrouter/log-promo-analysis.ts` | Modify | Add `providerId` field to log bundle |
| `src/background/messaging/register-runtime-messages.ts` | Modify | Pass `defaultRegistry` into `CaptionRuntimeMessages` / `PromoAnalysis` |
| `src/background/background.ts` | Modify | Set up `defaultRegistry` for `registerRuntimeMessages` |
| `tests/background/messaging/promo-analysis.test.ts` | Create | Pipeline routing tests with mock adapters |
| `tests/background/openrouter/log-promo-analysis.test.ts` | Modify | Add `providerId` assertion if tests exist |

## Tasks

### [ ] Task 1: Write failing test — pipeline calls adapter from registry

**Files:**
- Test: `tests/background/messaging/promo-analysis.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmProviderAdapter } from
  '@/background/providers/llm-provider-adapter';
import { PROVIDER_AVAILABILITY } from
  '@/background/providers/llm-provider-adapter';

vi.mock('@/shared/browser', () => ({
  default: {
    runtime: {
      onMessage: { addListener: vi.fn() },
      sendMessage: vi.fn(),
    },
    storage: {
      local: {
        get: vi.fn(),
        set: vi.fn(),
      },
    },
  },
}));

vi.mock('@/background/storage/prefs-sync', () => ({
  PrefsSyncStorage: {
    ready: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue({
      enabled: true,
      providerId: 'openrouter',
    }),
  },
}));

vi.mock('@/background/promo-detection-store', () => ({
  PromoDetectionStore: { set: vi.fn() },
}));

vi.mock('@/background/openrouter/log-promo-analysis', () => ({
  LogPromoAnalysis: { logAnalysisBundle: vi.fn() },
  buildPromoAnalysisLogBundle: vi.fn().mockReturnValue('log bundle'),
}));

vi.mock('@/background/providers/default-registry', () => ({
  defaultRegistry: {} as unknown,
}));

import { PromoAnalysis } from '@/background/messaging/promo-analysis';
import browser from '@/shared/browser';
import { PrefsSyncStorage } from '@/background/storage/prefs-sync';
import { PromoDetectionStore } from '@/background/promo-detection-store';

const mockAdapter: LlmProviderAdapter = {
  id: 'openrouter',
  displayName: 'TestAdapter',
  availability: vi.fn().mockResolvedValue(PROVIDER_AVAILABILITY.Available),
  analyzeTranscript: vi.fn().mockResolvedValue({
    ok: true,
    hasPromo: false,
    providerMeta: { id: 'openrouter', model: 'test-model' },
  }),
};

describe('PromoAnalysis — adapter routing', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    (browser.storage.local.get as ReturnType<typeof vi.fn>).mockResolvedValue({});
  });

  afterEach(() => {
    (PromoAnalysis as Record<string, unknown>).inflight?.clear?.();
  });

  it('resolves adapter from registry and calls analyzeTranscript', async () => {
    (browser.storage.local.get as ReturnType<typeof vi.fn>)
      .mockResolvedValue({
        'topskip:prefs': { enabled: true, providerId: 'openrouter' },
      });
    (PrefsSyncStorage.ready as ReturnType<typeof vi.fn>)
      .mockResolvedValue(undefined);
    (PrefsSyncStorage.load as ReturnType<typeof vi.fn>)
      .mockResolvedValue({ enabled: true, providerId: 'openrouter' });

    const registry = (await import(
      '@/background/providers/default-registry'
    )).defaultRegistry as Record<string, unknown>;
    (registry as Record<string, unknown>).get = vi.fn().mockReturnValue(mockAdapter);

    const sender = { tab: { id: 1 } } as Parameters<
      typeof PromoAnalysis.onCaptionsReady
    >[0];
    const payload = {
      ok: true as const,
      videoId: 'abc123',
      languageCode: 'en',
      segments: [{ startSec: 0, durationSec: 10, text: 'Hello world' }],
    };

    PromoAnalysis.onCaptionsReady(sender, payload);
    await vi.waitFor(
      () =>
        expect(mockAdapter.analyzeTranscript).toHaveBeenCalledWith(
          expect.objectContaining({
            transcript: expect.any(String),
            videoId: 'abc123',
          }),
        ),
      { timeout: 5000 },
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm run test -- tests/background/messaging/promo-analysis.test.ts`
Expected: FAIL — `analyzeTranscript` was not called (pipeline still uses direct OpenRouter imports).

- [ ] **Step 3: Implement adapter routing in promo-analysis.ts**

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm run test -- tests/background/messaging/promo-analysis.test.ts`
Expected: PASS

**Verification**: `PromoAnalysis.run()` resolves the adapter from a registry and calls `analyzeTranscript()` instead of `callOpenRouterChat()` directly.

### [ ] Task 2: Remove direct OpenRouter imports from promo-analysis.ts

**Files:**
- Modify: `src/background/messaging/promo-analysis.ts`

- [ ] **Step 1: Replace direct imports**

Remove these imports from `promo-analysis.ts`:
```typescript
import { callOpenRouterChat } from '@/background/openrouter/openrouter-client';
import { parseLlmPromoResponse } from '@/background/openrouter/parse-llm-promo-response';
import { OpenRouterStorage } from '@/background/storage/openrouter-storage';
```

- [ ] **Step 2: Rewrite `run()` to use adapter**

Replace the OpenRouter-specific flow inside `run()`:
- After `prefs.enabled` check, resolve adapter via `registry.get(prefs.providerId)`
- If adapter is `undefined` or `availability() === 'unavailable'`, set `status: 'not_configured'` and return
- Build transcript, set `status: 'analyzing'`
- Call `adapter.analyzeTranscript({ transcript: merged.text, videoId, languageCode, durationSec: 0, signal: abort.signal })` — `durationSec: 0` is correct per current `PromoBlock` parsing; the adapter handles clamping.
- On result: handle `ok: true, hasPromo: false`, `ok: true, hasPromo: true, blocks`, `ok: false, error` cases

```typescript
// After prefs.enabled guard:
const adapter = registry.get(prefs.providerId);
if (!adapter) {
  setStatus({ videoId, status: 'not_configured' });
  return;
}

const avail = await adapter.availability();
if (avail === 'unavailable') {
  setStatus({ videoId, status: 'not_configured' });
  return;
}

// ... transcript building ...

const result = await adapter.analyzeTranscript({
  transcript: merged.text,
  videoId,
  languageCode,
  durationSec: 0,
  signal: abort.signal,
});
```

- [ ] **Step 3: Remove `orConfig` references**

Delete the `const orConfig = await OpenRouterStorage.load();` block and the `prefs.providerId === 'openrouter'` conditional. The adapter handles config loading internally.

- [ ] **Step 4: Run lint to verify**

Run: `pnpm run lint:types`
Expected: PASS (no references to deleted imports)

**Verification**: `promo-analysis.ts` has no direct imports of `callOpenRouterChat`, `OpenRouterStorage`, or `parseLlmPromoResponse`.

### [ ] Task 3: Add `providerId` to log bundle

**Files:**
- Modify: `src/background/openrouter/log-promo-analysis.ts`

- [ ] **Step 1: Add `providerId` param to buildPromoAnalysisLogBundle**

Update the function signature and output:
```typescript
export function buildPromoAnalysisLogBundle(params: {
  providerId: string;
  // ... existing params ...
  model: string;  // keep, rename conceptually to "model"
  // ...
}): string {
  // In the output header, change "openRouterModel:" to:
  // `provider: ${params.providerId}`
  // `model: ${params.model}`
}
```

- [ ] **Step 2: Update callers in promo-analysis.ts**

Each `buildPromoAnalysisLogBundle` call now includes `providerId: prefs.providerId` (store `providerId` in a local variable before the async adapter call).

- [ ] **Step 3: Run test**

Run: `pnpm run test`
Expected: All tests pass

**Verification**: Log bundles include `provider: openrouter` in the output.

### [ ] Task 4: Wire defaultRegistry into Background.init and registerRuntimeMessages

**Files:**
- Modify: `src/background/messaging/register-runtime-messages.ts`
- Modify: `src/background/background.ts`

- [ ] **Step 1: Pass registry into registerRuntimeMessages**

Update `registerRuntimeMessages` to accept the registry:
```typescript
export function registerRuntimeMessages(registry: ProviderRegistry): void {
  // Pass registry to CaptionRuntimeMessages or make it a module-level set
}
```

- [ ] **Step 2: Update Background.init()**

```typescript
import { defaultRegistry } from '@/background/providers/default-registry';
// ...
static init(): void {
  PrefsPortHub.register();
  console.info('[TopSkip] Service worker started');
  void i18n.init();
  void PrefsSyncStorage.ready().then(async () => {
    await ContentScriptsRegistration.syncFromPrefs();
  });
  registerRuntimeMessages(defaultRegistry);
}
```

- [ ] **Step 3: Run lint**

Run: `pnpm run lint`
Expected: PASS

**Verification**: `defaultRegistry` is passed into `registerRuntimeMessages` at init time.

### [ ] Task 5: Pipeline resolves adapter for each run, not cached

**Files:**
- Modify: `src/background/messaging/promo-analysis.ts`

- [ ] **Step 1: Ensure adapter is resolved fresh per run**

The `run()` method should call `registry.get(prefs.providerId)` inside the method body (after reading prefs), not cache the adapter at module level. This ensures provider switches take effect on the next video.

- [ ] **Step 2: Run full test suite**

Run: `pnpm run test`
Expected: All pass

**Verification**: Each invocation of `run()` reads the current `providerId` and resolves the adapter.

### [ ] Task 6: Test unknown providerId → not_configured

**Files:**
- Test: `tests/background/messaging/promo-analysis.test.ts`

- [ ] **Step 1: Write the test**

```typescript
it('sets status to not_configured when providerId is unknown', async () => {
  (browser.storage.local.get as ReturnType<typeof vi.fn>)
    .mockResolvedValue({
      'topskip:prefs': { enabled: true, providerId: 'unknown-provider' },
    });
  (PrefsSyncStorage.ready as ReturnType<typeof vi.fn>)
    .mockResolvedValue(undefined);
  (PrefsSyncStorage.load as ReturnType<typeof vi.fn>)
    .mockResolvedValue({ enabled: true, providerId: 'unknown-provider' });

  const registry = (await import('@/background/providers/default-registry'))
    .defaultRegistry as Record<string, unknown>;
  (registry as Record<string, unknown>).get = vi.fn().mockReturnValue(undefined);

  const setStatuss: unknown[] = [];
  (PromoDetectionStore.set as ReturnType<typeof vi.fn>).mockImplementation(
    (_tabId: number, state: unknown) => setStatuss.push(state),
  );

  const sender = { tab: { id: 2 } } as Parameters<
    typeof PromoAnalysis.onCaptionsReady
  >[0];
  const payload = {
    ok: true as const,
    videoId: 'def456',
    languageCode: 'en',
    segments: [{ startSec: 0, durationSec: 10, text: 'Test' }],
  };

  PromoAnalysis.onCaptionsReady(sender, payload);
  await vi.waitFor(
    () => expect(setStatuss.length).toBeGreaterThan(0),
    { timeout: 5000 },
  );
  expect(setStatuss).toContainEqual(
    expect.objectContaining({ videoId: 'def456', status: 'not_configured' }),
  );
});
```

- [ ] **Step 2: Run test**

Run: `pnpm run test -- tests/background/messaging/promo-analysis.test.ts`
Expected: PASS

**Verification**: Unknown provider IDs result in `not_configured` status.

### [ ] Task 7: Test adapter availability unavailable → not_configured

**Files:**
- Test: `tests/background/messaging/promo-analysis.test.ts`

- [ ] **Step 1: Write the test**

```typescript
it('sets status to not_configured when adapter is unavailable', async () => {
  const unavailableAdapter: LlmProviderAdapter = {
    id: 'openrouter',
    displayName: 'TestAdapter',
    availability: vi.fn().mockResolvedValue(PROVIDER_AVAILABILITY.Unavailable),
    analyzeTranscript: vi.fn(),
  };

  (browser.storage.local.get as ReturnType<typeof vi.fn>)
    .mockResolvedValue({
      'topskip:prefs': { enabled: true, providerId: 'openrouter' },
    });

  const registry = (await import('@/background/providers/default-registry'))
    .defaultRegistry as Record<string, unknown>;
  (registry as Record<string, unknown>).get = vi.fn()
    .mockReturnValue(unavailableAdapter);

  const setStatuss: unknown[] = [];
  (PromoDetectionStore.set as ReturnType<typeof vi.fn>).mockImplementation(
    (_tabId: number, state: unknown) => setStatuss.push(state),
  );

  const sender = { tab: { id: 3 } } as Parameters<
    typeof PromoAnalysis.onCaptionsReady
  >[0];
  const payload = {
    ok: true as const,
    videoId: 'ghi789',
    languageCode: 'en',
    segments: [{ startSec: 0, durationSec: 10, text: 'Test' }],
  };

  PromoAnalysis.onCaptionsReady(sender, payload);
  await vi.waitFor(
    () => expect(setStatuss.length).toBeGreaterThan(0),
    { timeout: 5000 },
  );
  expect(setStatuss).toContainEqual(
    expect.objectContaining({ videoId: 'ghi789', status: 'not_configured' }),
  );
});
```

- [ ] **Step 2: Run test**

Run: `pnpm run test -- tests/background/messaging/promo-analysis.test.ts`
Expected: PASS

**Verification**: Adapter with `unavailable` status results in `not_configured`.

### [ ] Task 8: Full test + lint verification

- [ ] **Step 1: Run full test suite**

Run: `pnpm run test`
Expected: All tests pass (should be 194 + new tests from tasks 1, 6, 7)

- [ ] **Step 2: Run lint**

Run: `pnpm run lint`
Expected: PASS

- [ ] **Step 3: Build**

Run: `pnpm run build`
Expected: PASS (only pre-existing bundle-size warnings)

**Verification**: All acceptance criteria for issue 3 are met.
