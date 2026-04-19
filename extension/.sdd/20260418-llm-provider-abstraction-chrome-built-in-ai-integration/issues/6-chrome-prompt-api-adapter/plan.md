# Implementation Plan: Chrome Prompt API adapter

**Created**: 2026-04-17
**Status**: Validated
**Issue**: `.sdd/.current/issues/6-chrome-prompt-api-adapter/issue.md`
**PRD**: `.sdd/.current/prd.md`
**Model**: Claude Opus 4.6 (copilot) high
**User Input**: None

## Summary

Implement `ChromePromptApiAdapter` — a concrete `LlmProviderAdapter` wrapping Chrome's `LanguageModel` (Gemini Nano) for free on-device promo detection. The adapter checks availability via `LanguageModel.availability()`, creates one-shot sessions with a system prompt and JSON Schema `responseConstraint`, truncates transcripts to fit the context window (keeping the tail), and parses responses through the shared `parseLlmPromoResponse`. It is registered in `ProviderRegistry` alongside the existing `OpenRouterAdapter`.

## Technical Context

**Language/Version**: TypeScript 5.x (strict), ESM
**Primary Dependencies**: `@types/dom-chromium-ai` (LanguageModel typings), Valibot (response schema), shared `parseLlmPromoResponse` / `PROMO_DETECTION_SYSTEM_PROMPT`
**Storage**: N/A — Chrome manages model state; no persisted config for this adapter
**Testing**: Vitest 4.x; `vi.stubGlobal` to mock `LanguageModel` on `globalThis`
**Target Platform**: Chrome MV3 extension service worker (Chrome 138+)

## Research

### Accessing `LanguageModel` safely in non-Chrome environments

The `LanguageModel` API only exists in Chrome 138+ service workers with hardware support. The adapter uses `Reflect.get(globalThis, 'LanguageModel')` and type-narrows the result as `unknown` before casting. This avoids compile-time errors in Node/Vitest where the global does not exist and avoids `as` casts on `globalThis` itself.

### Type declarations for `LanguageModel`

The project uses `@types/dom-chromium-ai` (devDependency) which provides `LanguageModel`, `LanguageModelCreateOptions`, and related interfaces. The issue originally planned a `chrome-prompt-api-types.ts` file, but the community typings package covers the surface adequately, so no hand-written declarations are needed.

### Session lifecycle

`LanguageModel.create()` returns a session object with `contextWindow` (max tokens), `prompt()`, and `destroy()`. Sessions must be destroyed after use (in a `finally` block) to free GPU resources. The adapter uses one-shot sessions: create → prompt → destroy per analysis call.

### Structured output via `responseConstraint`

Chrome's Prompt API accepts a JSON Schema in the `prompt()` options under `responseConstraint`. This constrains Gemini Nano's output to match the promo-detection schema, improving reliability. The schema mirrors the Valibot `llmPromoDetectionSchema` but expressed as a plain JSON Schema `oneOf` discriminator on `hasPromo`.

### Transcript truncation strategy

Gemini Nano has a smaller context window (~4 K–30 K tokens depending on hardware). The adapter estimates tokens as `chars / 4`, subtracts the system prompt estimate and a 512-token response reserve, then truncates from the **start** of the transcript (keeping the tail). This keeps the most recent captions — most likely to contain promo blocks near the end of the video.

### Shared response parsing

Both `ChromePromptApiAdapter` and `OpenRouterAdapter` reuse `parseLlmPromoResponse()` from `src/background/openrouter/parse-llm-promo-response.ts`. This function strips markdown fences, validates against Valibot `llmPromoDetectionSchema`, refines blocks (clamp to duration, validate numeric constraints), and deduplicates. No adapter-specific parsing is needed.

## Entities

### ChromePromptApiAdapter

- **Fields**:
    - `id`: `'chrome-prompt-api'` (from `PROVIDER_ID.ChromePromptApi`)
    - `displayName`: `'Chrome Built-in'`
- **Relationships**: Implements `LlmProviderAdapter`. Registered in `ProviderRegistry` via `default-registry.ts`.
- **Validation**: `availability()` returns `'unavailable'` when `LanguageModel` is absent. `analyzeTranscript()` returns `{ ok: false }` when the API is unavailable or session creation fails.
- **States**: Delegates to Chrome's availability states: `unavailable` → `downloadable` → `downloading` → `available`.

## Contracts

