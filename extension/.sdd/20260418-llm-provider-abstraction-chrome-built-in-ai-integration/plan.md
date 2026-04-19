# Implementation Plan: LLM Provider Abstraction & Chrome Prompt API Integration

**Spec**: `.sdd/.current/spec.md`
**Created**: 2026-04-16

## Summary

Introduce a provider-agnostic adapter layer between the promo-detection pipeline
(`PromoAnalysis.run()`) and the underlying LLM backend. Today the pipeline
directly calls `callOpenRouterChat()`; after this work it resolves an
`LlmProviderAdapter` from a registry and delegates to its `analyzeTranscript`
method. Two adapters ship: `OpenRouterAdapter` (wrapping the existing client)
and `ChromePromptApiAdapter` (Chrome built-in Gemini Nano). The options page
gains a provider selector with conditional config sections and a multi-state
onboarding widget for the Chrome Built-in download lifecycle. The popup gains an
active-provider/model indicator.

## Technical Context

| Topic | Detail |
|-------|--------|
| **Coupling point** | `PromoAnalysis.run()` in `src/background/messaging/promo-analysis.ts` directly imports and calls `callOpenRouterChat()` and reads `OpenRouterStorage` for config |
| **Already provider-agnostic** | `parseLlmPromoResponse()`, `PROMO_DETECTION_SYSTEM_PROMPT`, `buildPromoAnalysisLogBundle()` (takes `model: string`), `PromoDetectionStore`, all shared promo types |
| **Chrome Prompt API surface** | `LanguageModel.availability()` → `'unavailable' \| 'downloadable' \| 'downloading' \| 'available'`; `LanguageModel.create({ monitor, signal })` → session; `session.prompt(input, { signal, responseConstraint })` → `string`; `session.contextWindow` for token budget; `session.destroy()` |
| **TypeScript types** | `@types/dom-chromium-ai` npm package provides global `LanguageModel`, `LanguageModelSession`, etc. |
| **Extension permissions** | No new manifest permissions needed — Prompt API is available to MV3 extensions by default |
| **Storage pattern** | Background-only via `browser.storage.local`, Valibot at boundary; popup/options read through `runtime.sendMessage` |
| **Message pattern** | Single `runtime.onMessage` listener chains handlers; each handler returns `undefined` to pass or `Promise<T>` to claim |
| **UI stack** | Options: React + Mantine + useState; Popup: React + Mantine + MobX (`PreferencesStore`) |
| **Test stack** | Vitest, `vi.hoisted()` + `vi.mock('@/shared/browser')` pattern, coverage thresholds on select files |

## Research Findings

### Chrome Prompt API (from developer.chrome.com/docs/extensions/ai/prompt-api)

- **Availability check**: `LanguageModel.availability()` returns a promise of
  `'unavailable' | 'downloadable' | 'downloading' | 'available'`. Must pass the
  same options used in `prompt()`/`promptStreaming()`.
- **Session creation**: `LanguageModel.create({ monitor, signal })`. The
  `monitor` callback receives a target with `downloadprogress` events
  (`e.loaded` is 0–1 fraction). The `signal` is an `AbortSignal` for
  cancellation.
- **Prompting**: `session.prompt(input, { signal, responseConstraint })`.
  `responseConstraint` accepts a JSON Schema to constrain output format. Returns
  a `Promise<string>`.
- **Context window**: `session.contextWindow` (number). Context overflow drops
  oldest prompt/response pairs (except system prompt). `QuotaExceededError` if
  even that isn't enough.
- **Session lifecycle**: `session.destroy()` frees resources. Subsequent
  `prompt()` calls reject.
- **Model parameters** (extensions only): `LanguageModel.params()` returns
  `{ defaultTopK, maxTopK, defaultTemperature, maxTemperature }`.
- **Hardware requirements**: 22 GB storage, >4 GB VRAM or 16 GB RAM,
  Chrome 138+, desktop only.
- **Model size**: ~2 GB download; purged if free space drops below 10 GB.
- **No network after download**: All inference is local; no data sent to Google.
- **TypeScript typings**: `@types/dom-chromium-ai` npm package.

### Abstraction Seam Analysis

The natural insertion point is between `PromoAnalysis.run()` and the direct
`callOpenRouterChat()` call. The adapter takes ownership of:

1. Building the messages array (system prompt + user content)
2. Making the LLM call (OpenRouter fetch or LanguageModel.prompt)
3. Parsing the raw response via `parseLlmPromoResponse()`
4. Returning a structured result with raw content preserved for logging

`PromoAnalysis.run()` retains responsibility for: abort management, prefs/config
gating, transcript merging, status store updates, log bundle emission, and
broadcasting blocks to content scripts.

## Entities

### New Entities

