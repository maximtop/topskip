# Implementation Plan: Issue 9 - OpenRouter model slug validation

**Created**: 2026-04-18
**Status**: Validated
**Issue**: `.sdd/.current/issues/9-openrouter-slug-validation/issue.md`
**PRD**: `.sdd/.current/prd.md`
**Model**: GPT-5.3-Codex (copilot) high
**User Input**: None

## Summary

Validate custom OpenRouter model slugs before saving: enforce `owner/model-name` format always, and when an API key is configured, query the OpenRouter models API to verify the slug exists. Implement a session-scoped model list cache and surface validation errors and "Unverified" badges in the options UI.

## Technical Context

**Language/Version**: TypeScript 5.x (strict), ESM  
**Primary Dependencies**: Valibot (validation), `webextension-polyfill` (browser API)  
**Storage**: Background-only fetch + session cache (no persistence)  
**Testing**: Vitest 4.x with mocked fetch  
**Target Platform**: Chrome MV3 extension background script

## Research

### Existing OpenRouter integration

- `src/background/storage/openrouter-storage.ts`: Valibot-validated persistence, supports `apiKey`, `model`, `customModels[]`
- `src/background/messaging/openrouter-runtime-messages.ts`: Static handler class pattern with `handle(message, sender)` → `Promise<Response>`
- `src/shared/messages.ts`: Message types and response unions (e.g., `TOPSKIP_MESSAGE`, `SetOpenRouterConfigResponse`)
- `src/shared/openrouter-model-presets.ts`: Built-in model constants; location for format validator

### Existing validation patterns

- Response objects: `{ ok: true, ... } | { ok: false, error: string }`
- Static-only handler namespaces for messaging
- Mocked `fetch` in tests using `vi.mock`

### Dependency status

- Issue 4: Validated (provider messaging infrastructure exists)
- Issues 5, 6: Validated (popup and Chrome adapter ready)

## Entities

### OpenRouterValidationResult

- **Fields**:
  - `valid`: boolean - whether slug passed format and (if applicable) API checks
  - `error`: string | undefined - validation error message
  - `unverified`: boolean | undefined - whether API check was skipped due to missing key
- **Validation**:
  - Format: `/^[a-z0-9_-]+\/[a-z0-9._-]+$/i` enforced always
  - API check: only performed when API key is non-empty
  - Graceful degradation: network errors return `{ valid: true, unverified: true }`
- **States**:
  - `{ valid: true }` - slug is valid (format + found in API or no key)
  - `{ valid: true, unverified: true }` - format valid, API check skipped or failed
  - `{ valid: false, error: "..." }` - format invalid or slug not found

### SessionModelCache

- **Purpose**: Holds cached OpenRouter models list (fetched once per service worker lifetime)
- **Invalidation**: None (cleared on service worker restart, natural MV3 lifecycle)
- **Key**: Map from API key hash (or string) → models array

## Contracts

- **Runtime message**: `TOPSKIP_MESSAGE.VALIDATE_OPENROUTER_MODEL`
  - Request: `{ type: string; slug: string; apiKey: string }`
  - Response: `{ ok: true; valid: boolean; error?: string; unverified?: boolean } | { ok: false; error: string }`

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/background/openrouter/openrouter-models-api.ts` | Create | Fetch OpenRouter models endpoint; session-scoped cache; no I/O on cache hit |
| `tests/background/openrouter/openrouter-models-api.test.ts` | Create | Unit tests for fetch, cache, network errors |
| `src/shared/openrouter-model-presets.ts` | Modify | Add `isValidOpenRouterModelSlug(slug)` format validator |
| `tests/shared/openrouter-model-presets.test.ts` | Modify | Add tests for slug format validation |
| `src/shared/messages.ts` | Modify | Add `VALIDATE_OPENROUTER_MODEL` message + `ValidateOpenRouterModelResponse` type |
| `src/background/messaging/openrouter-runtime-messages.ts` | Modify | Add handler for `VALIDATE_OPENROUTER_MODEL` message |
| `tests/background/messaging/openrouter-runtime-messages.test.ts` | Modify | Add tests for validation handler |
| `src/options/OpenRouterConfigPanel.tsx` | Modify | Call validation on "Add custom model" submit; show errors and "Unverified" badge |

## Tasks

### [x] Task 1: Add slug format validator

**Files:**
- Modify: `src/shared/openrouter-model-presets.ts`
- Create/Modify: `tests/shared/openrouter-model-presets.test.ts`

- [ ] **Step 1: Write failing tests for slug format validation**

```ts
it('rejects slugs not matching owner/model format', () => {
  expect(isValidOpenRouterModelSlug('test')).toBe(false);
  expect(isValidOpenRouterModelSlug('')).toBe(false);
  expect(isValidOpenRouterModelSlug('/')).toBe(false);
  expect(isValidOpenRouterModelSlug('a/')).toBe(false);
  expect(isValidOpenRouterModelSlug('/b')).toBe(false);
  expect(isValidOpenRouterModelSlug('a/b/c')).toBe(false);
  expect(isValidOpenRouterModelSlug('a b/c-d')).toBe(false);
});

