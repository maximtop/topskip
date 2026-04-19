# Implementation Plan: Adapter interface + registry + OpenRouter adapter wrap

**Created**: 2026-04-17
**Status**: Validated
**Issue**: `.sdd/.current/issues/1-adapter-interface/issue.md`
**PRD**: `.sdd/.current/prd.md`
**Model**: Claude Opus 4.6 (Copilot)
**User Input**: None

## Summary

Define a provider-agnostic `LlmProviderAdapter` interface, a `ProviderRegistry`
lookup table, and an `OpenRouterAdapter` that wraps the existing
`callOpenRouterChat()` + `parseLlmPromoResponse()` call path. This is a
pure additive change — no existing code is modified. The pipeline continues
calling OpenRouter directly; later issues (3, 6) swap in the adapter layer.

## Technical Context

**Language/Version**: TypeScript 5.x (strict, ESM)
**Primary Dependencies**: Valibot (schema validation), `webextension-polyfill` (browser API)
**Storage**: `browser.storage.local` (background only) — `OpenRouterStorage.load()` for config
**Testing**: Vitest 4.x; `tests/**` mirrors `src/**`; `vi.hoisted()` + `vi.mock()` for browser mocks
**Target Platform**: Chrome Manifest V3 extension (service worker)

## Research

### Existing OpenRouter call path

`PromoAnalysis.run()` in `src/background/messaging/promo-analysis.ts` performs:

1. `OpenRouterStorage.load()` → `{ enabled, apiKey, model, customModels }`
2. `mergeCaptionSegmentsToTranscript(segments, MAX_CAPTION_TRANSCRIPT_CHARS)` → `{ text, truncated }`
3. Constructs user content: `videoId=…\nlanguage=…\n\n<merged text>`
4. Calls `callOpenRouterChat({ apiKey, model, signal, messages: [{ role: 'system', content: PROMO_DETECTION_SYSTEM_PROMPT }, { role: 'user', content: userContent }] })`
5. Calls `parseLlmPromoResponse(llm.rawContent, undefined)`
6. Logs via `buildPromoAnalysisLogBundle(...)` and broadcasts to content script.

The adapter wraps steps 4 + 5 (the LLM call + response parsing) behind a
uniform interface. Steps 1–3 (config load, transcript merge, user-content
construction) stay in the pipeline and are passed to the adapter as params.

### `callOpenRouterChat` return shape

```ts
Promise<
  | { ok: true; rawContent: string; usage?: OpenRouterUsage; responseId?: string; responseModel?: string; finishReason?: string | null; nativeFinishReason?: string | null }
  | { ok: false; error: string }
>
```

### `parseLlmPromoResponse` return shape

```ts
| { ok: true; hasPromo: false }
| { ok: true; hasPromo: true; blocks: PromoBlock[] }
| { ok: false; error: string }
```

### Test patterns

- Pure-logic files (no browser deps): import directly, no mocks. Example: `tests/content/skip-logic.test.ts`.
- Files with browser deps: `vi.hoisted()` for mock refs → `vi.mock('@/shared/browser', ...)`. Example: `tests/background/storage/openrouter-storage.test.ts`.
- Files with `fetch`: `vi.stubGlobal('fetch', fetchMock)` + `vi.unstubAllGlobals()` in `afterEach`. Example: `tests/background/openrouter/openrouter-client.test.ts`.

### Existing directory structure under `src/background/`

```
src/background/
├── background.ts
├── index.ts
├── promo-detection-store.ts
├── captions/
├── lifecycle/
├── messaging/
├── openrouter/
│   ├── log-promo-analysis.ts
│   ├── openrouter-client.ts
│   ├── parse-llm-promo-response.ts
│   └── promo-detection-system-prompt.ts
└── storage/
```

`src/background/providers/` does not yet exist — it will be created by this issue.

## Entities

### LlmProviderAdapter (interface)