| Entity | Location | Description |
|--------|----------|-------------|
| `LlmProviderAdapter` | `src/background/llm/llm-provider-adapter.ts` | Interface: `id`, `displayName`, `availability()`, `analyzeTranscript()` |
| `LlmProviderAvailability` | same file | `{ status: 'available' \| 'downloadable' \| 'downloading' \| 'unavailable'; detail?: string }` |
| `AnalyzeTranscriptParams` | same file | `{ systemPrompt, userContent, signal, maxChars }` |
| `AnalyzeTranscriptResult` | same file | `{ ok: true; rawContent: string; hasPromo: boolean; blocks: PromoBlock[] } \| { ok: false; error: string }` |
| `OpenRouterAdapter` | `src/background/llm/openrouter-adapter.ts` | Wraps `callOpenRouterChat()` + `parseLlmPromoResponse()` |
| `ChromePromptApiAdapter` | `src/background/llm/chrome-prompt-api-adapter.ts` | Wraps `LanguageModel.create()` / `session.prompt()` with `responseConstraint`, context-window truncation, lifecycle logging |
| `ProviderRegistry` | `src/background/llm/provider-registry.ts` | Static map: `get(id)`, `getAll()`, `ids()` |
| `ActiveProviderStorage` | `src/background/storage/active-provider-storage.ts` | Valibot-validated persistence for `{ providerId: string }` under `topskip:active-provider` |
| `ProviderRuntimeMessages` | `src/background/messaging/provider-runtime-messages.ts` | Handles GET/SET active provider, provider list, Chrome availability check, model download trigger |

### New Shared Types (in `src/shared/messages.ts` / `src/shared/constants.ts`)

| Type / Constant | Description |
|-----------------|-------------|
| `LlmProviderId` | `string` (open type alias; known IDs: `'openrouter'`, `'chrome-prompt-api'`) |
| `STORAGE_KEY_ACTIVE_PROVIDER` | `'topskip:active-provider'` (in constants.ts) |
| `TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER` | Popup/options → background |
| `TOPSKIP_MESSAGE.SET_ACTIVE_PROVIDER` | Options → background |
| `TOPSKIP_MESSAGE.GET_PROVIDER_LIST` | Options → background (returns all registered providers with availability) |
| `TOPSKIP_MESSAGE.CHECK_CHROME_PROMPT_AVAILABILITY` | Options → background (returns current `LanguageModel.availability()` value) |
| `TOPSKIP_MESSAGE.TRIGGER_CHROME_MODEL_DOWNLOAD` | Options → background (initiates `LanguageModel.create({ monitor })`, streams progress back) |
| `GetActiveProviderResponse` | `{ ok: true; providerId: LlmProviderId; displayName: string } \| { ok: false; error: string }` |
| `SetActiveProviderResponse` | `{ ok: true } \| { ok: false; error: string }` |
| `ProviderListItem` | `{ id: LlmProviderId; displayName: string; available: boolean; detail?: string }` |
| `GetProviderListResponse` | `{ ok: true; providers: ProviderListItem[] } \| { ok: false; error: string }` |
| `ChromePromptAvailabilityResponse` | `{ ok: true; status: string } \| { ok: false; error: string }` |
| `TriggerChromeModelDownloadResponse` | `{ ok: true; progress?: number } \| { ok: false; error: string }` |

### Existing Entities (unchanged or minimally modified)

| Entity | Modification |
|--------|--------------|
| `PromoAnalysis` | Replace `callOpenRouterChat()` call with `ProviderRegistry.get(activeId).analyzeTranscript()` |
| `buildPromoAnalysisLogBundle` | Add `providerId` param alongside existing `model` |
| `OpenRouterStorage` | Unchanged — provider-specific config stays in its own storage key |
| `parseLlmPromoResponse` | Unchanged — called inside each adapter |
| `PROMO_DETECTION_SYSTEM_PROMPT` | Unchanged — passed to both adapters |
| `PromoDetectionStore` | Unchanged |
| `PreferencesStore` (popup) | Add `activeProviderId` and `activeProviderDisplayName` observables |
| `PopupApp` | Add provider/model label in status area |
| `OptionsApp` | Add provider selector, conditional config sections, onboarding widget |

## File Structure

### New Files

```text
src/background/llm/
├── llm-provider-adapter.ts          # Interface + shared result types
├── openrouter-adapter.ts            # OpenRouter adapter
├── chrome-prompt-api-adapter.ts     # Chrome Prompt API adapter
└── provider-registry.ts             # Static provider registry

src/background/storage/
└── active-provider-storage.ts       # Active provider persistence

src/background/messaging/
└── provider-runtime-messages.ts     # GET/SET provider, list, availability, download

tests/background/llm/
├── openrouter-adapter.test.ts
├── chrome-prompt-api-adapter.test.ts
└── provider-registry.test.ts

tests/background/storage/
└── active-provider-storage.test.ts

tests/background/messaging/
└── provider-runtime-messages.test.ts
```

### Modified Files