it('accepts valid owner/model slugs', () => {
  expect(isValidOpenRouterModelSlug('google/gemini-2.5-flash')).toBe(true);
  expect(isValidOpenRouterModelSlug('openai/gpt-4o')).toBe(true);
  expect(isValidOpenRouterModelSlug('meta-llama/llama-3-8b')).toBe(true);
  expect(isValidOpenRouterModelSlug('org_name/model-name_1')).toBe(true);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest run tests/shared/openrouter-model-presets.test.ts`  
Expected: FAIL

- [ ] **Step 3: Implement format validator**

```ts
export function isValidOpenRouterModelSlug(slug: string): boolean {
  return /^[a-z0-9_-]+\/[a-z0-9._-]+$/i.test(slug);
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/shared/openrouter-model-presets.test.ts`  
Expected: PASS

**Verification**: Format validation rejects invalid slugs and accepts `owner/model-name` pattern.

---

### [x] Task 2: Create OpenRouter models API fetcher with session cache

**Files:**
- Create: `src/background/openrouter/openrouter-models-api.ts`
- Create: `tests/background/openrouter/openrouter-models-api.test.ts`

- [ ] **Step 1: Write failing tests for model list fetching and caching**

```ts
it('fetches models list from OpenRouter API', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      data: [
        { id: 'google/gemini-2.5-flash' },
        { id: 'openai/gpt-4o' },
      ],
    }),
  }));

  const models = await fetchOpenRouterModelList('sk-test');
  expect(models).toContain('google/gemini-2.5-flash');
  expect(models).toContain('openai/gpt-4o');
});

it('caches models list for subsequent calls with same key', async () => {
  const mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      data: [{ id: 'google/gemini-2.5-flash' }],
    }),
  });
  vi.stubGlobal('fetch', mockFetch);

  await fetchOpenRouterModelList('sk-test');
  await fetchOpenRouterModelList('sk-test');

  expect(mockFetch).toHaveBeenCalledOnce();
});

it('returns empty array on network error', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

  const models = await fetchOpenRouterModelList('sk-test');
  expect(models).toEqual([]);
});

it('returns empty array when response is not ok', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));

  const models = await fetchOpenRouterModelList('sk-test');
  expect(models).toEqual([]);
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest run tests/background/openrouter/openrouter-models-api.test.ts`  
Expected: FAIL

- [ ] **Step 3: Implement model list fetcher**

```ts
/**
 * Session-scoped cache: maps API key to models array.
 * Cleared on service worker restart (natural MV3 lifecycle).
 */
const modelCache = new Map<string, string[]>();

/**
 * Fetches the list of available OpenRouter models, with session-scoped caching.
 * Returns an empty array on any error (graceful degradation).
 *
 * @param apiKey - OpenRouter API key for authorization
 * @returns Array of model IDs (e.g., `["google/gemini-2.5-flash", ...]`)
 */