- **Fields**:
    - `id`: `string` — unique provider identifier (e.g. `'openrouter'`, `'chrome-prompt-api'`)
    - `displayName`: `string` — user-facing label (e.g. `'OpenRouter'`, `'Chrome Built-in'`)
- **Methods**:
    - `availability()`: `Promise<ProviderAvailability>` — whether the provider can run right now
    - `analyzeTranscript(params: AnalyzeTranscriptParams)`: `Promise<AnalyzeTranscriptResult>` — run promo detection on merged transcript
- **Relationships**: Registered in `ProviderRegistry`. Referenced by `providerId` in prefs (issue 2).

### PROVIDER_AVAILABILITY (const object) / ProviderAvailability (derived type)

- `PROVIDER_AVAILABILITY = { Available: 'available', Downloadable: 'downloadable', Downloading: 'downloading', Unavailable: 'unavailable' } as const`
- `ProviderAvailability = typeof PROVIDER_AVAILABILITY[keyof typeof PROVIDER_AVAILABILITY]`

### PROVIDER_ID (const object) / ProviderId (derived type)

- `PROVIDER_ID = { OpenRouter: 'openrouter' } as const` — extended later when Chrome Prompt API adapter is added
- `ProviderId = typeof PROVIDER_ID[keyof typeof PROVIDER_ID]`

### AnalyzeTranscriptParams (object type)

- **Fields**:
    - `transcript`: `string` — merged caption text (already trimmed/truncated by the pipeline)
    - `videoId`: `string` — YouTube video ID
    - `languageCode`: `string` — caption language (e.g. `'en'`)
    - `durationSec`: `number` — video duration in seconds (for `refinePromoBlocks` clamping)
    - `signal`: `AbortSignal | undefined` — cancellation signal from the pipeline's `AbortController`

### AnalyzeTranscriptResult (discriminated union)

- `{ ok: true; hasPromo: false }` — no promotions found
- `{ ok: true; hasPromo: true; blocks: PromoBlock[] }` — promotions detected
- `{ ok: false; error: string }` — LLM or parse failure

### ProviderMeta (object type)

- **Fields**:
    - `id`: `ProviderId` — provider ID that ran the analysis
    - `model`: `string` — model slug/name used

## Contracts

N/A — no API endpoints required.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/background/providers/llm-provider-adapter.ts` | Create | `LlmProviderAdapter` interface, `PROVIDER_AVAILABILITY`, `ProviderAvailability`, `PROVIDER_ID`, `ProviderId`, `AnalyzeTranscriptParams`, `AnalyzeTranscriptResult`, `ProviderMeta` |
| `src/background/providers/provider-registry.ts` | Create | `ProviderRegistry` static class — `register()`, `get()`, `getAll()` |
| `src/background/providers/openrouter-adapter.ts` | Create | `OpenRouterAdapter implements LlmProviderAdapter` — wraps `callOpenRouterChat` + `parseLlmPromoResponse` |
| `src/background/providers/default-registry.ts` | Create | Production singleton `defaultRegistry` with all built-in adapters |
| `tests/background/providers/provider-registry.test.ts` | Create | Registry lookup, unknown ID, enumeration |
| `tests/background/providers/openrouter-adapter.test.ts` | Create | Adapter delegates correctly; availability reflects config |

## Tasks

### [x] Task 1: Define adapter interface and shared types

**Files:**
- Create: `src/background/providers/llm-provider-adapter.ts`

- [x] **Step 1: Create the types and interface file**

```ts
import type { PromoBlock } from '@/shared/promo-types';

/**
 * Enum-like object for provider availability states.
 */
export const PROVIDER_AVAILABILITY = {
  Available: 'available',
  Downloadable: 'downloadable',
  Downloading: 'downloading',
  Unavailable: 'unavailable',
} as const;

/**
 * Whether the provider is ready to run analysis.
 */