| File | Changes |
|------|---------|
| `src/shared/messages.ts` | Add `LlmProviderId`, 5 new `TOPSKIP_MESSAGE` entries, response types, union members |
| `src/shared/constants.ts` | Add `STORAGE_KEY_ACTIVE_PROVIDER` |
| `src/background/messaging/promo-analysis.ts` | Import `ProviderRegistry` + `ActiveProviderStorage`; replace `callOpenRouterChat` with adapter delegation |
| `src/background/messaging/register-runtime-messages.ts` | Import + chain `ProviderRuntimeMessages.handle()` |
| `src/background/openrouter/log-promo-analysis.ts` | Add `providerId` to `buildPromoAnalysisLogBundle` params; label it in the bundle header |
| `src/options/options.tsx` | Provider selector (segmented control / radio), conditional sections, Chrome onboarding widget |
| `src/popup/PopupApp.tsx` | Active provider label in status area; query `GET_ACTIVE_PROVIDER` on load |
| `src/popup/preferences-store.ts` | Add `activeProviderId`, `activeProviderDisplayName` observables; load from `GET_ACTIVE_PROVIDER` |
| `src/shared/openrouter-model-presets.ts` | Add `isValidOpenRouterModelSlug()` format validator (FR-021) |
| `package.json` | Add `@types/dom-chromium-ai` devDependency |
| `tsconfig.json` | Add `"dom-chromium-ai"` to `types` if needed (verify after install) |

### Files NOT Modified

- `src/background/openrouter/openrouter-client.ts` — still used internally by `OpenRouterAdapter`
- `src/background/openrouter/parse-llm-promo-response.ts` — called by both adapters
- `src/background/openrouter/promo-detection-system-prompt.ts` — imported by both adapters
- `src/background/promo-detection-store.ts` — unchanged
- `src/shared/promo-types.ts` — unchanged
- `src/manifest.json` — no new permissions needed
- `rspack.config.ts` — no new entries

## Task Breakdown

All tasks follow TDD: write the failing test first, then implement to green,
then refactor if needed. Tasks are ordered by dependency — each task's
prerequisites are satisfied by earlier tasks.

---

### Phase 1 — Foundation: Types & Dev Dependencies

#### Task 1.1: Install `@types/dom-chromium-ai`

**What**: Add the TypeScript type package for Chrome's built-in AI APIs.

**Steps**:
1. `pnpm add -D @types/dom-chromium-ai`
2. Verify `LanguageModel` is recognized in TypeScript (`tsc --noEmit`)
3. If needed, add `"dom-chromium-ai"` to `tsconfig.json` `compilerOptions.types`

**Verify**: `pnpm run lint:types` passes with the new types available.

**Files**: `package.json`, `pnpm-lock.yaml`, possibly `tsconfig.json`

---

#### Task 1.2: Add shared constants and message types

**What**: Add `STORAGE_KEY_ACTIVE_PROVIDER`, `LlmProviderId` type, new
`TOPSKIP_MESSAGE` entries, and response type definitions.

**Test**: Compile-time — `lint:types` verifies the types are consistent.

**Steps**:
1. In `src/shared/constants.ts`: add `STORAGE_KEY_ACTIVE_PROVIDER = 'topskip:active-provider'`
2. In `src/shared/messages.ts`:
   - Add `LlmProviderId` as a `string` type alias (open, not a closed
     union — SC-005 requires adding future providers without touching
     message types). The two known IDs (`'openrouter'`,
     `'chrome-prompt-api'`) are documented as constants but not enforced
     at the type level
   - Add 5 message type constants to `TOPSKIP_MESSAGE`:
     `GET_ACTIVE_PROVIDER`, `SET_ACTIVE_PROVIDER`, `GET_PROVIDER_LIST`,
     `CHECK_CHROME_PROMPT_AVAILABILITY`, `TRIGGER_CHROME_MODEL_DOWNLOAD`
   - Add response types: `GetActiveProviderResponse`,
     `SetActiveProviderResponse`, `ProviderListItem`,
     `GetProviderListResponse`, `ChromePromptAvailabilityResponse`,
     `TriggerChromeModelDownloadResponse`
   - Add new union members to `TopSkipRuntimeMessage`

**Verify**: `pnpm run lint:types`

**Files**: `src/shared/constants.ts`, `src/shared/messages.ts`

---

#### Task 1.3: Define `LlmProviderAdapter` interface

**What**: Create the adapter interface and its input/output types in the
background bundle.

**Test**: `tests/background/llm/llm-provider-adapter.test.ts` — verify a mock
object satisfying the interface compiles and type-checks (use `satisfies`).
Verify `AnalyzeTranscriptResult` discriminated union works with narrowing.

**Steps**:
1. Create `src/background/llm/llm-provider-adapter.ts` with:
   ```typescript
   export type LlmProviderAvailability = {
     status: 'available' | 'downloadable' | 'downloading' | 'unavailable';
     detail?: string;
   };

   export type AnalyzeTranscriptParams = {
     systemPrompt: string;
     userContent: string;
     signal: AbortSignal;
   };

   export type AnalyzeTranscriptResult =
     | { ok: true; rawContent: string; hasPromo: boolean; blocks: PromoBlock[] }
     | { ok: false; error: string };

   export interface LlmProviderAdapter {
     readonly id: string;
     readonly displayName: string;
     availability(): Promise<LlmProviderAvailability>;
     analyzeTranscript(params: AnalyzeTranscriptParams): Promise<AnalyzeTranscriptResult>;
   }
   ```
2. Write the test file verifying mock conformance and result narrowing.

**Verify**: `pnpm run test -- llm-provider-adapter`

**Files**: `src/background/llm/llm-provider-adapter.ts`,
`tests/background/llm/llm-provider-adapter.test.ts`