N/A — no API endpoints required. The adapter uses Chrome's in-process `LanguageModel` API and communicates via the existing `LlmProviderAdapter` interface.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/background/providers/chrome-prompt-api-adapter.ts` | Create | `ChromePromptApiAdapter` class — wraps `LanguageModel` behind `LlmProviderAdapter` |
| `src/background/providers/default-registry.ts` | Modify | Register `ChromePromptApiAdapter` alongside `OpenRouterAdapter` |
| `tests/background/providers/chrome-prompt-api-adapter.test.ts` | Create | Unit tests with mocked `LanguageModel` via `vi.stubGlobal` |

## Tasks

### [x] Task 1: Adapter skeleton — properties and availability

**Files:**
- Create: `src/background/providers/chrome-prompt-api-adapter.ts`
- Test: `tests/background/providers/chrome-prompt-api-adapter.test.ts`

- [x] **Step 1: Write the failing tests for properties and availability**

```ts
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {
  PROVIDER_AVAILABILITY,
  PROVIDER_ID,
} from '@/background/providers/llm-provider-adapter';

/**
 * Minimal mock for the LanguageModel static interface.
 */
function makeLanguageModelGlobal(overrides?: Partial<{
  availabilityResult: string;
}>) {
  const availabilityResult = overrides?.availabilityResult ?? 'available';
  return {
    availability: vi.fn().mockResolvedValue(availabilityResult),
    create: vi.fn(),
  };
}

const { ChromePromptApiAdapter } = await import(
  '@/background/providers/chrome-prompt-api-adapter'
);

describe('ChromePromptApiAdapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe('properties', () => {
    it('has id matching PROVIDER_ID.ChromePromptApi', () => {
      const adapter = new ChromePromptApiAdapter();
      expect(adapter.id).toBe(PROVIDER_ID.ChromePromptApi);
    });

    it('has displayName "Chrome Built-in"', () => {
      const adapter = new ChromePromptApiAdapter();
      expect(adapter.displayName).toBe('Chrome Built-in');
    });
  });

  describe('availability', () => {
    it(
      'returns unavailable when LanguageModel is not on globalThis',
      async () => {
        const adapter = new ChromePromptApiAdapter();
        const avail = await adapter.availability();
        expect(avail).toBe(PROVIDER_AVAILABILITY.Unavailable);
      },
    );

    it('returns available when Chrome reports "available"', async () => {
      vi.stubGlobal(
        'LanguageModel',
        makeLanguageModelGlobal({ availabilityResult: 'available' }),
      );
      const adapter = new ChromePromptApiAdapter();
      expect(await adapter.availability()).toBe(
        PROVIDER_AVAILABILITY.Available,
      );
    });

    it('returns downloadable when Chrome reports "downloadable"', async () => {
      vi.stubGlobal(
        'LanguageModel',
        makeLanguageModelGlobal({ availabilityResult: 'downloadable' }),
      );
      const adapter = new ChromePromptApiAdapter();
      expect(await adapter.availability()).toBe(
        PROVIDER_AVAILABILITY.Downloadable,
      );
    });

    it('returns downloading when Chrome reports "downloading"', async () => {
      vi.stubGlobal(
        'LanguageModel',
        makeLanguageModelGlobal({ availabilityResult: 'downloading' }),
      );
      const adapter = new ChromePromptApiAdapter();
      expect(await adapter.availability()).toBe(
        PROVIDER_AVAILABILITY.Downloading,
      );
    });

    it('returns unavailable when Chrome reports "unavailable"', async () => {
      vi.stubGlobal(
        'LanguageModel',
        makeLanguageModelGlobal({ availabilityResult: 'unavailable' }),
      );
      const adapter = new ChromePromptApiAdapter();
      expect(await adapter.availability()).toBe(
        PROVIDER_AVAILABILITY.Unavailable,
      );
    });
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/background/providers/chrome-prompt-api-adapter.test.ts`
Expected: FAIL — module `@/background/providers/chrome-prompt-api-adapter` not found

- [x] **Step 3: Write minimal implementation — adapter class with `id`, `displayName`, and `availability()`**