export async function fetchOpenRouterModelList(apiKey: string): Promise<string[]> {
  if (modelCache.has(apiKey)) {
    return modelCache.get(apiKey)!;
  }

  try {
    const response = await fetch('https://openrouter.ai/api/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      return [];
    }
    const data: unknown = await response.json();
    if (
      typeof data === 'object' &&
      data !== null &&
      'data' in data &&
      Array.isArray((data as { data: unknown }).data)
    ) {
      const models = ((data as { data: unknown[] }).data)
        .map((item) => {
          if (typeof item === 'object' && item !== null && 'id' in item) {
            return String((item as { id: unknown }).id);
          }
          return null;
        })
        .filter((id): id is string => id !== null);
      modelCache.set(apiKey, models);
      return models;
    }
  } catch {
    /* Network error or parse failure: graceful degradation */
  }

  return [];
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/background/openrouter/openrouter-models-api.test.ts`  
Expected: PASS

**Verification**: Model list is fetched once per API key and cached; network errors degrade gracefully.

---

### [x] Task 3: Add validation message type to shared contracts

**Files:**
- Modify: `src/shared/messages.ts`

- [ ] **Step 1: Add message constant and response type**

In `TOPSKIP_MESSAGE`:
```ts
VALIDATE_OPENROUTER_MODEL: 'VALIDATE_OPENROUTER_MODEL',
```

Add response type:
```ts
export type ValidateOpenRouterModelResponse =
  | { ok: true; valid: boolean; error?: string; unverified?: boolean }
  | { ok: false; error: string };
```

Add to `TopSkipRuntimeMessage` union:
```ts
| {
    type: typeof TOPSKIP_MESSAGE.VALIDATE_OPENROUTER_MODEL;
    slug: string;
    apiKey: string;
  }
```

**Verification**: Message type is defined and accessible in shared contract.

---

### [x] Task 4: Implement validation handler in background messaging

**Files:**
- Modify: `src/background/messaging/openrouter-runtime-messages.ts`
- Modify: `tests/background/messaging/openrouter-runtime-messages.test.ts`

- [ ] **Step 1: Write failing tests for validation handler**

```ts
it('rejects invalid format slug', async () => {
  const r = await OpenRouterRuntimeMessages.handle(
    {
      type: TOPSKIP_MESSAGE.VALIDATE_OPENROUTER_MODEL,
      slug: 'invalid-format',
      apiKey: 'sk-test',
    },
    {} as never,
  );
  expect(r).toEqual({
    ok: true,
    valid: false,
    error: 'Invalid format. Use owner/model-name.',
  });
});

it('accepts format-valid slug when API key is empty', async () => {
  const r = await OpenRouterRuntimeMessages.handle(
    {
      type: TOPSKIP_MESSAGE.VALIDATE_OPENROUTER_MODEL,
      slug: 'google/gemini-2.5-flash',
      apiKey: '',
    },
    {} as never,
  );
  expect(r).toEqual({
    ok: true,
    valid: true,
    unverified: true,
  });
});

it('checks API when key is present and slug is found', async () => {
  /* Mock fetchOpenRouterModelList to return models */
  vi.mocked(fetchOpenRouterModelList).mockResolvedValue([
    'google/gemini-2.5-flash',
  ]);
  const r = await OpenRouterRuntimeMessages.handle(
    {
      type: TOPSKIP_MESSAGE.VALIDATE_OPENROUTER_MODEL,
      slug: 'google/gemini-2.5-flash',
      apiKey: 'sk-test',
    },
    {} as never,
  );
  expect(r).toEqual({ ok: true, valid: true });
});

it('rejects slug not found in API', async () => {
  vi.mocked(fetchOpenRouterModelList).mockResolvedValue([
    'google/gemini-2.5-flash',
  ]);
  const r = await OpenRouterRuntimeMessages.handle(
    {
      type: TOPSKIP_MESSAGE.VALIDATE_OPENROUTER_MODEL,
      slug: 'nonexistent/model',
      apiKey: 'sk-test',
    },
    {} as never,
  );
  expect(r).toEqual({
    ok: true,
    valid: false,
    error: 'Model not found on OpenRouter.',
  });
});

it('gracefully handles API fetch error', async () => {
  vi.mocked(fetchOpenRouterModelList).mockResolvedValue([]);
  const r = await OpenRouterRuntimeMessages.handle(
    {
      type: TOPSKIP_MESSAGE.VALIDATE_OPENROUTER_MODEL,
      slug: 'google/gemini-2.5-flash',
      apiKey: 'sk-test',
    },
    {} as never,
  );
  expect(r).toEqual({
    ok: true,
    valid: true,
    unverified: true,
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm vitest run tests/background/messaging/openrouter-runtime-messages.test.ts`  
Expected: FAIL (new tests fail)

- [ ] **Step 3: Implement validation handler**

Add to `OpenRouterRuntimeMessages`:
```ts
/**
 * Validates a custom OpenRouter model slug at save time.
 * 1. Format check: always enforced
 * 2. API check: only if API key is present
 * 3. Graceful degradation: network/API errors return unverified (valid: true)
 *
 * @param slug - Model slug to validate
 * @param apiKey - API key for OpenRouter API check (or empty)
 * @returns Validation result
 */
private static async handleValidateModelSlug(
  slug: string,
  apiKey: string,
): Promise<ValidateOpenRouterModelResponse> {
  if (!isValidOpenRouterModelSlug(slug)) {
    return {
      ok: true,
      valid: false,
      error: 'Invalid format. Use owner/model-name.',
    };
  }

  if (apiKey.length === 0) {
    return { ok: true, valid: true, unverified: true };
  }

  const models = await fetchOpenRouterModelList(apiKey);
  if (models.length === 0) {
    /* API fetch failed or returned empty; graceful: mark as unverified */
    return { ok: true, valid: true, unverified: true };
  }

  if (!models.includes(slug)) {
    return {
      ok: true,
      valid: false,
      error: 'Model not found on OpenRouter.',
    };
  }

  return { ok: true, valid: true };
}

/**
 * Entry point for VALIDATE_OPENROUTER_MODEL message.
 *
 * @param message - Message from popup/options
 * @param sender - Extension sender
 * @returns Validation response, or undefined to pass to next handler
 */
static handle(
  message: unknown,
  sender: Runtime.MessageSender,
):
  | Promise<GetOpenRouterConfigResponse>
  | Promise<SetOpenRouterConfigResponse>
  | Promise<ValidateOpenRouterModelResponse>
  | undefined {
  if (!message || typeof message !== 'object') {
    return undefined;
  }

  const typeRaw: unknown = Reflect.get(message, 'type');
  if (typeof typeRaw !== 'string') {
    return undefined;
  }

  if (typeRaw === TOPSKIP_MESSAGE.VALIDATE_OPENROUTER_MODEL) {
    const slug: unknown = Reflect.get(message, 'slug');
    const apiKey: unknown = Reflect.get(message, 'apiKey');
    if (typeof slug === 'string' && typeof apiKey === 'string') {
      return OpenRouterRuntimeMessages.handleValidateModelSlug(slug, apiKey);
    }
    return Promise.resolve({ ok: false, error: 'Invalid parameters' });
  }

  /* Existing handlers remain unchanged */
  return undefined;
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `pnpm vitest run tests/background/messaging/openrouter-runtime-messages.test.ts`  
Expected: PASS

**Verification**: Validation handler enforces format, checks API when key present, and degrades gracefully.

---

### [x] Task 5: Wire validation handler into message dispatcher

**Files:**
- Modify: `src/background/messaging/register-runtime-messages.ts`

- [ ] **Step 1: Add handler to message chain**

In the message listener:
```ts
const validation = OpenRouterRuntimeMessages.handle(message, sender);
if (validation !== undefined) {
  return validation;
}
```

Chain should flow: prefsMethods → validation → openrouter → promo-analysis → content script methods.

**Verification**: Handler receives messages and validation responses are routed.

---

### [x] Task 6: Add validation and UI feedback to options panel

**Files:**
- Modify: `src/options/OpenRouterConfigPanel.tsx`

- [ ] **Step 1: Update component to validate and show errors**

Add state for validation:
```ts
const [validationError, setValidationError] = useState<string | null>(null);
const [unverifiedModels, setUnverifiedModels] = useState<Set<string>>(
  new Set(),
);
```

Update "Add custom model" handler:
```ts
const onAddCustomModel = async (): Promise<void> => {
  const res = await browser.runtime.sendMessage({
    type: TOPSKIP_MESSAGE.VALIDATE_OPENROUTER_MODEL,
    slug: newModelDraft.trim(),
    apiKey: apiKey.trim(),
  });

  if (!res.ok) {
    setValidationError(res.error);
    return;
  }

  if (!res.valid) {
    setValidationError(res.error ?? 'Invalid model slug');
    return;
  }

  setValidationError(null);
  if (res.unverified) {
    setUnverifiedModels((prev) =>
      new Set([...prev, newModelDraft.trim()]),
    );
  }

  props.onAddCustomModel();
};
```

Show error inline and badge for unverified models:
```tsx
{validationError ? (
  <Alert color="red">{validationError}</Alert>
) : null}

{unverifiedModels.has(slug) ? (
  <Badge color="yellow" variant="light">
    Unverified
  </Badge>
) : null}
```

- [ ] **Step 2: Run lint and build to verify integration**

Run: `pnpm run lint && pnpm run build`  
Expected: PASS

**Verification**: Validation errors display inline; unverified badge shows when API check was skipped.

---

### [x] Task 7: Final validation

**Files:**
- No new files

- [ ] **Step 1: Run full test suite**

Run: `pnpm run test`  
Expected: PASS

- [ ] **Step 2: Run lint and build**

Run: `pnpm run lint && pnpm run build`  
Expected: PASS

- [ ] **Step 3: Run e2e tests**

Run: `pnpm run test:e2e`  
Expected: PASS

**Verification**: All acceptance criteria are met and full pipeline is clean.

## Acceptance Criteria Coverage Check

- **AC1** Slugs not matching `owner/model-name` are rejected → Task 1 + Task 4
- **AC2** Well-formed slugs checked against API when key present → Task 4
- **AC3** Missing slugs show error → Task 4 + Task 6
- **AC4** No API key → unverified badge → Task 4 + Task 6
- **AC5** Models list cached per session → Task 2
- **AC6** Network errors degrade gracefully → Task 2 + Task 4
- **AC7** lint passes → Task 7

## Self-Review

- **Issue coverage**: Every acceptance criterion maps to at least one task.
- **Placeholder scan**: No TBD or unspecified details remain; all code is exact.
- **Type consistency**: Request/response types match message contract; validator function signature is concrete.
- **TDD flow**: Each task has failing test → pass → verify steps.
- **Dependency order**: Format validator first, then fetcher, then handler, then UI.