---

### Phase 2 — Storage: Active Provider Persistence

#### Task 2.1: Implement `ActiveProviderStorage`

**What**: A static-only class (like `OpenRouterStorage`) that reads/writes the
active provider ID from `browser.storage.local` with Valibot validation.
Defaults to `'openrouter'` for backward compatibility.

**Test**: `tests/background/storage/active-provider-storage.test.ts`
- Mock `browser.storage.local.get` / `.set`
- Test `load()` returns `'openrouter'` when storage is empty (default)
- Test `load()` returns stored value when present
- Test `save(id)` writes to storage
- Test `load()` rejects invalid values (falls back to default)

**Steps**:
1. Create `src/background/storage/active-provider-storage.ts`:
   - Valibot schema: `v.object({ providerId: v.string() })`
   - `load(): Promise<string>` — get from storage, parse, fallback to
     `'openrouter'`
   - `save(providerId: string): Promise<void>` — write to storage
2. Write the test file.

**Verify**: `pnpm run test -- active-provider-storage`

**Files**: `src/background/storage/active-provider-storage.ts`,
`tests/background/storage/active-provider-storage.test.ts`

---

### Phase 3 — Adapters

#### Task 3.1: Implement `OpenRouterAdapter`

**What**: Wrap `callOpenRouterChat()` + `parseLlmPromoResponse()` behind
`LlmProviderAdapter`. Reads `OpenRouterStorage` for API key and model. Returns
availability based on whether OpenRouter is configured.

**Test**: `tests/background/llm/openrouter-adapter.test.ts`
- Mock `callOpenRouterChat` and `OpenRouterStorage.load`
- Test `id` is `'openrouter'`, `displayName` is `'OpenRouter'`
- Test `availability()` returns `'available'` when config has apiKey + model +
  enabled
- Test `availability()` returns `'unavailable'` when config is incomplete
- Test `analyzeTranscript()` calls `callOpenRouterChat` with correct params and
  delegates to `parseLlmPromoResponse`
- Test `analyzeTranscript()` propagates `callOpenRouterChat` error as
  `{ ok: false }`
- Test `analyzeTranscript()` propagates parse failure as `{ ok: false }`

**Steps**:
1. Create `src/background/llm/openrouter-adapter.ts`:
   ```typescript
   export class OpenRouterAdapter implements LlmProviderAdapter {
     readonly id = 'openrouter';
     readonly displayName = 'OpenRouter';
     async availability(): Promise<LlmProviderAvailability> { ... }
     async analyzeTranscript(params): Promise<AnalyzeTranscriptResult> { ... }
   }
   ```
2. Inside `analyzeTranscript`: load config from `OpenRouterStorage`,
   build messages array, call `callOpenRouterChat`, call
   `parseLlmPromoResponse` on raw content, return structured result.
3. Write the test file.

**Verify**: `pnpm run test -- openrouter-adapter`

**Files**: `src/background/llm/openrouter-adapter.ts`,
`tests/background/llm/openrouter-adapter.test.ts`

---

#### Task 3.2: Implement `ChromePromptApiAdapter`

**What**: Wrap Chrome's `LanguageModel.create()` / `session.prompt()` behind
`LlmProviderAdapter`. Uses `responseConstraint` JSON Schema for output format
(FR-015). Truncates transcript for context window (FR-011). Emits structured
diagnostic logs (FR-023).

**Test**: `tests/background/llm/chrome-prompt-api-adapter.test.ts`
- Mock global `LanguageModel` (define on `globalThis` in test setup)
- Test `id` is `'chrome-prompt-api'`, `displayName` is
  `'Chrome Built-in (Gemini Nano)'`
- Test `availability()` delegates to `LanguageModel.availability()` and maps
  each status value
- Test `availability()` returns `{ status: 'unavailable' }` when
  `LanguageModel` is not defined on `globalThis`
- Test `analyzeTranscript()` creates a session, calls `prompt()` with
  `responseConstraint`, parses response, destroys session
- Test `analyzeTranscript()` truncates user content when it exceeds
  `session.contextWindow` (FR-011) and logs a warning
- Test `analyzeTranscript()` passes `signal` to both `create()` and
  `prompt()` (FR-016)
- Test `analyzeTranscript()` returns `{ ok: false }` when `LanguageModel` is
  unavailable
- Test `analyzeTranscript()` returns `{ ok: false }` on session creation
  failure
- Test `analyzeTranscript()` returns `{ ok: false }` on prompt rejection
- Test diagnostic log calls at each lifecycle point (FR-023):
  availability check, session creation, truncation warning, prompt dispatch,
  result, errors

**Steps**:
1. Create `src/background/llm/chrome-prompt-api-adapter.ts`:
   ```typescript
   export class ChromePromptApiAdapter implements LlmProviderAdapter {
     readonly id = 'chrome-prompt-api';
     readonly displayName = 'Chrome Built-in (Gemini Nano)';

     async availability(): Promise<LlmProviderAvailability> {
       // Check if LanguageModel is on globalThis
       // Call LanguageModel.availability()
       // Map to LlmProviderAvailability
       // Log result (FR-023)
     }

     async analyzeTranscript(params): Promise<AnalyzeTranscriptResult> {
       // Check availability
       // Create session with signal + monitor
       // Log session info (contextWindow, etc.) (FR-023)
       // Truncate userContent if exceeds context budget (FR-011)
       // Call session.prompt() with responseConstraint (FR-015)
       // Parse response
       // Destroy session
       // Return result
     }
   }
   ```