export type ProviderAvailability =
  typeof PROVIDER_AVAILABILITY[keyof typeof PROVIDER_AVAILABILITY];

/**
 * Known provider identifiers. Extended when new adapters are added.
 */
export const PROVIDER_ID = {
  OpenRouter: 'openrouter',
} as const;

/**
 * Union of known provider ID literals.
 */
export type ProviderId = typeof PROVIDER_ID[keyof typeof PROVIDER_ID];

/**
 * Metadata about the provider that ran an analysis (for logging).
 */
export type ProviderMeta = {
  id: ProviderId;
  model: string;
};

/**
 * Input to `LlmProviderAdapter.analyzeTranscript`.
 */
export type AnalyzeTranscriptParams = {
  /** Merged caption text, already trimmed by the pipeline. */
  transcript: string;
  /** YouTube video ID. */
  videoId: string;
  /** Caption language code (e.g. `'en'`). */
  languageCode: string;
  /** Video duration in seconds; used for promo-block clamping. */
  durationSec: number;
  /** Cancellation signal from the pipeline's AbortController. */
  signal?: AbortSignal;
};

/**
 * Output of `LlmProviderAdapter.analyzeTranscript`.
 */
export type AnalyzeTranscriptResult =
  | { ok: true; hasPromo: false; providerMeta: ProviderMeta }
  | { ok: true; hasPromo: true; blocks: PromoBlock[]; providerMeta: ProviderMeta }
  | { ok: false; error: string };

/**
 * Provider-agnostic contract for LLM-backed transcript analysis.
 * Each concrete adapter owns its own prompt construction, API call,
 * response parsing, and error handling.
 */
export interface LlmProviderAdapter {
  /** Unique provider identifier stored in prefs (e.g. `'openrouter'`). */
  readonly id: string;

  /** User-facing label (e.g. `'OpenRouter'`). */
  readonly displayName: string;

  /**
   * Whether the provider can currently run analysis.
   *
   * @returns Current availability state.
   */
  availability(): Promise<ProviderAvailability>;

  /**
   * Runs promo detection on a merged transcript.
   *
   * @param params - Transcript and context for the analysis.
   * @returns Detection result or error.
   */
  analyzeTranscript(
    params: AnalyzeTranscriptParams,
  ): Promise<AnalyzeTranscriptResult>;
}
```

- [x] **Step 2: Verify lint passes**

Run: `pnpm run lint:types`
Expected: PASS — no type errors in the new file.

**Verification**: File exists at `src/background/providers/llm-provider-adapter.ts`; exports `PROVIDER_AVAILABILITY`, `ProviderAvailability`, `PROVIDER_ID`, `ProviderId`, `LlmProviderAdapter`, `AnalyzeTranscriptParams`, `AnalyzeTranscriptResult`, `ProviderMeta`.

---

### [x] Task 2: Implement ProviderRegistry with tests (TDD)

**Files:**
- Create: `tests/background/providers/provider-registry.test.ts`
- Create: `src/background/providers/provider-registry.ts`

- [x] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from 'vitest';

import {
  PROVIDER_AVAILABILITY,
  type AnalyzeTranscriptParams,
  type AnalyzeTranscriptResult,
  type LlmProviderAdapter,
  type ProviderAvailability,
} from '@/background/providers/llm-provider-adapter';
import { ProviderRegistry } from '@/background/providers/provider-registry';

/**
 * Minimal stub that satisfies the adapter interface for registry tests.
 *
 * @param id - Provider identifier.
 * @param displayName - User-facing label.
 * @returns A stub adapter.
 */
function stubAdapter(
  id: string,
  displayName: string,
): LlmProviderAdapter {
  return {
    id,
    displayName,
    availability(): Promise<ProviderAvailability> {
      return Promise.resolve(PROVIDER_AVAILABILITY.Available);
    },
    analyzeTranscript(
      _params: AnalyzeTranscriptParams,
    ): Promise<AnalyzeTranscriptResult> {
      return Promise.resolve({
        ok: true,
        hasPromo: false,
        providerMeta: { id, model: 'stub' },
      });
    },
  };
}

describe('ProviderRegistry', () => {
  it('get returns a registered adapter', () => {
    const adapter = stubAdapter('test', 'Test');
    const registry = new ProviderRegistry([adapter]);
    expect(registry.get('test')).toBe(adapter);
  });

  it('get returns undefined for an unknown id', () => {
    const registry = new ProviderRegistry([]);
    expect(registry.get('nonexistent')).toBeUndefined();
  });

  it('getAll returns all registered adapters', () => {
    const a = stubAdapter('a', 'A');
    const b = stubAdapter('b', 'B');
    const registry = new ProviderRegistry([a, b]);
    expect(registry.getAll()).toEqual([a, b]);
  });

  it('getAll returns an empty array when no adapters are registered', () => {
    const registry = new ProviderRegistry([]);
    expect(registry.getAll()).toEqual([]);
  });

  it('last adapter wins when duplicate ids are registered', () => {
    const first = stubAdapter('dup', 'First');
    const second = stubAdapter('dup', 'Second');
    const registry = new ProviderRegistry([first, second]);
    expect(registry.get('dup')).toBe(second);
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/background/providers/provider-registry.test.ts`
Expected: FAIL — `Cannot find module '@/background/providers/provider-registry'`