```ts
import {
  PROVIDER_AVAILABILITY,
  PROVIDER_ID,
  type LlmProviderAdapter,
  type ProviderAvailability,
  type AnalyzeTranscriptParams,
  type AnalyzeTranscriptResult,
} from '@/background/providers/llm-provider-adapter';

export class ChromePromptApiAdapter implements LlmProviderAdapter {
  readonly id = PROVIDER_ID.ChromePromptApi;

  readonly displayName = 'Chrome Built-in';

  /**
   * Maps Chrome's `LanguageModel.availability()` to `ProviderAvailability`.
   * Returns `'unavailable'` when `LanguageModel` is not in global scope so
   * the options UI can gate accordingly.
   *
   * @returns Current availability state.
   */
  async availability(): Promise<ProviderAvailability> {
    const lm: unknown = Reflect.get(globalThis, 'LanguageModel');
    if (!lm || typeof lm !== 'object') {
      return PROVIDER_AVAILABILITY.Unavailable;
    }

    const availFn: unknown = Reflect.get(lm, 'availability');
    if (typeof availFn !== 'function') {
      return PROVIDER_AVAILABILITY.Unavailable;
    }

    const chromeSt: unknown = await (availFn as () => Promise<unknown>)
      .call(lm);
    switch (chromeSt) {
      case 'available':
        return PROVIDER_AVAILABILITY.Available;
      case 'downloadable':
        return PROVIDER_AVAILABILITY.Downloadable;
      case 'downloading':
        return PROVIDER_AVAILABILITY.Downloading;
      default:
        return PROVIDER_AVAILABILITY.Unavailable;
    }
  }

  /**
   * Stub — implemented in Task 2.
   *
   * @param _params - Unused.
   * @returns Always returns not-available error.
   */
  async analyzeTranscript(
    _params: AnalyzeTranscriptParams,
  ): Promise<AnalyzeTranscriptResult> {
    return { ok: false, error: 'Not implemented' };
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/background/providers/chrome-prompt-api-adapter.test.ts`
Expected: PASS — all 7 tests pass

**Verification**: `availability()` correctly maps all four Chrome states plus the absent-global case.

---

### [x] Task 2: `analyzeTranscript` — happy path, truncation, and error handling

**Files:**
- Modify: `src/background/providers/chrome-prompt-api-adapter.ts`
- Modify: `tests/background/providers/chrome-prompt-api-adapter.test.ts`

- [x] **Step 1: Write the failing tests for `analyzeTranscript`**

Add to the existing test file inside `describe('ChromePromptApiAdapter')`:

```ts
/**
 * Minimal mock for a LanguageModel session.
 */
function makeSession(overrides?: Partial<{
  contextWindow: number;
  promptResult: string;
  promptError: Error | null;
}>) {
  const contextWindow = overrides?.contextWindow ?? 4096;
  const promptResult = overrides?.promptResult
    ?? JSON.stringify({ hasPromo: false });
  const promptError = overrides?.promptError ?? null;

  return {
    contextWindow,
    prompt: promptError
      ? vi.fn().mockRejectedValue(promptError)
      : vi.fn().mockResolvedValue(promptResult),
    destroy: vi.fn(),
  };
}

// Update makeLanguageModelGlobal to accept session and createError:
function makeLanguageModelGlobal(overrides?: Partial<{
  availabilityResult: string;
  session: ReturnType<typeof makeSession>;
  createError: Error | null;
}>) {
  const availabilityResult = overrides?.availabilityResult ?? 'available';
  const session = overrides?.session ?? makeSession();
  const createError = overrides?.createError ?? null;

  return {
    availability: vi.fn().mockResolvedValue(availabilityResult),
    create: createError
      ? vi.fn().mockRejectedValue(createError)
      : vi.fn().mockResolvedValue(session),
  };
}

const baseParams: AnalyzeTranscriptParams = {
  transcript: 'videoId=abc\nlanguage=en\n\nHello world this is a transcript.',
  videoId: 'abc',
  languageCode: 'en',
  durationSec: 300,
};

describe('analyzeTranscript', () => {
  it('returns error when LanguageModel is not on globalThis', async () => {
    const adapter = new ChromePromptApiAdapter();
    const result = await adapter.analyzeTranscript(baseParams);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('not available');
    }
  });

  it(
    'creates session with system prompt and returns parsed result',
    async () => {
      const session = makeSession({
        promptResult: JSON.stringify({ hasPromo: false }),
      });
      const lmGlobal = makeLanguageModelGlobal({ session });
      vi.stubGlobal('LanguageModel', lmGlobal);

      const adapter = new ChromePromptApiAdapter();
      const result = await adapter.analyzeTranscript(baseParams);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.hasPromo).toBe(false);
        expect(result.providerMeta).toEqual({
          id: PROVIDER_ID.ChromePromptApi,
          model: 'gemini-nano',
        });
      }
      expect(session.destroy).toHaveBeenCalledOnce();
    },
  );

  it('passes responseConstraint JSON Schema to prompt()', async () => {
    const session = makeSession({
      promptResult: JSON.stringify({ hasPromo: false }),
    });
    vi.stubGlobal(
      'LanguageModel',
      makeLanguageModelGlobal({ session }),
    );

    const adapter = new ChromePromptApiAdapter();
    await adapter.analyzeTranscript(baseParams);

    const [, opts] = session.prompt.mock.calls[0] as [
      string,
      { responseConstraint?: unknown; signal?: AbortSignal },
    ];
    expect(opts?.responseConstraint).toBeDefined();
    expect(typeof opts?.responseConstraint).toBe('object');
  });

  it('forwards the AbortSignal to create() and prompt()', async () => {
    const session = makeSession({
      promptResult: JSON.stringify({ hasPromo: false }),
    });
    const lmGlobal = makeLanguageModelGlobal({ session });
    vi.stubGlobal('LanguageModel', lmGlobal);

    const abort = new AbortController();
    const adapter = new ChromePromptApiAdapter();
    await adapter.analyzeTranscript({
      ...baseParams,
      signal: abort.signal,
    });

    expect(lmGlobal.create).toHaveBeenCalledWith(
      expect.objectContaining({ signal: abort.signal }),
    );
    expect(session.prompt).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ signal: abort.signal }),
    );
  });

  it(
    'truncates transcript from start when it exceeds context budget',
    async () => {
      const session = makeSession({
        contextWindow: 64,
        promptResult: JSON.stringify({ hasPromo: false }),
      });
      vi.stubGlobal(
        'LanguageModel',
        makeLanguageModelGlobal({ session }),
      );

      const longTranscript = 'A'.repeat(2000);
      const adapter = new ChromePromptApiAdapter();
      await adapter.analyzeTranscript({
        ...baseParams,
        transcript: longTranscript,
      });

      const [promptArg] = session.prompt.mock.calls[0] as [string, unknown];
      expect(promptArg.length).toBeLessThan(longTranscript.length);
      expect(longTranscript.endsWith(promptArg)).toBe(true);
    },
  );

  it('returns promo blocks when LLM detects a promo', async () => {
    const session = makeSession({
      promptResult: JSON.stringify({
        hasPromo: true,
        promoBlocks: [{ startSec: 10, endSec: 40 }],
      }),
    });
    vi.stubGlobal(
      'LanguageModel',
      makeLanguageModelGlobal({ session }),
    );

    const adapter = new ChromePromptApiAdapter();
    const result = await adapter.analyzeTranscript(baseParams);

    expect(result.ok).toBe(true);
    if (result.ok && result.hasPromo) {
      expect(result.blocks).toEqual([{ startSec: 10, endSec: 40 }]);
      expect(result.providerMeta.model).toBe('gemini-nano');
    }
  });

  it('returns error when session creation fails', async () => {
    vi.stubGlobal(
      'LanguageModel',
      makeLanguageModelGlobal({
        createError: new Error('Model not ready'),
      }),
    );

    const adapter = new ChromePromptApiAdapter();
    const result = await adapter.analyzeTranscript(baseParams);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Model not ready');
    }
  });

  it('returns error and destroys session when prompt() throws', async () => {
    const session = makeSession({
      promptError: new Error('Prompt quota exceeded'),
    });
    vi.stubGlobal(
      'LanguageModel',
      makeLanguageModelGlobal({ session }),
    );

    const adapter = new ChromePromptApiAdapter();
    const result = await adapter.analyzeTranscript(baseParams);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Prompt quota exceeded');
    }
    expect(session.destroy).toHaveBeenCalledOnce();
  });

  it('returns error when LLM response fails parse validation', async () => {
    const session = makeSession({
      promptResult: 'not valid json at all',
    });
    vi.stubGlobal(
      'LanguageModel',
      makeLanguageModelGlobal({ session }),
    );

    const adapter = new ChromePromptApiAdapter();
    const result = await adapter.analyzeTranscript(baseParams);

    expect(result.ok).toBe(false);
  });

  it('passes the system prompt in initialPrompts to create()', async () => {
    const session = makeSession({
      promptResult: JSON.stringify({ hasPromo: false }),
    });
    const lmGlobal = makeLanguageModelGlobal({ session });
    vi.stubGlobal('LanguageModel', lmGlobal);

    const adapter = new ChromePromptApiAdapter();
    await adapter.analyzeTranscript(baseParams);

    const [createOpts] = lmGlobal.create.mock.calls[0] as [
      { initialPrompts?: Array<{ role: string; content: string }> },
    ];
    expect(createOpts?.initialPrompts?.[0]?.role).toBe('system');
    expect(typeof createOpts?.initialPrompts?.[0]?.content).toBe('string');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run tests/background/providers/chrome-prompt-api-adapter.test.ts`