2. Define the `responseConstraint` JSON Schema matching the
   `llmPromoDetectionSchema` (Valibot schema in
   `src/shared/openrouter-llm-schema.ts` → convert to JSON Schema object).
3. Write the test file with `globalThis.LanguageModel` mocks.

**Verify**: `pnpm run test -- chrome-prompt-api-adapter`

**Files**: `src/background/llm/chrome-prompt-api-adapter.ts`,
`tests/background/llm/chrome-prompt-api-adapter.test.ts`

**FR coverage**: FR-002, FR-011, FR-015, FR-016, FR-023

---

### Phase 4 — Registry

#### Task 4.1: Implement `ProviderRegistry`

**What**: A static class that holds the map of provider ID → adapter instance.
Initialized with `OpenRouterAdapter` and `ChromePromptApiAdapter`.

**Test**: `tests/background/llm/provider-registry.test.ts`
- Test `get('openrouter')` returns the `OpenRouterAdapter` instance
- Test `get('chrome-prompt-api')` returns the `ChromePromptApiAdapter` instance
- Test `get('nonexistent')` returns `undefined`
- Test `getAll()` returns both adapters
- Test `ids()` returns `['openrouter', 'chrome-prompt-api']`

**Steps**:
1. Create `src/background/llm/provider-registry.ts`:
   ```typescript
   export class ProviderRegistry {
     private constructor() {}
     private static readonly adapters = new Map<string, LlmProviderAdapter>([
       ['openrouter', new OpenRouterAdapter()],
       ['chrome-prompt-api', new ChromePromptApiAdapter()],
     ]);
     static get(id: string): LlmProviderAdapter | undefined { ... }
     static getAll(): LlmProviderAdapter[] { ... }
     static ids(): string[] { ... }
   }
   ```
2. Write the test file.

**Verify**: `pnpm run test -- provider-registry`

**Files**: `src/background/llm/provider-registry.ts`,
`tests/background/llm/provider-registry.test.ts`

**FR coverage**: FR-004

---

### Phase 5 — Pipeline Integration

#### Task 5.1: Refactor `PromoAnalysis.run()` to use adapter

**What**: Replace the direct `callOpenRouterChat()` call with adapter
delegation. Load active provider from `ActiveProviderStorage`, resolve adapter
from `ProviderRegistry`, call `analyzeTranscript()`.

**Test**: `tests/background/messaging/promo-analysis-adapter.test.ts`
- Mock `ActiveProviderStorage.load`, `ProviderRegistry.get`,
  `PrefsSyncStorage`, `OpenRouterStorage`
- Test: active provider is `'openrouter'` → adapter's `analyzeTranscript` is
  called (not `callOpenRouterChat` directly)
- Test: active provider is `'chrome-prompt-api'` → Chrome adapter's
  `analyzeTranscript` is called
- Test: unknown provider → sets error status
- Test: adapter returns `{ ok: false }` → sets error status + logs
- Test: adapter returns promo blocks → sets detected status + broadcasts
- Test: abort still works (existing inflight pattern)

**Steps**:
1. Modify `src/background/messaging/promo-analysis.ts`:
   - Remove direct import of `callOpenRouterChat`
   - Import `ActiveProviderStorage`, `ProviderRegistry`
   - In `run()`, after transcript merge:
     ```typescript
     const activeId = await ActiveProviderStorage.load();
     const adapter = ProviderRegistry.get(activeId);
     if (!adapter) {
       setStatus({ videoId, status: 'error', error: `Unknown provider: ${activeId}` });
       return;
     }
     const result = await adapter.analyzeTranscript({
       systemPrompt: PROMO_DETECTION_SYSTEM_PROMPT,
       userContent,
       signal: abort.signal,
     });
     ```
   - Replace the existing `callOpenRouterChat` + `parseLlmPromoResponse`
     block with result handling from `adapter.analyzeTranscript`
   - Keep the existing abort-check, status updates, and log bundle emission
   - Remove the OpenRouter-specific config checks (apiKey/model length) —
     the adapter's `availability()` or `analyzeTranscript()` handles those
     internally
2. Write the test file.

**Verify**: `pnpm run test -- promo-analysis`

**Files**: `src/background/messaging/promo-analysis.ts`,
`tests/background/messaging/promo-analysis-adapter.test.ts`

**FR coverage**: FR-006

---

#### Task 5.2: Extend `buildPromoAnalysisLogBundle` for provider parity

**What**: Add `providerId` to the bundle params so the log output identifies
which provider produced the result (FR-024).

**Test**: Update or add test in `tests/background/openrouter/` verifying the
bundle includes the provider ID line.

