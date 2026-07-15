# Implementation Plan: Model-First LLM Settings

**Created**: 2026-05-21
**Status**: Validated
**Input**: Feature specification from `.sdd/20260521-model-first-llm-settings/spec.md`
**Model**: GPT-5 Codex (medium)
**User Input**: No additional constraints

## Summary

Convert TopSkip settings from provider-first to model-first. The options page
will expose one primary active model control, separate API key connections, an
OpenRouter add-model flow, OpenAI support, and model-first popup labels. The
background pipeline can keep provider adapters internally; `activeModelId`
becomes the UI/source-of-truth preference and `providerId` remains a derived
compatibility field for existing provider routing during this change.

## Technical Context

**Language/Version**: TypeScript 6.0.2, strict ESM.
**Primary Dependencies**: React 19.2, Mantine 9, MobX 6, Valibot 1.3, webextension-polyfill, Rspack.
**Storage**: `browser.storage.local`, background-only for prefs and provider keys.
**Testing**: Vitest 4 for unit/render tests, Playwright for extension E2E.
**Target Platform**: Chrome Manifest V3 extension, unpacked from `dist/`.
**Project Type**: Single-package extension repo.
**Performance Goals**: No new repeated network calls during normal settings render; key/model validation only on explicit user action.
**Constraints**: Popup/options/content must use runtime messaging for settings; provider secrets never leave background responses unmasked.
**Scale/Scope**: One active model at a time; OpenRouter, OpenAI, and Chrome built-in in scope.

## Research

### Existing Architecture

- `src/shared/providers.ts` defines provider IDs. Add `OpenAI` there so every bundle uses one literal source.
- `src/background/providers/*-adapter.ts` already hides provider-specific analysis behind `LlmProviderAdapter`; adding `OpenAiAdapter` fits the current pattern.
- `src/background/storage/openrouter-storage.ts` owns OpenRouter key/model/custom model storage. Create parallel `openai-storage.ts` for OpenAI key/model config instead of overloading OpenRouter storage.
- `src/options/options.tsx` currently owns provider selection and OpenRouter form state. Refactor by extracting model and connection panels, but keep same options page shell/sidebar.
- `src/shared/messages.ts` is the central runtime message contract. New model-first messages belong there.

### OpenAI API