- [x] **Step 3: Write minimal implementation**

/**
 * Immutable lookup of registered LLM provider adapters.
 * Created once at background init; not modifiable afterward.
 */
export class ProviderRegistry {
  private readonly adapters: ReadonlyMap<string, LlmProviderAdapter>;

  /**
   * Builds a frozen registry from the given adapters.
   * If duplicate IDs are provided, the last entry wins.
   *
   * @param adapters - Adapters to register.
   */
  constructor(adapters: LlmProviderAdapter[]) {
    const map = new Map<string, LlmProviderAdapter>();
    for (const a of adapters) {
      map.set(a.id, a);
    }
    this.adapters = map;
  }

  /**
   * Looks up an adapter by its unique identifier.
   *
   * @param id - Provider identifier (e.g. `'openrouter'`).
   * @returns The adapter, or `undefined` if not registered.
   */
  get(id: string): LlmProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  /**
   * Returns all registered adapters in registration order.
   *
   * @returns Array of all adapters.
   */
  getAll(): LlmProviderAdapter[] {
    return [...this.adapters.values()];
  }
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/background/providers/provider-registry.test.ts`
Expected: PASS — all 5 tests green.

**Verification**: `ProviderRegistry` supports `get(id)` and `getAll()`; tests cover lookup hit, miss, enumeration, empty, and duplicate-id edge case.

---

### [x] Task 3: Implement OpenRouterAdapter with tests (TDD)

**Files:**
- Create: `tests/background/providers/openrouter-adapter.test.ts`
- Create: `src/background/providers/openrouter-adapter.ts`

- [x] **Step 1: Write the failing tests**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  PROVIDER_AVAILABILITY,
  PROVIDER_ID,
  type AnalyzeTranscriptParams,
} from '@/background/providers/llm-provider-adapter';

const mocks = vi.hoisted(() => ({
  callOpenRouterChat: vi.fn(),
  storageGet: vi.fn(),
  storageSet: vi.fn(),
}));

vi.mock('@/background/openrouter/openrouter-client', () => ({
  callOpenRouterChat: mocks.callOpenRouterChat,
}));

vi.mock('@/shared/browser', () => ({
  default: {
    storage: {
      local: {
        get: mocks.storageGet,
        set: mocks.storageSet,
      },
    },
  },
}));

/* Must import after mock setup so vi.mock takes effect. */
const { OpenRouterAdapter } = await import(
  '@/background/providers/openrouter-adapter'
);

const baseParams: AnalyzeTranscriptParams = {
  transcript: 'videoId=abc\nlanguage=en\n\nhello world',
  videoId: 'abc',
  languageCode: 'en',
  durationSec: 300,
};

describe('OpenRouterAdapter', () => {
  beforeEach(() => {
    mocks.callOpenRouterChat.mockReset();
    mocks.storageGet.mockReset();
    mocks.storageSet.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('properties', () => {
    it('has id matching PROVIDER_ID.OpenRouter', () => {
      const adapter = new OpenRouterAdapter();
      expect(adapter.id).toBe(PROVIDER_ID.OpenRouter);
    });

    it('has displayName "OpenRouter"', () => {
      const adapter = new OpenRouterAdapter();
      expect(adapter.displayName).toBe('OpenRouter');
    });
  });

  describe('availability', () => {
    it('returns "available" when apiKey and model are configured', async () => {
      mocks.storageGet.mockResolvedValue({
        'topskip:openrouter': {
          enabled: true,
          apiKey: 'sk-test',
          model: 'google/gemini-3.1-pro-preview',
          customModels: [],
        },
      });
      const adapter = new OpenRouterAdapter();
      expect(await adapter.availability()).toBe(PROVIDER_AVAILABILITY.Available);
    });

    it('returns "unavailable" when apiKey is empty', async () => {
      mocks.storageGet.mockResolvedValue({
        'topskip:openrouter': {
          enabled: true,
          apiKey: '',
          model: 'google/gemini-3.1-pro-preview',
          customModels: [],
        },
      });
      const adapter = new OpenRouterAdapter();
      expect(await adapter.availability()).toBe(PROVIDER_AVAILABILITY.Unavailable);
    });

    it('returns "unavailable" when model is empty', async () => {
      mocks.storageGet.mockResolvedValue({
        'topskip:openrouter': {
          enabled: true,
          apiKey: 'sk-test',
          model: '',
          customModels: [],
        },
      });
      const adapter = new OpenRouterAdapter();
      expect(await adapter.availability()).toBe(PROVIDER_AVAILABILITY.Unavailable);
    });

    it('returns "unavailable" when storage is empty', async () => {
      mocks.storageGet.mockResolvedValue({});
      const adapter = new OpenRouterAdapter();
      expect(await adapter.availability()).toBe(PROVIDER_AVAILABILITY.Unavailable);
    });
  });

  describe('analyzeTranscript', () => {
    it('delegates to callOpenRouterChat and returns parsed promo blocks', async () => {
      mocks.storageGet.mockResolvedValue({
        'topskip:openrouter': {
          enabled: true,
          apiKey: 'sk-test',
          model: 'openai/gpt-4o',
          customModels: [],
        },
      });
      mocks.callOpenRouterChat.mockResolvedValue({
        ok: true,
        rawContent: JSON.stringify({
          hasPromo: true,
          promoBlocks: [{ startSec: 10, endSec: 40 }],
        }),
      });

      const adapter = new OpenRouterAdapter();
      const result = await adapter.analyzeTranscript(baseParams);

      expect(result.ok).toBe(true);
      if (result.ok && result.hasPromo) {
        expect(result.blocks).toEqual([{ startSec: 10, endSec: 40 }]);
        expect(result.providerMeta).toEqual({
          id: PROVIDER_ID.OpenRouter,
          model: 'openai/gpt-4o',
        });
      }

      expect(mocks.callOpenRouterChat).toHaveBeenCalledWith({
        apiKey: 'sk-test',
        model: 'openai/gpt-4o',
        signal: undefined,
        messages: [
          { role: 'system', content: expect.any(String) },
          { role: 'user', content: baseParams.transcript },
        ],
      });
    });

    it('returns hasPromo false when LLM says no promo', async () => {
      mocks.storageGet.mockResolvedValue({
        'topskip:openrouter': {
          enabled: true,
          apiKey: 'sk-test',
          model: 'openai/gpt-4o',
          customModels: [],
        },
      });
      mocks.callOpenRouterChat.mockResolvedValue({
        ok: true,
        rawContent: JSON.stringify({ hasPromo: false }),
      });

      const adapter = new OpenRouterAdapter();
      const result = await adapter.analyzeTranscript(baseParams);

      expect(result).toEqual({
        ok: true,
        hasPromo: false,
        providerMeta: { id: PROVIDER_ID.OpenRouter, model: 'openai/gpt-4o' },
      });
    });

    it('returns error when callOpenRouterChat fails', async () => {
      mocks.storageGet.mockResolvedValue({
        'topskip:openrouter': {
          enabled: true,
          apiKey: 'sk-test',
          model: 'openai/gpt-4o',
          customModels: [],
        },
      });
      mocks.callOpenRouterChat.mockResolvedValue({
        ok: false,
        error: 'OpenRouter HTTP 429: rate limit',
      });

      const adapter = new OpenRouterAdapter();
      const result = await adapter.analyzeTranscript(baseParams);

      expect(result).toEqual({
        ok: false,
        error: 'OpenRouter HTTP 429: rate limit',
      });
    });

    it('returns error when parse fails', async () => {
      mocks.storageGet.mockResolvedValue({
        'topskip:openrouter': {
          enabled: true,
          apiKey: 'sk-test',
          model: 'openai/gpt-4o',
          customModels: [],
        },
      });
      mocks.callOpenRouterChat.mockResolvedValue({
        ok: true,
        rawContent: 'not json at all',
      });

      const adapter = new OpenRouterAdapter();
      const result = await adapter.analyzeTranscript(baseParams);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('not JSON');
      }
    });

    it('forwards the abort signal to callOpenRouterChat', async () => {
      mocks.storageGet.mockResolvedValue({
        'topskip:openrouter': {
          enabled: true,
          apiKey: 'sk-test',
          model: 'openai/gpt-4o',
          customModels: [],
        },
      });
      mocks.callOpenRouterChat.mockResolvedValue({
        ok: true,
        rawContent: JSON.stringify({ hasPromo: false }),
      });

      const abort = new AbortController();
      const adapter = new OpenRouterAdapter();
      await adapter.analyzeTranscript({ ...baseParams, signal: abort.signal });

      expect(mocks.callOpenRouterChat).toHaveBeenCalledWith(
        expect.objectContaining({ signal: abort.signal }),
      );
    });

    it('returns error when config has no apiKey', async () => {
      mocks.storageGet.mockResolvedValue({
        'topskip:openrouter': {
          enabled: true,
          apiKey: '',
          model: 'openai/gpt-4o',
          customModels: [],
        },
      });

      const adapter = new OpenRouterAdapter();
      const result = await adapter.analyzeTranscript(baseParams);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('not configured');
      }
    });
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run tests/background/providers/openrouter-adapter.test.ts`
Expected: FAIL — `Cannot find module '@/background/providers/openrouter-adapter'`

- [x] **Step 3: Write minimal implementation**
import { parseLlmPromoResponse } from
  '@/background/openrouter/parse-llm-promo-response';
import { PROMO_DETECTION_SYSTEM_PROMPT } from
  '@/background/openrouter/promo-detection-system-prompt';
import { OpenRouterStorage } from
  '@/background/storage/openrouter-storage';
import {
  PROVIDER_AVAILABILITY,
  PROVIDER_ID,
  type AnalyzeTranscriptParams,
  type AnalyzeTranscriptResult,
  type LlmProviderAdapter,
  type ProviderAvailability,
} from '@/background/providers/llm-provider-adapter';

/**
 * Wraps the existing OpenRouter call path behind the provider adapter
 * interface. No behavioral change — delegates to `callOpenRouterChat`
 * and `parseLlmPromoResponse`.
 */
export class OpenRouterAdapter implements LlmProviderAdapter {
  readonly id = PROVIDER_ID.OpenRouter;