**Steps**:
1. In `src/background/openrouter/log-promo-analysis.ts`:
   - Add to the `buildPromoAnalysisLogBundle` params type:
     - `providerId: string` — which adapter produced the result
     - `availabilityAtCallTime?: string` — Chrome adapter's availability state
     - `contextWindowSize?: number` — session.contextWindow (Chrome only)
     - `transcriptTruncatedForContextWindow?: boolean` — whether the adapter
       trimmed the transcript to fit the context window
   - Rename the `openRouterModel` label in the bundle header to a generic
     `model` label; add `provider: ${params.providerId}` line
   - When present, include Chrome-specific lines:
     `availabilityAtCallTime`, `contextWindowSize`,
     `transcriptTruncatedForContextWindow`
2. Update callers in `promo-analysis.ts` to pass all fields (the adapter
   result or a metadata struct provides them).
3. Consider adding a `metadata` bag to `AnalyzeTranscriptResult` so the
   adapter can return provider-specific log fields without the pipeline
   knowing their shape:
   ```typescript
   type AnalyzeTranscriptResult =
     | { ok: true; rawContent: string; hasPromo: boolean;
         blocks: PromoBlock[]; metadata?: Record<string, unknown> }
     | { ok: false; error: string; metadata?: Record<string, unknown> };
   ```
4. Write/update the test to verify the bundle includes provider ID and
   Chrome-specific fields when present.

**Verify**: `pnpm run test -- log-promo-analysis`

**Files**: `src/background/openrouter/log-promo-analysis.ts`,
`src/background/messaging/promo-analysis.ts`

**FR coverage**: FR-024

---

### Phase 6 — Messaging: Provider Runtime Messages

#### Task 6.1: Implement `ProviderRuntimeMessages` handler

**What**: Handle the 5 new message types (GET/SET active provider, provider
list, Chrome availability, model download trigger).

**Test**: `tests/background/messaging/provider-runtime-messages.test.ts`
- Mock `ActiveProviderStorage`, `ProviderRegistry`, and
  `globalThis.LanguageModel`
- Test `GET_ACTIVE_PROVIDER` returns current provider ID + display name
- Test `SET_ACTIVE_PROVIDER` saves new provider ID and returns `{ ok: true }`
- Test `SET_ACTIVE_PROVIDER` with unknown ID returns `{ ok: false }`
- Test `GET_PROVIDER_LIST` returns all providers with availability
- Test `CHECK_CHROME_PROMPT_AVAILABILITY` returns current availability status
- Test `TRIGGER_CHROME_MODEL_DOWNLOAD` initiates download (mock
  `LanguageModel.create`) and returns ok

**Steps**:
1. Create `src/background/messaging/provider-runtime-messages.ts`:
   ```typescript
   export class ProviderRuntimeMessages {
     private constructor() {}
     static handle(
       message: unknown,
       sender: Runtime.MessageSender,
     ): Promise<unknown> | undefined { ... }
   }
   ```
2. Write the test file.

**Verify**: `pnpm run test -- provider-runtime-messages`

**Files**: `src/background/messaging/provider-runtime-messages.ts`,
`tests/background/messaging/provider-runtime-messages.test.ts`

**FR coverage**: FR-012

---

#### Task 6.2: Register provider handler in message chain

**What**: Add `ProviderRuntimeMessages.handle()` to the
`registerRuntimeMessages()` chain.

**Steps**:
1. In `src/background/messaging/register-runtime-messages.ts`:
   - Import `ProviderRuntimeMessages`
   - Add handler call in the chain (before `PrefsRuntimeMessages` — provider
     messages should resolve before prefs fallback):
     ```typescript
     const provider = ProviderRuntimeMessages.handle(message, sender);
     if (provider !== undefined) {
       return provider;
     }
     ```

**Verify**: `pnpm run lint:types`

**Files**: `src/background/messaging/register-runtime-messages.ts`

---

### Phase 7 — Model Slug Validation

#### Task 7.1: Add `isValidOpenRouterModelSlug()` format validator

**What**: Validate that custom model slugs match `owner/model-name` format
(FR-021). Pure function, no I/O.

**Test**: `tests/shared/openrouter-model-presets.test.ts` (or extend existing)
- Valid: `'google/gemini-3.1-pro-preview'`, `'openai/gpt-4o'`,
  `'meta-llama/llama-3-8b'`
- Invalid: `'test'`, `''`, `'/'`, `'a/'`, `'/b'`, `'a/b/c'` (three segments),
  strings with spaces

**Steps**:
1. In `src/shared/openrouter-model-presets.ts`: add
   ```typescript
   export function isValidOpenRouterModelSlug(slug: string): boolean {
     return /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?\/[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/.test(slug);
   }
   ```
   (Case-insensitive variant if needed — OpenRouter slugs are lowercase.)
2. Write/extend tests.

**Verify**: `pnpm run test -- openrouter-model-presets`

**Files**: `src/shared/openrouter-model-presets.ts`,
`tests/shared/openrouter-model-presets.test.ts`

**FR coverage**: FR-021, FR-022

---

#### Task 7.2: Enforce slug validation in `ADD_OPENROUTER_CUSTOM_MODEL` handler

**What**: Reject invalid slugs in the existing OpenRouter runtime messages
handler.

