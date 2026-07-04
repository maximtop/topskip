# Runtime Message Contracts

These contracts describe extension runtime messages for model-first settings.
They are not HTTP APIs. Popup/options/content still use `browser.runtime`
messages; background storage remains the source of truth.

## Model Settings

### `TOPSKIP_GET_MODEL_SETTINGS`

Request:

```ts
{ type: 'TOPSKIP_GET_MODEL_SETTINGS' }
```

Response:

```ts
type GetModelSettingsResponse =
    | {
          ok: true;
          activeModelId: string;
          models: DetectionModelMessage[];
          connections: ConnectionEntryMessage[];
          customOpenRouterModels: string[];
      }
    | { ok: false; error: string };
```

### `TOPSKIP_SET_ACTIVE_MODEL`

Request:

```ts
{
    type: 'TOPSKIP_SET_ACTIVE_MODEL';
    modelId: string;
}
```

Response:

```ts
type SetActiveModelResponse =
    | { ok: true }
    | { ok: false; error: string };
```

## Connections

### `TOPSKIP_SAVE_CONNECTION_KEY`

Request:

```ts
{
    type: 'TOPSKIP_SAVE_CONNECTION_KEY';
    providerId: 'openrouter' | 'openai';
    apiKey: string;
}
```

Response:

```ts
type SaveConnectionKeyResponse =
    | { ok: true; apiKeyMasked: string | null }
    | { ok: false; error: string };
```

### `TOPSKIP_TEST_CONNECTION_KEY`

Request:

```ts
{
    type: 'TOPSKIP_TEST_CONNECTION_KEY';
    providerId: 'openrouter' | 'openai';
    apiKey?: string;
}
```

When `apiKey` is omitted or empty, background tests the saved key.

Response:

```ts
type TestConnectionKeyResponse =
    | { ok: true; valid: true }
    | { ok: true; valid: false; error: string }
    | { ok: false; error: string; retryable?: boolean };
```

## Shared Payloads

```ts
type DetectionModelMessage = {
    id: string;
    label: string;
    providerId: 'openrouter' | 'openai' | 'chrome-prompt-api';
    providerLabel: string;
    modelName: string;
    requiresConnection: boolean;
    availability: 'available' | 'downloadable' | 'downloading' | 'unavailable';
};

type ConnectionEntryMessage = {
    providerId: 'openrouter' | 'openai';
    providerLabel: string;
    requiredForActiveModel: boolean;
    apiKeyMasked: string | null;
    status: 'missing' | 'saved';
};
```