  readonly displayName = 'OpenRouter';

  /**
   * Returns `'available'` when a non-empty API key and model are
   * configured in `OpenRouterStorage`, `'unavailable'` otherwise.
   *
   * @returns Current provider availability.
   */
  async availability(): Promise<ProviderAvailability> {
    const config = await OpenRouterStorage.load();
    if (config.apiKey.length > 0 && config.model.length > 0) {
      return PROVIDER_AVAILABILITY.Available;
    }
    return PROVIDER_AVAILABILITY.Unavailable;
  }

  /**
   * Sends the transcript to OpenRouter and parses the promo-detection
   * response.
   *
   * @param params - Transcript and context.
   * @returns Detection result or error.
   */
  async analyzeTranscript(
    params: AnalyzeTranscriptParams,
  ): Promise<AnalyzeTranscriptResult> {
    const config = await OpenRouterStorage.load();
    if (config.apiKey.length === 0 || config.model.length === 0) {
      return { ok: false, error: 'OpenRouter is not configured' };
    }

    const llm = await callOpenRouterChat({
      apiKey: config.apiKey,
      model: config.model,
      signal: params.signal,
      messages: [
        { role: 'system', content: PROMO_DETECTION_SYSTEM_PROMPT },
        { role: 'user', content: params.transcript },
      ],
    });

    if (!llm.ok) {
      return { ok: false, error: llm.error };
    }

    const parsed = parseLlmPromoResponse(llm.rawContent, params.durationSec);
    if (!parsed.ok) {
      return { ok: false, error: parsed.error };
    }

    const meta = { id: this.id, model: config.model };

    if (!parsed.hasPromo) {
      return { ok: true, hasPromo: false, providerMeta: meta };
    }

    return {
      ok: true,
      hasPromo: true,
      blocks: parsed.blocks,
      providerMeta: meta,
    };
  }
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run tests/background/providers/openrouter-adapter.test.ts`
Expected: PASS — all 9 tests green.

**Verification**: `OpenRouterAdapter` delegates to `callOpenRouterChat` with correct messages, forwards the signal, parses responses, and reports availability based on stored config.

---

### [x] Task 4: Create the default registry instance

**Files:**
- Create: `src/background/providers/default-registry.ts`

- [x] **Step 1: Create the module that exports the production singleton**

```ts
import { OpenRouterAdapter } from
  '@/background/providers/openrouter-adapter';
import { ProviderRegistry } from
  '@/background/providers/provider-registry';

/**
 * Production provider registry with all built-in adapters.
 * Imported by `Background.init()` (once the pipeline is rewired in issue 3).
 */
export const defaultRegistry = new ProviderRegistry([
  new OpenRouterAdapter(),
]);
```

- [x] **Step 2: Verify lint passes**

Run: `pnpm run lint:types`
Expected: PASS — no type errors.

**Verification**: `defaultRegistry.get('openrouter')` is an `OpenRouterAdapter` instance. This module is not imported anywhere yet — issue 3 wires it into the pipeline.

---

### [x] Task 5: Run full lint and existing test suites

**Files:** None (validation only).

- [x] **Step 1: Run type checker**

Run: `pnpm run lint:types`
Expected: PASS — no type errors.

- [x] **Step 2: Run ESLint + markdownlint**

Run: `pnpm run lint`
Expected: PASS — new files follow JSDoc and style rules.

- [x] **Step 3: Run all unit tests**

Run: `pnpm run test`
Expected: PASS — all existing tests still pass; new tests also pass.

- [x] **Step 4: Run coverage to confirm no threshold regressions**

Run: `pnpm run test:coverage`
Expected: PASS — thresholds on `skip-logic.ts`, `promo-skip-logic.ts`, `page-guards.ts`, `preferences-store.ts` are unchanged.

**Verification**: No regressions in lint, types, or existing tests. The new `providers/` files are purely additive.