**Test**: Extend `tests/background/messaging/openrouter-runtime-messages.test.ts`
- Test: adding `'test/test'` format slug succeeds (format valid even if
  unverified on OpenRouter)
- Test: adding `'invalid'` (no slash) returns `{ ok: false }` with format error
- Test: adding empty string returns `{ ok: false }`

**Steps**:
1. In the `ADD_OPENROUTER_CUSTOM_MODEL` handler: call
   `isValidOpenRouterModelSlug(slug)` before saving; return error if invalid.
2. Write/extend tests.

**Verify**: `pnpm run test -- openrouter-runtime-messages`

**Files**: `src/background/messaging/openrouter-runtime-messages.ts`

**FR coverage**: FR-021

---

### Phase 8 — UI: Options Page

#### Task 8.1: Provider selector on options page

**What**: Add a segmented control (or radio group) at the top of the options
form, listing all registered providers with their availability status. Selecting
a provider conditionally shows/hides config sections (FR-007, FR-008).

**Steps**:
1. Add state: `activeProvider: LlmProviderId`, `providerList: ProviderListItem[]`
2. On load: send `GET_ACTIVE_PROVIDER` and `GET_PROVIDER_LIST` to background
3. Render a Mantine `SegmentedControl` (or `Radio.Group`) with provider options:
   - Each option shows `displayName` and an availability badge
   - Unavailable providers are disabled with a tooltip (FR-010)
4. On provider change: update local state; conditionally render sections:
   - `'openrouter'`: show API key, model selector, custom model management
     (existing UI)
   - `'chrome-prompt-api'`: show onboarding widget (Task 8.2), hide model
     selector / API key / custom model fields (FR-008)
5. On save: validate provider-specific prerequisites before sending:
   - `'openrouter'`: require API key (existing `savedApiKeyMasked` or new
     `apiKey` input); show validation error and prevent save if missing
     (US-3 SC-2)
   - `'chrome-prompt-api'`: require `availability === 'available'`; disable
     save if model not ready
   Then send `SET_ACTIVE_PROVIDER` alongside existing `SET_OPENROUTER_CONFIG`

**Verify**: Manual test in browser; `pnpm run build` + `pnpm run lint`

**Files**: `src/options/options.tsx`

**FR coverage**: FR-007, FR-008, FR-010

---

#### Task 8.2: Chrome Built-in onboarding widget

**What**: A multi-state widget that maps to `LanguageModel.availability()`
states (FR-017). Checks availability on mount and on tab focus (FR-018).
Download is user-initiated (FR-020).

**Steps**:
1. Add state: `chromeAvailability: string`, `downloadProgress: number | null`
2. On mount (when Chrome Built-in is selected): send
   `CHECK_CHROME_PROMPT_AVAILABILITY` to background
3. Render based on `chromeAvailability`:
   - `'unavailable'` → greyed card with hardware requirements text + link to
     Chrome AI docs
   - `'downloadable'` → info card with model details + "Download model" button
   - `'downloading'` → progress bar (from `downloadProgress`); save disabled
   - `'available'` → green "Ready — Gemini Nano" badge; save enabled
4. "Download model" button sends `TRIGGER_CHROME_MODEL_DOWNLOAD`; background
   calls `LanguageModel.create({ monitor })` and returns `{ ok: true }` once
   initiated. The options page then polls `CHECK_CHROME_PROMPT_AVAILABILITY`
   on a 1.5 s interval until the status changes from `'downloading'` to
   `'available'` or `'downloadable'` (failure/retry). Background keeps a
   module-level session reference so `availability()` accurately returns
   `'downloading'` while in progress. On error or interruption the session
   is destroyed and availability falls back to `'downloadable'`, showing a
   "Download interrupted — Retry" state in the UI
5. Re-check availability when options page regains focus (`visibilitychange`
   event) (FR-018)

**Verify**: `pnpm run test -- chrome-onboarding-widget` + manual test in
browser; `pnpm run build`

**Files**: `src/options/options.tsx`,
`tests/options/chrome-onboarding-widget.test.ts`

**FR coverage**: FR-017, FR-018, FR-020

**Required unit tests** (SC-008):
- Mock `CHECK_CHROME_PROMPT_AVAILABILITY` response for each of the 4 states
- Verify correct UI rendering: greyed card (`unavailable`), download button
  (`downloadable`), progress bar (`downloading`), green badge (`available`)
- Verify `visibilitychange` triggers re-check
- Verify download button sends `TRIGGER_CHROME_MODEL_DOWNLOAD`

---

#### Task 8.3: Model slug validation feedback in UI

**What**: Show inline validation error when a custom model slug doesn't match
`owner/model-name` format (FR-021).

**Steps**:
1. In the "Add custom model" TextInput: validate `newModelDraft` on blur or
   submit using `isValidOpenRouterModelSlug()`
2. Show Mantine `TextInput` `error` prop with descriptive message
3. Disable "Add" button when format is invalid

**Verify**: Manual test; `pnpm run build`

**Files**: `src/options/options.tsx`

**FR coverage**: FR-021

---

### Phase 9 — UI: Popup

#### Task 9.1: Add active provider to `PreferencesStore`