Expected: FAIL — `analyzeTranscript` returns `'Not implemented'` instead of expected results

- [x] **Step 3: Implement full `analyzeTranscript` method**

Replace the stub `analyzeTranscript` in `chrome-prompt-api-adapter.ts` with the full implementation. Add the required imports and constants at the top of the file:

```ts
import { parseLlmPromoResponse } from
  '@/background/openrouter/parse-llm-promo-response';
import { PROMO_DETECTION_SYSTEM_PROMPT } from
  '@/background/openrouter/promo-detection-system-prompt';
import {
  PROVIDER_AVAILABILITY,
  PROVIDER_ID,
  type AnalyzeTranscriptParams,
  type AnalyzeTranscriptResult,
  type LlmProviderAdapter,
  type ProviderAvailability,
} from '@/background/providers/llm-provider-adapter';

/**
 * JSON Schema matching `llmPromoDetectionSchema` (Valibot) — passed
 * as `responseConstraint` to constrain Gemini Nano's output format.
 */
const PROMO_DETECTION_RESPONSE_SCHEMA: Record<string, unknown> = {
  oneOf: [
    {
      type: 'object',
      required: ['hasPromo', 'promoBlocks'],
      properties: {
        hasPromo: { const: true },
        promoBlocks: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            required: ['startSec'],
            properties: {
              startSec: { type: 'number' },
              endSec: { type: 'number' },
              confidence: { enum: ['low', 'medium', 'high'] },
            },
          },
        },
      },
    },
    {
      type: 'object',
      required: ['hasPromo'],
      properties: {
        hasPromo: { const: false },
        confidence: { enum: ['low', 'medium', 'high'] },
      },
    },
  ],
};

/**
 * Heuristic: 1 token ≈ 4 characters.
 * Used to estimate the transcript's token cost before prompting.
 */
const CHARS_PER_TOKEN = 4;

/**
 * Token budget reserved for the model's JSON response.
 * Prevents the output from crowding out the transcript input.
 */
const RESPONSE_TOKEN_RESERVE = 512;
```

Then implement `analyzeTranscript`:

```ts
  /**
   * Sends the transcript to Gemini Nano via a one-shot session and
   * parses the structured promo-detection response.
   *
   * Steps:
   * 1. Guard against missing `LanguageModel` global.
   * 2. Create a session with the system prompt in `initialPrompts`.
   * 3. Truncate the transcript to fit the context window (keep tail).
   * 4. Prompt with `responseConstraint` for structured JSON output.
   * 5. Parse via `parseLlmPromoResponse` and return a typed result.
   * 6. Always destroy the session (in `finally`).
   *
   * @param params - Transcript and context for the analysis.
   * @returns Detection result or error.
   */
  async analyzeTranscript(
    params: AnalyzeTranscriptParams,
  ): Promise<AnalyzeTranscriptResult> {
    const lm: unknown = Reflect.get(globalThis, 'LanguageModel');
    if (!lm || typeof lm !== 'object') {
      return {
        ok: false,
        error: 'Chrome Built-in AI is not available',
      };
    }

    const createFn: unknown = Reflect.get(lm, 'create');
    if (typeof createFn !== 'function') {
      return {
        ok: false,
        error: 'Chrome Built-in AI is not available',
      };
    }

    let session: LanguageModel;
    try {
      session = await (createFn as (
        opts: LanguageModelCreateOptions,
      ) => Promise<LanguageModel>).call(lm, {
        signal: params.signal,
        initialPrompts: [
          { role: 'system', content: PROMO_DETECTION_SYSTEM_PROMPT },
        ],
      });
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error
          ? e.message
          : 'Failed to create LanguageModel session',
      };
    }

    try {
      const sysTokens = Math.ceil(
        PROMO_DETECTION_SYSTEM_PROMPT.length / CHARS_PER_TOKEN,
      );
      const budget = session.contextWindow - sysTokens - RESPONSE_TOKEN_RESERVE;
      const maxChars = Math.max(0, budget * CHARS_PER_TOKEN);

      let transcript = params.transcript;
      if (transcript.length > maxChars) {
        /* Keep the most recent captions (tail) — they're most likely
         * to contain the promo block if it's near the end of the video. */
        transcript = transcript.slice(transcript.length - maxChars);
        console.warn(
          '[TopSkip] ChromePromptApiAdapter: transcript truncated',
          {
            originalChars: params.transcript.length,
            truncatedChars: transcript.length,
          },
        );
      }

      const rawContent = await session.prompt(transcript, {
        responseConstraint: PROMO_DETECTION_RESPONSE_SCHEMA,
        signal: params.signal,
      });

      const parsed = parseLlmPromoResponse(rawContent, params.durationSec);
      if (!parsed.ok) {
        return { ok: false, error: parsed.error };
      }

      const meta = { id: this.id, model: 'gemini-nano' } as const;
      if (!parsed.hasPromo) {
        return { ok: true, hasPromo: false, providerMeta: meta };
      }
      return {
        ok: true,
        hasPromo: true,
        blocks: parsed.blocks,
        providerMeta: meta,
      };
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : 'Prompt failed',
      };
    } finally {
      session.destroy();
    }
  }
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run tests/background/providers/chrome-prompt-api-adapter.test.ts`
Expected: PASS — all analyzeTranscript tests pass

**Verification**: Happy path returns parsed result with `providerMeta`, truncation keeps tail, errors are caught, session is always destroyed, AbortSignal forwarded.

---

### [x] Task 3: Register adapter in `ProviderRegistry`

**Files:**
- Modify: `src/background/providers/default-registry.ts`

- [x] **Step 1: Verify existing registry test covers multi-adapter lookup**

The existing `tests/background/providers/provider-registry.test.ts` already tests `get(id)` and `getAll()` with multiple adapters. Confirm it passes before the change.

Run: `pnpm vitest run tests/background/providers/provider-registry.test.ts`
Expected: PASS

- [x] **Step 2: Add `ChromePromptApiAdapter` to the default registry**

In `src/background/providers/default-registry.ts`, add the import and registration:

```ts
import { ChromePromptApiAdapter } from
  '@/background/providers/chrome-prompt-api-adapter';
import { OpenRouterAdapter } from
  '@/background/providers/openrouter-adapter';
import { ProviderRegistry } from
  '@/background/providers/provider-registry';

/**
 * Production provider registry with all built-in adapters.
 * Imported by `Background.init()` (once the pipeline is rewired in issue 3).
 */
export const defaultRegistry = new ProviderRegistry([
  new ChromePromptApiAdapter(),
  new OpenRouterAdapter(),
]);
```

- [x] **Step 3: Run full lint + test to confirm integration**

Run: `pnpm run lint && pnpm vitest run`
Expected: PASS — no type errors, no lint errors, all tests pass

**Verification**: `defaultRegistry.get('chrome-prompt-api')` returns the `ChromePromptApiAdapter` instance. `defaultRegistry.getAll()` includes both adapters.

---

### [x] Task 4: Final validation

- [x] **Step 1: Run full CI-equivalent suite**

Run: `pnpm run lint && pnpm run build && pnpm run test && pnpm run test:e2e`
Expected: All pass — no regressions in existing tests, new adapter tests green, build includes the adapter in `dist/background.js`.

**Verification**: All acceptance criteria from the issue are satisfied:
- `ChromePromptApiAdapter` registered in `ProviderRegistry` ✓
- `availability()` maps all four Chrome states ✓
- `availability()` returns `'unavailable'` when `LanguageModel` absent ✓
- `analyzeTranscript()` creates session, sends prompt, returns parsed result ✓
- Transcript truncation fires when content exceeds budget ✓
- Truncation removes from start (oldest captions) ✓
- `responseConstraint` JSON Schema included in `prompt()` call ✓
- Session destroyed after each analysis ✓
- AbortSignal forwarded to both `create()` and `prompt()` ✓
- `pnpm run lint` passes ✓