Official OpenAI docs currently expose `POST https://api.openai.com/v1/responses`
for model responses and `GET https://api.openai.com/v1/models` for model/key
availability checks. The implementation should use `Authorization: Bearer
<key>` and parse JSON as `unknown` before validation. Sources:
[Responses API](https://platform.openai.com/docs/api-reference/responses),
[Models API](https://platform.openai.com/docs/api-reference/models/list).

### Key Testing

OpenRouter custom model validation already calls `https://openrouter.ai/api/v1/models`
through `src/background/openrouter/openrouter-models-api.ts`. Reuse that endpoint
for OpenRouter key testing. For OpenAI, use `GET /v1/models`; a 401 is invalid,
429/5xx/network is retryable, and a 2xx list response is valid.

## Entities

### Detection Model

- **Fields**:
    - `id`: string - stable active model ID, e.g. `openrouter:google/gemini-3.1-pro-preview`, `openai:gpt-5.2`, `chrome-prompt-api:gemini-nano`
    - `label`: string - user-facing label
    - `providerId`: `ProviderId` - internal adapter route
    - `providerLabel`: string - secondary UI context
    - `modelName`: string - provider-specific model ID
    - `requiresConnection`: boolean - whether API key setup is required
- **Relationships**: Active model derives the active provider route.
- **Validation**: ID must resolve in built-in catalog or OpenRouter custom list.
- **States**: `available`, `downloadable`, `downloading`, `unavailable`.

### Connection Entry

- **Fields**:
    - `providerId`: `openrouter | openai`
    - `providerLabel`: string
    - `apiKeyMasked`: string | null
    - `requiredForActiveModel`: boolean
    - `status`: `missing | saved`
- **Relationships**: Required when active model's provider needs a key.
- **Validation**: Raw key is accepted only by background save/test messages.
- **States**: missing -> draft -> tested -> saved; saved -> tested.

### Active Model Choice

- **Fields**:
    - `activeModelId`: string
    - `providerId`: string compatibility route derived from `activeModelId`
- **Relationships**: `PrefsSyncStorage` persists it with existing `enabled`.
- **Validation**: Unknown IDs fall back to a default OpenRouter model.

## Contracts

See `.sdd/20260521-model-first-llm-settings/contracts/runtime-messages.md`.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/shared/providers.ts` | Modify | Add `PROVIDER_ID.OpenAI`. |
| `src/shared/constants.ts` | Modify | Add `activeModelId` to user preferences schema and default prefs. |
| `src/shared/detection-models.ts` | Create | Model catalog helpers, model ID builders/parsers, default model. |
| `tests/shared/detection-models.test.ts` | Create | Model catalog and active model resolution tests. |
| `src/background/storage/openai-storage.ts` | Create | Background-only OpenAI key/model storage. |
| `tests/background/storage/openai-storage.test.ts` | Create | OpenAI storage validation/masking tests. |
| `src/background/openai/openai-client.ts` | Create | OpenAI Responses API call and key test helper. |
| `tests/background/openai/openai-client.test.ts` | Create | OpenAI HTTP parsing and error classification tests. |
| `src/background/providers/openai-adapter.ts` | Create | `LlmProviderAdapter` for OpenAI. |
| `tests/background/providers/openai-adapter.test.ts` | Create | OpenAI adapter availability and analysis tests. |
| `src/background/providers/default-registry.ts` | Modify | Register `OpenAiAdapter`. |
| `src/background/storage/prefs-sync.ts` | Modify | Migrate provider-first prefs to model-first prefs. |
| `tests/background/storage/prefs-sync.test.ts` | Create/modify | Active model migration tests. |
| `src/background/messaging/model-runtime-messages.ts` | Create | GET/SET active model and connection save/test handlers. |
| `src/background/messaging/register-runtime-messages.ts` | Modify | Dispatch model-first runtime messages. |
| `src/shared/messages.ts` | Modify | Add message constants and response types. |
| `tests/background/messaging/model-runtime-messages.test.ts` | Create | Runtime handler unit tests. |
| `src/options/ModelSelectionPanel.tsx` | Create | Model-first picker/status UI. |
| `src/options/ConnectionsPanel.tsx` | Create | OpenRouter/OpenAI key save/test UI. |
| `src/options/AddModelPanel.tsx` | Create | OpenRouter custom model add/edit/remove UI. |
| `src/options/options.tsx` | Modify | Replace provider cards with model/connection/add-model panels. |
| `tests/options/model-first-settings.test.ts` | Create | Server-render model-first options components. |
| `src/popup/preferences-store.ts` | Modify | Load active model label instead of provider-first label. |
| `src/popup/popup-view-model.ts` | Modify | Prioritize model label in popup display. |
| `tests/popup/*.test.ts` | Modify | Update popup expectations to model-first labels. |

## Tasks

### [x] Task 1: Shared Provider IDs and Detection Model Catalog

**Files:**

- Modify: `src/shared/providers.ts:10-16`
- Create: `src/shared/detection-models.ts`
- Test: `tests/shared/detection-models.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';

import {
    buildOpenRouterModelId,
    DEFAULT_DETECTION_MODEL_ID,
    getBuiltinDetectionModels,
    resolveDetectionModel,
} from '@/shared/detection-models';
import { PROVIDER_ID } from '@/shared/providers';

describe('detection model catalog', () => {
    it('includes OpenRouter, OpenAI, and Chrome built-in models', () => {
        const models = getBuiltinDetectionModels();
        expect(models.some((m) => m.providerId === PROVIDER_ID.OpenRouter)).toBe(true);
        expect(models.some((m) => m.providerId === PROVIDER_ID.OpenAI)).toBe(true);
        expect(models.some((m) => m.providerId === PROVIDER_ID.ChromePromptApi)).toBe(true);
    });

    it('builds and resolves custom OpenRouter model ids', () => {
        const id = buildOpenRouterModelId('meta-llama/llama-3.1-8b-instruct');
        const model = resolveDetectionModel(id, ['meta-llama/llama-3.1-8b-instruct']);
        expect(model).toEqual(
            expect.objectContaining({
                id,
                providerId: PROVIDER_ID.OpenRouter,
                modelName: 'meta-llama/llama-3.1-8b-instruct',
                requiresConnection: true,
            }),
        );
    });

    it('falls back to default for unknown ids', () => {
        expect(resolveDetectionModel('bad:id', [])?.id).toBe(DEFAULT_DETECTION_MODEL_ID);
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/shared/detection-models.test.ts`
Expected: FAIL with missing `@/shared/detection-models` or `PROVIDER_ID.OpenAI`.

- [x] **Step 3: Write minimal implementation**

Add `OpenAI: 'openai'` to `PROVIDER_ID`, then create `src/shared/detection-models.ts`:

```ts
import { CHROME_PROMPT_API_MODEL_NAME } from '@/shared/chrome-prompt-api';
import {
    OPENROUTER_DEFAULT_MODEL_SLUG,
    OPENROUTER_MODEL_PRESETS,
} from '@/shared/openrouter-model-presets';
import { PROVIDER_ID, type ProviderId } from '@/shared/providers';

export type DetectionModel = {
    id: string;
    label: string;
    providerId: ProviderId;
    providerLabel: string;
    modelName: string;
    requiresConnection: boolean;
};

export const OPENAI_MODEL_PRESETS = [
    { value: 'gpt-5.2', label: 'GPT-5.2' },
    { value: 'gpt-5-mini', label: 'GPT-5 mini' },
    { value: 'gpt-5-nano', label: 'GPT-5 nano' },
] as const;

export const buildOpenRouterModelId = (slug: string): string =>
    `${PROVIDER_ID.OpenRouter}:${slug}`;

export const buildOpenAiModelId = (model: string): string =>
    `${PROVIDER_ID.OpenAI}:${model}`;

export const CHROME_BUILTIN_MODEL_ID = `${PROVIDER_ID.ChromePromptApi}:gemini-nano`;
export const DEFAULT_DETECTION_MODEL_ID = buildOpenRouterModelId(
    OPENROUTER_DEFAULT_MODEL_SLUG,
);

export function getBuiltinDetectionModels(): DetectionModel[] {
    return [
        ...OPENROUTER_MODEL_PRESETS.map((model) => ({
            id: buildOpenRouterModelId(model.value),
            label: model.label,
            providerId: PROVIDER_ID.OpenRouter,
            providerLabel: 'OpenRouter',
            modelName: model.value,
            requiresConnection: true,
        })),
        ...OPENAI_MODEL_PRESETS.map((model) => ({
            id: buildOpenAiModelId(model.value),
            label: model.label,
            providerId: PROVIDER_ID.OpenAI,
            providerLabel: 'OpenAI',
            modelName: model.value,
            requiresConnection: true,
        })),
        {
            id: CHROME_BUILTIN_MODEL_ID,
            label: CHROME_PROMPT_API_MODEL_NAME,
            providerId: PROVIDER_ID.ChromePromptApi,
            providerLabel: 'Chrome Built-in',
            modelName: 'gemini-nano',
            requiresConnection: false,
        },
    ];
}

export function getDetectionModels(
    customOpenRouterModels: string[],
): DetectionModel[] {
    const builtins = getBuiltinDetectionModels();
    const seen = new Set(builtins.map((model) => model.id));
    const custom = customOpenRouterModels.flatMap((slug) => {
        const id = buildOpenRouterModelId(slug);
        if (seen.has(id)) {
            return [];
        }
        seen.add(id);
        return [
            {
                id,
                label: slug,
                providerId: PROVIDER_ID.OpenRouter,
                providerLabel: 'OpenRouter',
                modelName: slug,
                requiresConnection: true,
            },
        ];
    });
    return [...builtins, ...custom];
}

export function resolveDetectionModel(
    modelId: string,
    customOpenRouterModels: string[],
): DetectionModel | null {
    return (
        getDetectionModels(customOpenRouterModels).find(
            (model) => model.id === modelId,
        ) ??
        getBuiltinDetectionModels().find(
            (model) => model.id === DEFAULT_DETECTION_MODEL_ID,
        ) ??
        null
    );
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/shared/detection-models.test.ts`
Expected: PASS.

**Verification**: Shared model IDs can represent OpenRouter, OpenAI, Chrome, and custom OpenRouter slugs.

### [x] Task 2: Model-First Preferences and Migration

**Files:**

- Modify: `src/shared/constants.ts:29-45`
- Modify: `src/background/storage/prefs-sync.ts:20-107`
- Test: `tests/background/storage/prefs-sync.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const storageGet = vi.fn();
const storageSet = vi.fn();

vi.mock('@/shared/browser', () => ({
    default: { storage: { local: { get: storageGet, set: storageSet } } },
}));

const { PrefsSyncStorage } = await import('@/background/storage/prefs-sync');
const { DEFAULT_DETECTION_MODEL_ID, CHROME_BUILTIN_MODEL_ID } = await import(
    '@/shared/detection-models'
);

describe('PrefsSyncStorage model migration', () => {
    beforeEach(() => {
        storageGet.mockReset();
        storageSet.mockReset();
    });

    it('adds activeModelId to existing OpenRouter prefs', async () => {
        storageGet.mockResolvedValue({
            'topskip:prefs': { enabled: true, providerId: 'openrouter' },
        });
        const prefs = await PrefsSyncStorage.load();
        expect(prefs.activeModelId).toBe(DEFAULT_DETECTION_MODEL_ID);
        expect(prefs.providerId).toBe('openrouter');
        expect(storageSet).toHaveBeenCalled();
    });

    it('maps old Chrome provider prefs to the built-in model id', async () => {
        storageGet.mockResolvedValue({
            'topskip:prefs': { enabled: true, providerId: 'chrome-prompt-api' },
        });
        const prefs = await PrefsSyncStorage.load();
        expect(prefs.activeModelId).toBe(CHROME_BUILTIN_MODEL_ID);
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/background/storage/prefs-sync.test.ts`
Expected: FAIL because `activeModelId` is not in prefs.

- [x] **Step 3: Write minimal implementation**

Add `activeModelId` to `userPreferencesSchema` and `UserPreferences`. In
`PrefsSyncStorage`, default to `DEFAULT_DETECTION_MODEL_ID`, derive `providerId`
from the active model, and repair legacy rows by saving the normalized shape.

```ts
const legacyProviderToModelId = (providerId: string): string => {
    if (providerId === PROVIDER_ID.ChromePromptApi) {
        return CHROME_BUILTIN_MODEL_ID;
    }
    return DEFAULT_DETECTION_MODEL_ID;
};
```

Use this inside `parseStoredPrefs`: parse a permissive object with optional
`activeModelId`, then return `{ enabled, providerId, activeModelId }` where
`providerId` is derived from `resolveDetectionModel(activeModelId, [])`.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/background/storage/prefs-sync.test.ts`
Expected: PASS.

**Verification**: Existing users keep equivalent behavior after storage migration.

### [x] Task 3: OpenAI Storage and Client

**Files:**

- Create: `src/background/storage/openai-storage.ts`
- Create: `src/background/openai/openai-client.ts`
- Test: `tests/background/storage/openai-storage.test.ts`
- Test: `tests/background/openai/openai-client.test.ts`

- [x] **Step 1: Write failing tests**

Storage test:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const storageGet = vi.fn();
const storageSet = vi.fn();

vi.mock('@/shared/browser', () => ({
    default: { storage: { local: { get: storageGet, set: storageSet } } },
}));

const { OpenAiStorage } = await import('@/background/storage/openai-storage');

describe('OpenAiStorage', () => {
    beforeEach(() => {
        storageGet.mockReset();
        storageSet.mockReset();
    });

    it('returns defaults when storage is missing', async () => {
        storageGet.mockResolvedValue({});
        await expect(OpenAiStorage.load()).resolves.toEqual({
            apiKey: '',
            model: '',
        });
    });

    it('masks saved api keys', () => {
        expect(OpenAiStorage.maskApiKey('sk-test-1234')).toBe('****1234');
    });
});
```

Client test:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

const { callOpenAiResponse, testOpenAiApiKey } = await import(
    '@/background/openai/openai-client'
);

describe('openai client', () => {
    beforeEach(() => fetchMock.mockReset());

    it('tests key with models endpoint', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => ({ data: [{ id: 'gpt-5.2' }] }),
        });
        await expect(testOpenAiApiKey('sk-test')).resolves.toEqual({
            ok: true,
            valid: true,
        });
    });

    it('classifies 401 as invalid key', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => 'bad' });
        await expect(testOpenAiApiKey('bad')).resolves.toEqual({
            ok: true,
            valid: false,
            error: 'OpenAI API key is invalid.',
        });
    });

    it('calls Responses API and returns output text', async () => {
        fetchMock.mockResolvedValue({
            ok: true,
            json: async () => ({
                output: [
                    { content: [{ type: 'output_text', text: '{"hasPromo":false}' }] },
                ],
            }),
        });
        const result = await callOpenAiResponse({
            apiKey: 'sk-test',
            model: 'gpt-5.2',
            instructions: 'system',
            input: 'transcript',
        });
        expect(result).toEqual({ ok: true, rawContent: '{"hasPromo":false}' });
    });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/background/storage/openai-storage.test.ts tests/background/openai/openai-client.test.ts`
Expected: FAIL with missing modules.

- [x] **Step 3: Write minimal implementation**

Create `OpenAiStorage` parallel to `OpenRouterStorage`, using storage key
`topskip:openai`. Create `openai-client.ts` with:

```ts
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models';
```

Use `fetch`, `Authorization: Bearer ${apiKey}`, `Content-Type:
application/json`, parse JSON as `unknown`, and extract the first
`output_text` field from Responses API output.

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/background/storage/openai-storage.test.ts tests/background/openai/openai-client.test.ts`
Expected: PASS.

**Verification**: OpenAI key storage and API wrappers exist without exposing secrets to UI bundles.

### [x] Task 4: OpenAI Provider Adapter

**Files:**

- Create: `src/background/providers/openai-adapter.ts`
- Modify: `src/background/providers/default-registry.ts:1-10`
- Test: `tests/background/providers/openai-adapter.test.ts`
- Test: `tests/background/providers/default-registry.test.ts`

- [x] **Step 1: Write failing adapter test**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadMock = vi.fn();
const callOpenAiResponseMock = vi.fn();

vi.mock('@/background/storage/openai-storage', () => ({
    OpenAiStorage: { load: () => loadMock() },
}));
vi.mock('@/background/openai/openai-client', () => ({
    callOpenAiResponse: (params: unknown) => callOpenAiResponseMock(params),
}));

const { OpenAiAdapter } = await import('@/background/providers/openai-adapter');
const { PROVIDER_ID, PROVIDER_AVAILABILITY } = await import(
    '@/background/providers/llm-provider-adapter'
);

describe('OpenAiAdapter', () => {
    beforeEach(() => {
        loadMock.mockReset();
        callOpenAiResponseMock.mockReset();
    });

    it('is available when api key and model exist', async () => {
        loadMock.mockResolvedValue({ apiKey: 'sk-test', model: 'gpt-5.2' });
        await expect(new OpenAiAdapter().availability()).resolves.toBe(
            PROVIDER_AVAILABILITY.AVAILABLE,
        );
    });

    it('delegates transcript analysis to OpenAI Responses API', async () => {
        loadMock.mockResolvedValue({ apiKey: 'sk-test', model: 'gpt-5.2' });
        callOpenAiResponseMock.mockResolvedValue({
            ok: true,
            rawContent: '{"hasPromo":false}',
        });
        const result = await new OpenAiAdapter().analyzeTranscript({
            transcript: 'hello',
            videoId: 'v',
            languageCode: 'en',
        });
        expect(result).toEqual({
            ok: true,
            hasPromo: false,
            providerMeta: { id: PROVIDER_ID.OpenAI, model: 'gpt-5.2' },
            rawAssistant: '{"hasPromo":false}',
        });
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/background/providers/openai-adapter.test.ts`
Expected: FAIL with missing adapter.

- [x] **Step 3: Write minimal implementation**

Mirror `OpenRouterAdapter`, but load `OpenAiStorage`, call
`callOpenAiResponse({ apiKey, model, instructions: PROMO_DETECTION_SYSTEM_PROMPT, input: transcript })`,
and parse with `parseLlmPromoResponse`.

- [x] **Step 4: Register adapter and run tests**

Modify `default-registry.ts`:

```ts
export const defaultRegistry = new ProviderRegistry([
    new ChromePromptApiAdapter(),
    new OpenRouterAdapter(),
    new OpenAiAdapter(),
]);
```

Run: `pnpm exec vitest run tests/background/providers/openai-adapter.test.ts tests/background/providers/default-registry.test.ts`
Expected: PASS.

**Verification**: OpenAI is a first-class provider adapter.

### [x] Task 5: Model Runtime Messages and Connection Tests

**Files:**

- Modify: `src/shared/messages.ts`
- Create: `src/background/messaging/model-runtime-messages.ts`
- Modify: `src/background/messaging/register-runtime-messages.ts:80-100`
- Test: `tests/background/messaging/model-runtime-messages.test.ts`

- [x] **Step 1: Write failing test**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefsLoad = vi.fn();
const prefsSave = vi.fn();
const openRouterLoad = vi.fn();
const openAiLoad = vi.fn();
const testOpenRouterKey = vi.fn();
const testOpenAiKey = vi.fn();

vi.mock('@/background/storage/prefs-sync', () => ({
    PrefsSyncStorage: { ready: async () => {}, load: () => prefsLoad(), save: (p: unknown) => prefsSave(p) },
}));
vi.mock('@/background/storage/openrouter-storage', () => ({
    OpenRouterStorage: { load: () => openRouterLoad(), maskApiKey: () => '****r' },
}));
vi.mock('@/background/storage/openai-storage', () => ({
    OpenAiStorage: { load: () => openAiLoad(), maskApiKey: () => '****i', save: vi.fn() },
}));
vi.mock('@/background/openrouter/openrouter-models-api', () => ({
    fetchOpenRouterModelList: () => testOpenRouterKey(),
}));
vi.mock('@/background/openai/openai-client', () => ({
    testOpenAiApiKey: () => testOpenAiKey(),
}));

const { ModelRuntimeMessages } = await import('@/background/messaging/model-runtime-messages');

describe('ModelRuntimeMessages', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns models and connections', async () => {
        prefsLoad.mockResolvedValue({ enabled: true, providerId: 'openrouter', activeModelId: 'openrouter:google/gemini-3.1-pro-preview' });
        openRouterLoad.mockResolvedValue({ apiKey: 'sk-or', model: 'google/gemini-3.1-pro-preview', customModels: [] });
        openAiLoad.mockResolvedValue({ apiKey: 'sk-openai', model: 'gpt-5.2' });
        const response = await ModelRuntimeMessages.handleGetSettings();
        expect(response).toEqual(expect.objectContaining({ ok: true }));
        if (response.ok) {
            expect(response.models.some((m) => m.providerId === 'openai')).toBe(true);
            expect(response.connections).toEqual(expect.arrayContaining([
                expect.objectContaining({ providerId: 'openrouter' }),
                expect.objectContaining({ providerId: 'openai' }),
            ]));
        }
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/background/messaging/model-runtime-messages.test.ts`
Expected: FAIL with missing `ModelRuntimeMessages`.

- [x] **Step 3: Write minimal implementation**

Add message constants/types from `contracts/runtime-messages.md`. Implement
`ModelRuntimeMessages.handleGetSettings`, `handleSetActiveModel`,
`handleSaveConnectionKey`, and `handleTestConnectionKey`. On set active model,
resolve model, save `{ ...prefs, activeModelId, providerId: model.providerId }`,
then broadcast prefs through existing `PrefsBroadcast` and `PrefsPortHub`.

- [x] **Step 4: Register handlers and run test**

Add switch cases in `register-runtime-messages.ts` for the new message types.

Run: `pnpm exec vitest run tests/background/messaging/model-runtime-messages.test.ts`
Expected: PASS.

**Verification**: Options can load/save model-first settings and test keys.

### [x] Task 6: Options Model-First Panels

**Files:**

- Create: `src/options/ModelSelectionPanel.tsx`
- Create: `src/options/ConnectionsPanel.tsx`
- Create: `src/options/AddModelPanel.tsx`
- Modify: `src/options/options.tsx`
- Test: `tests/options/model-first-settings.test.ts`

- [x] **Step 1: Write failing render tests**

```ts
import { MantineProvider } from '@mantine/core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ConnectionsPanel } from '@/options/ConnectionsPanel';
import { ModelSelectionPanel } from '@/options/ModelSelectionPanel';
import { topskipTheme } from '@/shared/theme';

function render(element: ReturnType<typeof createElement>): string {
    return renderToStaticMarkup(
        createElement(MantineProvider, { theme: topskipTheme }, element),
    );
}

describe('model-first settings panels', () => {
    it('renders model choice without provider cards', () => {
        const html = render(createElement(ModelSelectionPanel, {
            activeModelId: 'openai:gpt-5.2',
            models: [
                { id: 'openai:gpt-5.2', label: 'GPT-5.2', providerId: 'openai', providerLabel: 'OpenAI', modelName: 'gpt-5.2', requiresConnection: true, availability: 'available' },
            ],
            missingConnectionProviderId: null,
            onModelChange: () => {},
            onOpenConnection: () => {},
        }));
        expect(html).toContain('Detection model');
        expect(html).toContain('GPT-5.2');
        expect(html).not.toContain('Promo-detection provider');
    });

    it('renders OpenRouter and OpenAI connection test buttons', () => {
        const html = render(createElement(ConnectionsPanel, {
            connections: [
                { providerId: 'openrouter', providerLabel: 'OpenRouter', requiredForActiveModel: false, apiKeyMasked: null, status: 'missing' },
                { providerId: 'openai', providerLabel: 'OpenAI', requiredForActiveModel: true, apiKeyMasked: '****1234', status: 'saved' },
            ],
            drafts: { openrouter: '', openai: '' },
            busyProviderId: null,
            testStates: {},
            onDraftChange: () => {},
            onSave: () => {},
            onTest: () => {},
        }));
        expect(html).toContain('Connections');
        expect(html).toContain('OpenAI');
        expect(html).toContain('Test');
        expect(html).toContain('Required for selected model');
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/options/model-first-settings.test.ts`
Expected: FAIL with missing components.

- [x] **Step 3: Write minimal implementation**

Build the three panels with Mantine `Select`, `Paper`, `Badge`, `TextInput`,
and `Button`. Keep cards at `radius="sm"`/`radius="md"` and avoid nested cards.
Use the existing options page shell and replace `ProviderChoiceCards` +
`OpenRouterConfigPanel` render branch with:

```tsx
<ModelSelectionPanel ... />
<ConnectionsPanel ... />
<AddModelPanel ... />
```

Wire `OptionsApp.load()` to `GET_MODEL_SETTINGS`, `onModelChange` to
`SET_ACTIVE_MODEL`, connection save to `SAVE_CONNECTION_KEY`, connection test to
`TEST_CONNECTION_KEY`, and keep existing OpenRouter custom model messages for
add/remove.

- [x] **Step 4: Run tests to verify pass**

Run: `pnpm exec vitest run tests/options/model-first-settings.test.ts tests/options/provider-panels.test.ts`
Expected: PASS after updating/removing provider-card assertions.

**Verification**: Options page no longer asks users to choose a provider first.

### [x] Task 7: Popup Active Model Labels

**Files:**

- Modify: `src/popup/preferences-store.ts`
- Modify: `src/popup/popup-view-model.ts`
- Test: `tests/popup/preferences-store.test.ts`
- Test: `tests/popup/popup-view-model.test.ts`

- [x] **Step 1: Update failing tests**

Change popup tests to expect labels like `GPT-5.2 · OpenAI` or
`Gemini Nano · Chrome Built-in`, with model first. Add one not-configured case:

```ts
expect(vm.providerLabel).toBe('GPT-5.2 · OpenAI');
expect(vm.description).toContain('OpenAI key');
```

- [x] **Step 2: Run tests to verify failure**

Run: `pnpm exec vitest run tests/popup/preferences-store.test.ts tests/popup/popup-view-model.test.ts`
Expected: FAIL because popup still calls `GET_ACTIVE_PROVIDER`.

- [x] **Step 3: Implement model-first load**

Update `PreferencesStore.refreshProviderDisplay` to call
`TOPSKIP_GET_MODEL_SETTINGS`, find `activeModelId`, and store
`modelDisplayName` first plus provider secondary label. Keep old
`GET_ACTIVE_PROVIDER` response parser only if needed for a temporary fallback.

- [x] **Step 4: Run tests to verify pass**

Run: `pnpm exec vitest run tests/popup/preferences-store.test.ts tests/popup/popup-view-model.test.ts`
Expected: PASS.

**Verification**: Popup matches spec FR-022 to FR-024.

### [x] Task 8: Pipeline Routing and Regression Suite

**Files:**

- Modify: `src/background/messaging/promo-analysis.ts`
- Modify: `tests/background/messaging/promo-analysis.test.ts`
- Modify: `tests/background/messaging/provider-runtime-messages.test.ts`

- [x] **Step 1: Write failing routing test**

Add a `promo-analysis` test where prefs contain
`activeModelId: 'openai:gpt-5.2'` and `providerId: 'openai'`; assert the
registered OpenAI adapter receives `analyzeTranscript`.

- [x] **Step 2: Run test to verify failure**

Run: `pnpm exec vitest run tests/background/messaging/promo-analysis.test.ts`
Expected: FAIL if provider registry does not include/route OpenAI.

- [x] **Step 3: Implement minimal routing compatibility**

Keep `PromoAnalysis` reading `prefs.providerId`; `ModelRuntimeMessages` and
`PrefsSyncStorage` are responsible for keeping it derived from `activeModelId`.
Remove UI-facing provider switch assumptions from provider runtime tests or mark
old messages as compatibility-only.

- [x] **Step 4: Run regression commands**

Run:

```bash
pnpm exec vitest run \
  tests/shared/detection-models.test.ts \
  tests/background/storage/prefs-sync.test.ts \
  tests/background/storage/openai-storage.test.ts \
  tests/background/openai/openai-client.test.ts \
  tests/background/providers/openai-adapter.test.ts \
  tests/background/messaging/model-runtime-messages.test.ts \
  tests/options/model-first-settings.test.ts \
  tests/popup/preferences-store.test.ts \
  tests/popup/popup-view-model.test.ts
```

Expected: PASS.

**Verification**: Active model changes route to the correct adapter and UI labels stay model-first.

### [x] Task 9: Full Validation

**Files:**

- Modify as needed: `vitest.config.ts` only if new covered modules require explicit coverage thresholds.
- No source changes expected.

- [x] **Step 1: Format**

Run: `pnpm run format`
Expected: files formatted by oxfmt.

- [x] **Step 2: Unit tests**

Run: `pnpm run test`
Expected: PASS.

- [x] **Step 3: Type/lint**

Run: `pnpm run lint`
Expected: PASS.

- [x] **Step 4: Build**

Run: `pnpm run build`
Expected: PASS and `dist/` contains rebuilt extension.

- [x] **Step 5: E2E**

Run: `pnpm run test:e2e`
Expected: PASS. If Chromium is missing, run `pnpm exec playwright install chromium` once, then rerun.

**Verification**: Feature is ready for review.

## Spec Coverage Review

- FR-001 to FR-005: Tasks 1, 2, 5, 6.
- FR-006 to FR-009: Tasks 1, 3, 4, 8.
- FR-010 to FR-017: Tasks 3, 5, 6.
- FR-018 to FR-021: Tasks 1, 5, 6.
- FR-022 to FR-024: Task 7.
- FR-025 to FR-026: Task 2.
- FR-027 to FR-031: Tasks 4, 5, 8, 9.
- SC-001 to SC-012: Covered by Tasks 6, 7, 8, and 9.

## Assumptions

- `providerId` remains in `UserPreferences` during this refactor as a derived compatibility route. Removing it fully can be a later cleanup once content/popup/pipeline tests no longer depend on provider-first names.
- OpenAI custom model entry is not included in this first plan; the spec requires OpenAI presets and OpenAI key support. OpenRouter remains the only custom model provider in this slice.
- OpenAI key tests use `GET /v1/models`; this validates auth and access without spending completion tokens.