**What**: Extend the MobX store with `activeProviderId` and
`activeProviderDisplayName` observables loaded via `GET_ACTIVE_PROVIDER`.

**Test**: `tests/popup/preferences-store.test.ts`
- Test: `loadActiveProvider()` sets observables from message response
- Test: observables default to `'openrouter'` / `'OpenRouter'`

**Steps**:
1. In `src/popup/preferences-store.ts`:
   - Add `activeProviderId = 'openrouter'` observable
   - Add `activeProviderDisplayName = 'OpenRouter'` observable
   - Add `loadActiveProvider()` method: sends `GET_ACTIVE_PROVIDER`, updates
     observables in `runInAction`
2. Extend tests.

**Verify**: `pnpm run test -- preferences-store`

**Files**: `src/popup/preferences-store.ts`,
`tests/popup/preferences-store.test.ts`

**FR coverage**: FR-014

---

#### Task 9.2: Display active provider in popup

**What**: Show a provider/model label in the popup status area (FR-009).

**Steps**:
1. In `PopupApp`: call `store.loadActiveProvider()` in the init `useEffect`
2. In the status area (below the hero card): render a `Text` element showing:
   - `"OpenRouter · {model}"` when `activeProviderId === 'openrouter'`
   - `"Chrome Built-in · Gemini Nano"` when
     `activeProviderId === 'chrome-prompt-api'`
3. When provider is `'openrouter'` with no config: show provider name +
   "Not configured" badge (US-2 SC-3)
4. When Chrome Built-in is selected but model not ready: show brief note
   (FR-019)

**Verify**: Manual test in browser; `pnpm run build`

**Files**: `src/popup/PopupApp.tsx`

**FR coverage**: FR-009, FR-019

---

### Phase 10 — Validation & Cleanup

#### Task 10.1: Full lint + type check + build

**Steps**:
1. `pnpm run lint`
2. `pnpm run build`
3. Fix any errors

---

#### Task 10.2: Run unit tests with coverage

**Steps**:
1. `pnpm run test:coverage`
2. Optionally extend `vitest.config.ts` coverage `include` to cover new adapter
   files if they contain substantial logic
3. All existing + new tests must pass

---

#### Task 10.3: Run E2E tests

**What**: Verify existing E2E tests still pass (SC-007). The OpenRouter path is
unchanged behind the adapter; existing fixtures should work.

**Steps**:
1. `pnpm run build`
2. `pnpm run test:e2e`
3. Fix any regressions

---

#### Task 10.4: Update spec docs if behavior changed

**Steps**:
1. If any FR semantics shifted during implementation, update
   `.sdd/.current/spec.md` in the same PR
2. Review `TODO.md` for items resolved by this feature

---

## Dependency Graph

```text
Task 1.1 (types pkg)
  └─► Task 1.3 (adapter interface) ─────────────────────────┐
Task 1.2 (constants + messages) ──► Task 2.1 (storage) ──┐  │
                                                          │  │
                                    Task 3.1 (OR adapter) ◄──┤
                                    Task 3.2 (Chrome adapter) ◄─┐
                                                          │  │  │
                                    Task 4.1 (registry) ◄─┴──┘  │
                                         │                       │
                              Task 5.1 (pipeline refactor) ◄─────┘
                              Task 5.2 (log bundle)
                                         │
                              Task 6.1 (provider messages) ◄── Task 2.1
                              Task 6.2 (register handler)
                                         │
                    ┌────────────────────┤
                    │                    │
             Task 8.1 (options selector) │
             Task 8.2 (onboarding widget)│
             Task 8.3 (slug validation UI)
                    │                    │
             Task 9.1 (popup store)      │
             Task 9.2 (popup display)    │
                    │                    │
             Task 7.1 (slug validator) ──┘ (independent, pure fn)
             Task 7.2 (slug enforcement)
                    │
             Task 10.x (validation)
```

## Risk Notes

- **`@types/dom-chromium-ai` freshness**: The type package may lag behind the
  Chrome implementation. If types are missing, add local `declare global`
  augmentations in `src/build-globals.d.ts` until the package catches up.
- **Gemini Nano context window**: The exact token budget is unknown ahead of
  time; it comes from `session.contextWindow` at runtime. The adapter must
  estimate characters-to-tokens conservatively (e.g., 1 token ≈ 4 chars) and
  truncate accordingly. This heuristic may need tuning.
- **Model download UX complexity**: The download is triggered by
  `LanguageModel.create({ monitor })` which is async. If the options page is
  closed mid-download, re-opening it must poll `availability()` to detect
  completion. The `TRIGGER_CHROME_MODEL_DOWNLOAD` message may need to keep a
  module-level session reference in the background to track progress.
- **Service worker lifetime**: The MV3 service worker can be killed during long
  Gemini Nano inference. If `session.prompt()` takes >30s, Chrome may terminate
  the worker. The adapter should handle rejection gracefully. Consider using
  `chrome.runtime.onSuspend` to destroy sessions proactively.
- **E2E test compatibility**: Existing E2E tests don't test OpenRouter calls
  (they use local fixtures). The adapter refactor should not affect them, but
  verify by running `test:e2e` after Phase 5.
