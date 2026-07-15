# Implementation Plan: Local Backend Handshake and API Contract

- **Created**: 2026-07-05
- **Status**: Approved
- **Issue**: `.sdd/.current/issues/1-AFK/issue.md`
- **PRD**: `.sdd/.current/prd.md`
- **Model**: GPT-5 Codex
- **User Input**: `ISSUE_ID=1-AFK`, `SPECS_DIR=.sdd/.current`, constraints: revise the existing plan to address all findings in `.sdd/.current/issues/1-AFK/review.md`, especially OpenAPI/Valibot parity, guarded JSON parsing and body limits, request timeout/abort behavior, multi-line JSDoc for new `src/` declarations, and server-specific popup error copy/status handling.

## Summary

Build the first server-mode tracer bullet by adding a typed local backend contract, a minimal Node 20 TypeScript backend, and an extension request path that sends current-video metadata to `http://127.0.0.1:8787/v1/analysis`. The backend returns a deterministic `processing` response only; it does not extract captions, transcribe audio, call an LLM, or return promo blocks in this slice. The extension maps that response into the existing `PromoDetectionStore` so the popup can report server analysis as pending, and server mode bypasses the existing direct provider analysis path.

## Technical Context

- **Language/Version**: TypeScript 6.0.2 in strict ESM mode; Node.js `>=20`.
- **Primary Dependencies**: Rspack, React 19.2, Mantine 9, MobX 6, Valibot 1.3, `webextension-polyfill`, Vitest, Playwright.
- **Storage**: `browser.storage.local` through `PrefsSyncStorage` only. This issue adds a validated `analysisMode` preference with default `server`.
- **Testing**: Vitest for schema, backend, background, popup, and pure content helpers; Playwright for extension + fixture integration.
- **Target Platform**: Chrome Manifest V3 extension service worker plus a local Node HTTP backend used during development.

## Research

### Existing Runtime Message Routing

`src/shared/messages.ts:16` centralizes `TOPSKIP_MESSAGE` strings, and `src/shared/messages.ts:385` defines the discriminated `TopSkipRuntimeMessage` union. Background dispatch happens in `src/background/messaging/register-runtime-messages.ts:42`, with each `case` delegating to a static handler class. The server-mode request should follow this pattern with a new `REQUEST_SERVER_ANALYSIS` message and a `ServerAnalysisRuntimeMessages` handler.

### Existing Detection State Path

The popup already reads `PromoDetectionStore` via `GET_DETECTION_STATUS` in `src/background/messaging/misc-runtime-messages.ts:42`, and store updates broadcast `PROMO_DETECTION_UPDATED` through `src/background/promo-detection-store.ts`. Reusing this path keeps server-mode status visible without adding a second UI channel.

### Current Local Provider Path

The content script schedules caption capture on video changes in `src/content/youtube-watch.ts:371` and on init in `src/content/youtube-watch.ts:471`. The background caption handler invokes `PromoAnalysis.onCaptionsReady` directly at `src/background/messaging/caption-runtime-messages.ts:37`. Server mode must branch before scheduling caption capture and must also guard the caption handler so stale content scripts cannot invoke direct provider analysis when prefs say `server`.

### Preferences Gap

`src/shared/constants.ts:47` validates `enabled`, `providerId`, and `activeModelId`, but there is no explicit server/BYOK mode. The plan adds `ANALYSIS_MODE = { Server: 'server', Byok: 'byok' }` and `analysisMode` with a Valibot fallback to `server`, preserving legacy preference rows while giving tests a stable switch to assert provider bypass behavior.

### Local Backend Host Permission

`rspack.config.ts:17` injects the Playwright fixture origin into dev builds only. Fetching a local backend from the MV3 service worker needs a dev-only host permission for `http://127.0.0.1:8787/*`. Release and beta builds must not add this local backend host.

### Popup Status Rendering

`src/popup/PopupApp.tsx:370` renders `status: 'analyzing'` as local transcript analysis. Server processing should not reuse "Analyzing captions" copy. Add `source: 'server'` to `PromoDetectionStatePayload` and render server-specific pending text when `status === 'analyzing' && source === 'server'`.

Server failures must also use server-specific copy. A server request timeout, network failure, malformed response, or non-2xx response should be stored with `status: 'error'` and `source: 'server'`, and the popup must explain that the local TopSkip backend is unavailable or did not return a usable response. It must not reuse API-key, transcript, or direct-provider error guidance.

### Rejected Plan Findings

The review in `.sdd/.current/issues/1-AFK/review.md` rejected the prior plan because several implementation tasks would not satisfy the documented API contract or repo lint rules. This revision updates the plan so the shared Valibot schemas enforce the same integer and unique-array constraints as `.sdd/.current/issues/1-AFK/contracts/openapi.yaml`, the Node server returns typed error responses for malformed JSON and oversized bodies without unbounded buffering, the background fetch client aborts hung requests, every new `src/` type alias/function/class/class method in the planned snippets uses the repository's required multi-line JSDoc style, and the popup distinguishes both server pending and server error states.

## Entities

### Analysis Mode

- **Fields**:
    - `analysisMode`: `'server' | 'byok'` - persisted user preference that controls the analysis route.
- **Relationships**: Stored inside `UserPreferences`; read by content and background handlers.
- **Validation**: Valibot picklist with fallback to `'server'` for legacy rows.
- **States**: `server` routes to local backend; `byok` routes to existing caption/provider analysis.

### Server Analysis Request

- **Fields**:
    - `videoId`: `string` - 11-character YouTube ID matching `/^[A-Za-z0-9_-]{11}$/`.
    - `durationSec`: `number | undefined` - positive duration when available.
    - `extensionVersion`: `string` - from `browser.runtime.getManifest().version`.
    - `algorithmVersion`: `string` - shared server-analysis cache/algorithm version.
    - `client`: `{ source: 'chrome-extension'; capabilities: string[] }`.
- **Relationships**: Built in the background client from a content runtime message; validated by the backend.
- **Validation**: Shared Valibot schema rejects malformed IDs, non-positive duration, duplicate `client.capabilities` values, and properties outside the documented OpenAPI shape.
- **States**: accepted by backend into a deterministic `processing` response.

### Processing Response

- **Fields**:
    - `status`: `'processing'`.
    - `videoId`: `string`.
    - `algorithmVersion`: `string`.
    - `jobId`: `string`.
    - `pollAfterSec`: `number` - integer seconds before a later status poll.
- **Relationships**: Returned by local backend; validated by background client; mapped to `PromoDetectionStore`.
- **Validation**: Shared Valibot schema; `pollAfterSec` must be an integer and `>= 1`, matching OpenAPI `type: integer`.
- **States**: `processing` only in this slice.

### Promo Detection State Payload

- **Fields**:
    - Existing fields from `PromoDetectionStatePayload`.
    - `source?: 'server' | 'local_provider' | 'local_cache' | 'server_cache'`.
- **Relationships**: Stored by `PromoDetectionStore`, read by popup view model.
- **Validation**: Typed runtime payload; server mode writes `{ videoId, status: 'analyzing', source: 'server' }`.
- **States**: This slice adds the server pending state only.

## Contracts

The OpenAPI contract for this issue is `.sdd/.current/issues/1-AFK/contracts/openapi.yaml`.

Implemented routes:

- `GET /v1/health` returns `{ ok: true, service: 'topskip-backend', version }`.
- `POST /v1/analysis` accepts `AnalysisRequest` and returns `202 ProcessingResponse`.
- Malformed JSON and invalid request bodies return `400 ErrorResponse` and do not start extraction, transcription, or LLM work.
- Oversized request bodies return `413 ErrorResponse` with `error.code === 'request_body_too_large'`; the server must stop accumulating body text after `MAX_ANALYSIS_REQUEST_BODY_BYTES`.
- Contract parity requirement: Valibot must enforce every non-trivial OpenAPI constraint used in this slice, including `ProcessingResponse.pollAfterSec` as an integer and `AnalysisRequest.client.capabilities` as a unique array.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `.sdd/.current/issues/1-AFK/contracts/openapi.yaml` | Modify | Documents the local backend health and analysis request contract, including malformed and oversized request-body errors. |
| `src/shared/server-analysis-contract.ts` | Create | Shared Valibot schemas, constants, and types for backend and extension; schemas must match OpenAPI integer and unique-array constraints. |
| `tests/shared/server-analysis-contract.test.ts` | Create | Verifies schemas accept valid metadata, reject malformed video IDs, reject duplicate capabilities, and reject fractional `pollAfterSec`. |
| `src/shared/constants.ts` | Modify | Adds `ANALYSIS_MODE` and `analysisMode` to `UserPreferences`. |
| `src/background/storage/prefs-sync.ts` | Modify | Seeds and repairs `analysisMode`, defaulting legacy prefs to `server`. |
| `tests/background/storage/prefs-sync.test.ts` | Modify | Covers legacy preference migration to server mode. |
| `src/backend/analysis-api.ts` | Create | Pure request handling for health and deterministic processing responses. |
| `src/backend/server.ts` | Create | Node HTTP server listening on `127.0.0.1:8787`, with guarded JSON parsing and bounded request-body accumulation. |
| `tests/backend/analysis-api.test.ts` | Create | Verifies backend validation, 202 processing, and 400 invalid request behavior. |
| `tests/backend/server.test.ts` | Create | Verifies malformed JSON returns `400 ErrorResponse` and oversized request bodies return `413 ErrorResponse` without starting work. |
| `package.json` | Modify | Adds a `backend:dev` script using `tsx src/backend/server.ts`. |
| `rspack.config.ts` | Modify | Adds dev-only `http://127.0.0.1:8787/*` host permission. |
| `src/background/server-analysis-client.ts` | Create | Background-owned fetch client for the local backend, with timeout/abort behavior for hung requests. |
| `tests/background/server-analysis-client.test.ts` | Create | Verifies request URL, headers, payload shape, response parsing, timeout aborts, and no transcript fields. |
| `src/background/messaging/server-analysis-runtime-messages.ts` | Create | Handles content server-analysis requests and updates detection state. |
| `src/background/messaging/register-runtime-messages.ts` | Modify | Dispatches `REQUEST_SERVER_ANALYSIS`. |
| `src/shared/messages.ts` | Modify | Adds request message, response types, and `source` metadata. |
| `tests/background/messaging/server-analysis-runtime-messages.test.ts` | Create | Verifies server processing updates `PromoDetectionStore`, client failures update server error state, and provider analysis is not called. |
| `src/content/server-analysis-request.ts` | Create | Pure content helper for route selection and request message construction. |
| `tests/content/server-analysis-request.test.ts` | Create | Verifies server mode builds validated metadata and BYOK mode does not. |
| `src/content/page-guards.ts` | Modify | Changes e2e fixture video id to an 11-character valid ID. |
| `tests/content/page-guards.test.ts` | Modify | Updates fixture id expectation. |
| `src/content/youtube-watch.ts` | Modify | Branches server mode to `REQUEST_SERVER_ANALYSIS` and BYOK mode to caption capture. |
| `src/background/messaging/caption-runtime-messages.ts` | Modify | Guards direct provider analysis when prefs are in server mode. |
| `tests/background/messaging/caption-runtime-messages.test.ts` | Create | Verifies server mode ignores captions and BYOK mode invokes `PromoAnalysis`. |
| `src/popup/PopupApp.tsx` | Modify | Renders server pending and server error states separately from local caption/provider analysis. |
| `tests/popup/popup-view-model.test.ts` | Modify | Covers server pending and server error view models. |
| `src/_locales/*/messages.json` | Modify | Adds server pending and server error popup strings to every locale file, using English fallback text where translations are unavailable. |
| `e2e/extension.spec.ts` | Modify | Adds fixture test proving server mode reports pending after local backend response. |

## Tasks

### [x] Task 1: Shared Server Analysis Contract

**Files:**

- Create: `src/shared/server-analysis-contract.ts`
- Create: `tests/shared/server-analysis-contract.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import {
    SERVER_ANALYSIS_ALGORITHM_VERSION,
    buildServerAnalysisRequest,
    isValidYouTubeVideoId,
    processingResponseSchema,
    serverAnalysisRequestSchema,
} from '@/shared/server-analysis-contract';

describe('server analysis contract', () => {
    it('accepts current-video metadata without captions', () => {
        const request = buildServerAnalysisRequest({
            videoId: 'dQw4w9WgXcQ',
            durationSec: 213,
            extensionVersion: '0.1.0',
        });

        expect(request).toEqual({
            videoId: 'dQw4w9WgXcQ',
            durationSec: 213,
            extensionVersion: '0.1.0',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            client: {
                source: 'chrome-extension',
                capabilities: ['processing-status'],
            },
        });
        expect(v.safeParse(serverAnalysisRequestSchema, request).success).toBe(
            true,
        );
        expect(JSON.stringify(request)).not.toContain('caption');
        expect(JSON.stringify(request)).not.toContain('transcript');
    });

    it('rejects malformed video ids', () => {
        expect(isValidYouTubeVideoId('dQw4w9WgXcQ')).toBe(true);
        expect(isValidYouTubeVideoId('short')).toBe(false);
        expect(
            v.safeParse(serverAnalysisRequestSchema, {
                videoId: 'short',
                extensionVersion: '0.1.0',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                client: {
                    source: 'chrome-extension',
                    capabilities: ['processing-status'],
                },
            }).success,
        ).toBe(false);
    });

    it('accepts the deterministic processing response shape', () => {
        const parsed = v.parse(processingResponseSchema, {
            status: 'processing',
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            jobId: 'local-dQw4w9WgXcQ-server-v1',
            pollAfterSec: 3,
        });

        expect(parsed.status).toBe('processing');
    });

    it('rejects duplicate capabilities to match OpenAPI uniqueItems', () => {
        const parsed = v.safeParse(serverAnalysisRequestSchema, {
            videoId: 'dQw4w9WgXcQ',
            extensionVersion: '0.1.0',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            client: {
                source: 'chrome-extension',
                capabilities: ['processing-status', 'processing-status'],
            },
        });

        expect(parsed.success).toBe(false);
    });

    it('rejects fractional poll intervals to match OpenAPI integer', () => {
        const parsed = v.safeParse(processingResponseSchema, {
            status: 'processing',
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            jobId: 'local-dQw4w9WgXcQ-server-v1',
            pollAfterSec: 1.5,
        });

        expect(parsed.success).toBe(false);
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/shared/server-analysis-contract.test.ts`

Expected: FAIL with `Cannot find module '@/shared/server-analysis-contract'`.

- [x] **Step 3: Write minimal implementation**

Add multi-line JSDoc blocks to every new `src/` type alias and function in this file. The repository lint rules require a prose summary, `@param` for function parameters, and `@returns` for functions that return values.

```ts
import * as v from 'valibot';

export const SERVER_ANALYSIS_ALGORITHM_VERSION = 'server-v1';
export const TOPSKIP_LOCAL_BACKEND_BASE_URL = 'http://127.0.0.1:8787';
export const TOPSKIP_LOCAL_BACKEND_HOST_MATCH = 'http://127.0.0.1:8787/*';
export const SERVER_ANALYSIS_CAPABILITY_PROCESSING_STATUS =
    'processing-status';

const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/u;

export const youtubeVideoIdSchema = v.pipe(
    v.string(),
    v.regex(YOUTUBE_VIDEO_ID_PATTERN, 'Invalid YouTube video id.'),
);

const requestCapabilitiesSchema = v.pipe(
    v.array(v.string()),
    v.check(
        (capabilities) => new Set(capabilities).size === capabilities.length,
        'Capabilities must be unique.',
    ),
);

export const serverAnalysisRequestSchema = v.strictObject({
    videoId: youtubeVideoIdSchema,
    durationSec: v.optional(v.pipe(v.number(), v.minValue(0.001))),
    extensionVersion: v.pipe(v.string(), v.minLength(1)),
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    client: v.strictObject({
        source: v.literal('chrome-extension'),
        capabilities: requestCapabilitiesSchema,
    }),
});

export const processingResponseSchema = v.strictObject({
    status: v.literal('processing'),
    videoId: youtubeVideoIdSchema,
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    jobId: v.pipe(v.string(), v.minLength(1)),
    pollAfterSec: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export const errorResponseSchema = v.strictObject({
    status: v.literal('invalid_request'),
    error: v.strictObject({
        code: v.picklist([
            'invalid_video_id',
            'invalid_request',
            'request_body_too_large',
        ] as const),
        message: v.pipe(v.string(), v.minLength(1)),
    }),
});

/**
 * Validated metadata payload sent from the extension to the local backend.
 */
export type ServerAnalysisRequest = v.InferOutput<
    typeof serverAnalysisRequestSchema
>;

/**
 * Non-blocking server response used while backend analysis is pending.
 */
export type ProcessingResponse = v.InferOutput<typeof processingResponseSchema>;

/**
 * Typed error response returned before any expensive analysis work starts.
 */
export type ErrorResponse = v.InferOutput<typeof errorResponseSchema>;

/**
 * Checks the canonical YouTube ID shape accepted by the local backend.
 *
 * @param videoId - Candidate watch-page video ID.
 * @returns `true` when the value matches the supported YouTube ID shape.
 */
export function isValidYouTubeVideoId(videoId: string): boolean {
    return YOUTUBE_VIDEO_ID_PATTERN.test(videoId);
}

/**
 * Builds the metadata-only request body used by server-first analysis.
 *
 * @param input - Current video metadata already known to the extension.
 * @returns Validated request body for the local backend.
 */
export function buildServerAnalysisRequest(input: {
    videoId: string;
    durationSec?: number;
    extensionVersion: string;
}): ServerAnalysisRequest {
    const maybeDuration =
        input.durationSec !== undefined && Number.isFinite(input.durationSec)
            ? { durationSec: input.durationSec }
            : {};
    return v.parse(serverAnalysisRequestSchema, {
        videoId: input.videoId,
        ...maybeDuration,
        extensionVersion: input.extensionVersion,
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        client: {
            source: 'chrome-extension',
            capabilities: [SERVER_ANALYSIS_CAPABILITY_PROCESSING_STATUS],
        },
    });
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/shared/server-analysis-contract.test.ts`

Expected: PASS.

**Verification**: The shared contract rejects malformed IDs, duplicate capabilities, fractional poll intervals, and has no caption/transcript fields in the request payload.

### [x] Task 2: Persist Analysis Mode in Preferences

**Files:**

- Modify: `src/shared/constants.ts`
- Modify: `src/background/storage/prefs-sync.ts`
- Modify: `tests/background/storage/prefs-sync.test.ts`
- Modify: tests that construct `UserPreferences` objects if TypeScript requires the new field

- [x] **Step 1: Write the failing test**

```ts
it('defaults legacy prefs to server analysis mode', async () => {
    storageGet.mockResolvedValue({
        'topskip:prefs': { enabled: true, providerId: 'openrouter' },
    });

    const prefs = await PrefsSyncStorage.load();

    expect(prefs.analysisMode).toBe('server');
    expect(storageSet).toHaveBeenCalledWith({
        'topskip:prefs': {
            enabled: true,
            providerId: 'openrouter',
            activeModelId: DEFAULT_DETECTION_MODEL_ID,
            analysisMode: 'server',
        },
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/background/storage/prefs-sync.test.ts`

Expected: FAIL because `analysisMode` is missing from loaded prefs.

- [x] **Step 3: Write minimal implementation**

In `src/shared/constants.ts`, add the mode constants before `userPreferencesSchema`, with multi-line JSDoc on the new exported type alias:

```ts
export const ANALYSIS_MODE = {
    Server: 'server',
    Byok: 'byok',
} as const;

/**
 * User-selected route for promo detection.
 */
export type AnalysisMode =
    (typeof ANALYSIS_MODE)[keyof typeof ANALYSIS_MODE];

export const analysisModeSchema = v.picklist([
    ANALYSIS_MODE.Server,
    ANALYSIS_MODE.Byok,
] as const);
```

Then extend `userPreferencesSchema`:

```ts
export const userPreferencesSchema = v.object({
    enabled: v.boolean(),
    providerId: v.string(),
    activeModelId: v.fallback(v.string(), DEFAULT_DETECTION_MODEL_ID),
    analysisMode: v.fallback(analysisModeSchema, ANALYSIS_MODE.Server),
});
```

In `PrefsSyncStorage.defaultPrefs`, add:

```ts
analysisMode: ANALYSIS_MODE.Server,
```

In `parseStoredPrefs`, return:

```ts
analysisMode: parsed.analysisMode,
```

In `storedPrefsMatch`, require the stored value to match:

```ts
'analysisMode' in raw &&
raw.analysisMode === prefs.analysisMode
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/background/storage/prefs-sync.test.ts`

Expected: PASS.

**Verification**: Legacy preference rows migrate to server mode without dropping existing provider/model fields.

### [x] Task 3: Minimal Local Backend

**Files:**

- Create: `src/backend/analysis-api.ts`
- Create: `src/backend/server.ts`
- Create: `tests/backend/analysis-api.test.ts`
- Create: `tests/backend/server.test.ts`
- Modify: `package.json`

- [x] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';

import { BackendAnalysisApi } from '@/backend/analysis-api';
import { SERVER_ANALYSIS_ALGORITHM_VERSION } from '@/shared/server-analysis-contract';

describe('BackendAnalysisApi', () => {
    it('returns health metadata', () => {
        expect(BackendAnalysisApi.health('0.1.0')).toEqual({
            ok: true,
            service: 'topskip-backend',
            version: '0.1.0',
        });
    });

    it('returns processing for a valid analysis request', () => {
        const response = BackendAnalysisApi.handleAnalysisRequest({
            videoId: 'dQw4w9WgXcQ',
            extensionVersion: '0.1.0',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            client: {
                source: 'chrome-extension',
                capabilities: ['processing-status'],
            },
        });

        expect(response).toEqual({
            statusCode: 202,
            body: {
                status: 'processing',
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                jobId: 'local-dQw4w9WgXcQ-server-v1',
                pollAfterSec: 3,
            },
        });
    });

    it('rejects invalid video ids without starting work', () => {
        expect(
            BackendAnalysisApi.handleAnalysisRequest({
                videoId: 'short',
                extensionVersion: '0.1.0',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                client: {
                    source: 'chrome-extension',
                    capabilities: ['processing-status'],
                },
            }),
        ).toEqual({
            statusCode: 400,
            body: {
                status: 'invalid_request',
                error: {
                    code: 'invalid_video_id',
                    message: 'Invalid YouTube video id.',
                },
            },
        });
    });
});
```

Add a server-boundary test in `tests/backend/server.test.ts` so body parsing behavior is covered where the Node HTTP request enters the backend:

```ts
import { afterEach, describe, expect, it } from 'vitest';

import { BackendHttpServer } from '@/backend/server';
import { MIME_APPLICATION_JSON } from '@/shared/constants';

describe('BackendHttpServer request body guard', () => {
    const servers: Array<ReturnType<typeof BackendHttpServer.create>> = [];

    afterEach(async () => {
        await Promise.all(
            servers.map(
                (server) =>
                    new Promise<void>((resolve) => {
                        server.close(() => resolve());
                    }),
            ),
        );
        servers.length = 0;
    });

    it('returns a typed 400 response for malformed JSON', async () => {
        const server = BackendHttpServer.create();
        servers.push(server);
        await new Promise<void>((resolve) => {
            server.listen(0, '127.0.0.1', () => resolve());
        });
        const address = server.address();
        if (address === null || typeof address === 'string') {
            throw new Error('Expected an ephemeral TCP port.');
        }

        const response = await fetch(
            `http://127.0.0.1:${address.port}/v1/analysis`,
            {
                method: 'POST',
                headers: { 'content-type': MIME_APPLICATION_JSON },
                body: '{not-json',
            },
        );

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
            status: 'invalid_request',
            error: {
                code: 'invalid_request',
                message: 'Malformed JSON request body.',
            },
        });
    });

    it('returns a typed 413 response for oversized bodies', async () => {
        const server = BackendHttpServer.create();
        servers.push(server);
        await new Promise<void>((resolve) => {
            server.listen(0, '127.0.0.1', () => resolve());
        });
        const address = server.address();
        if (address === null || typeof address === 'string') {
            throw new Error('Expected an ephemeral TCP port.');
        }

        const response = await fetch(
            `http://127.0.0.1:${address.port}/v1/analysis`,
            {
                method: 'POST',
                headers: { 'content-type': MIME_APPLICATION_JSON },
                body: 'x'.repeat(32_769),
            },
        );

        expect(response.status).toBe(413);
        await expect(response.json()).resolves.toEqual({
            status: 'invalid_request',
            error: {
                code: 'request_body_too_large',
                message: 'Request body exceeds the local API limit.',
            },
        });
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/backend/analysis-api.test.ts tests/backend/server.test.ts`

Expected: FAIL with `Cannot find module '@/backend/analysis-api'`.

- [x] **Step 3: Write minimal implementation**

Add multi-line JSDoc blocks to the new `BackendApiResult` type alias, `BackendAnalysisApi` class, every class method, and every helper function in `src/backend/server.ts`. The JSDoc should explain the server-boundary invariant: invalid local API input is converted to typed responses before any extraction, transcription, or LLM work can start.

`src/backend/analysis-api.ts`:

```ts
import * as v from 'valibot';

import {
    SERVER_ANALYSIS_ALGORITHM_VERSION,
    errorResponseSchema,
    isValidYouTubeVideoId,
    processingResponseSchema,
    serverAnalysisRequestSchema,
    type ErrorResponse,
    type ProcessingResponse,
} from '@/shared/server-analysis-contract';

/**
 * HTTP result shape returned before the backend starts any expensive work.
 */
type BackendApiResult =
    | { statusCode: 202; body: ProcessingResponse }
    | { statusCode: 400; body: ErrorResponse };

/**
 * Pure local API behavior for validation and deterministic processing states;
 * static API only.
 */
export class BackendAnalysisApi {
    /**
     * Returns process metadata for local development health checks.
     *
     * @param version - Backend version string exposed to the extension.
     * @returns Typed health response.
     */
    static health(version: string): {
        ok: true;
        service: 'topskip-backend';
        version: string;
    } {
        return { ok: true, service: 'topskip-backend', version };
    }

    /**
     * Validates the analysis request and returns a non-blocking processing
     * state without starting subtitle extraction or model work.
     *
     * @param raw - Untrusted JSON body from the HTTP server.
     * @returns Typed API result for the HTTP layer.
     */
    static handleAnalysisRequest(raw: unknown): BackendApiResult {
        if (
            raw !== null &&
            typeof raw === 'object' &&
            'videoId' in raw &&
            typeof raw.videoId === 'string' &&
            !isValidYouTubeVideoId(raw.videoId)
        ) {
            return {
                statusCode: 400,
                body: v.parse(errorResponseSchema, {
                    status: 'invalid_request',
                    error: {
                        code: 'invalid_video_id',
                        message: 'Invalid YouTube video id.',
                    },
                }),
            };
        }

        const parsed = v.safeParse(serverAnalysisRequestSchema, raw);
        if (!parsed.success) {
            return {
                statusCode: 400,
                body: v.parse(errorResponseSchema, {
                    status: 'invalid_request',
                    error: {
                        code: 'invalid_request',
                        message: 'Invalid analysis request.',
                    },
                }),
            };
        }

        return {
            statusCode: 202,
            body: v.parse(processingResponseSchema, {
                status: 'processing',
                videoId: parsed.output.videoId,
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                jobId: `local-${parsed.output.videoId}-${SERVER_ANALYSIS_ALGORITHM_VERSION}`,
                pollAfterSec: 3,
            }),
        };
    }
}
```

`src/backend/server.ts`:

```ts
import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from 'node:http';
import { pathToFileURL } from 'node:url';
import * as v from 'valibot';

import { BackendAnalysisApi } from '@/backend/analysis-api';
import { MIME_APPLICATION_JSON } from '@/shared/constants';
import {
    errorResponseSchema,
    type ErrorResponse,
} from '@/shared/server-analysis-contract';

const BACKEND_HOST = '127.0.0.1';
const BACKEND_PORT = 8787;
const BACKEND_VERSION = '0.1.0';
const MAX_ANALYSIS_REQUEST_BODY_BYTES = 32_768;

/**
 * Result of parsing the local API request body at the HTTP boundary.
 */
type ReadJsonBodyResult =
    | { ok: true; body: unknown }
    | { ok: false; statusCode: 400 | 413; body: ErrorResponse };

/**
 * Owns the minimal local HTTP server for the server-first tracer bullet;
 * static API only.
 */
export class BackendHttpServer {
    /**
     * Creates an unstarted Node HTTP server for tests or the dev script.
     *
     * @returns Local backend HTTP server.
     */
    static create(): Server {
        return createServer((req, res) => {
            void BackendHttpServer.route(req, res);
        });
    }

    /**
     * Starts the local backend on the configured development address.
     *
     * @returns Nothing.
     */
    static listen(): void {
        const server = BackendHttpServer.create();
        server.listen(BACKEND_PORT, BACKEND_HOST, () => {
            console.info(
                `TopSkip backend listening on http://${BACKEND_HOST}:${BACKEND_PORT}`,
            );
        });
    }

    /**
     * Routes only the health and analysis endpoints needed by this slice.
     *
     * @param req - Incoming Node request.
     * @param res - Node response writer.
     * @returns Promise that resolves after the response is written.
     */
    private static async route(
        req: IncomingMessage,
        res: ServerResponse,
    ): Promise<void> {
        if (req.method === 'GET' && req.url === '/v1/health') {
            BackendHttpServer.sendJson(
                res,
                200,
                BackendAnalysisApi.health(BACKEND_VERSION),
            );
            return;
        }

        if (req.method === 'POST' && req.url === '/v1/analysis') {
            await BackendHttpServer.handleAnalysis(req, res);
            return;
        }

        BackendHttpServer.sendJson(
            res,
            404,
            BackendHttpServer.error('invalid_request', 'Unknown route.'),
        );
    }

    /**
     * Converts request-body failures into typed responses before API handling.
     *
     * @param req - Incoming analysis request stream.
     * @param res - Node response writer.
     * @returns Promise that resolves after the response is written.
     */
    private static async handleAnalysis(
        req: IncomingMessage,
        res: ServerResponse,
    ): Promise<void> {
        const readResult = await BackendHttpServer.readJsonBody(req);
        if (!readResult.ok) {
            BackendHttpServer.sendJson(
                res,
                readResult.statusCode,
                readResult.body,
            );
            return;
        }

        const result = BackendAnalysisApi.handleAnalysisRequest(
            readResult.body,
        );
        BackendHttpServer.sendJson(res, result.statusCode, result.body);
    }

    /**
     * Reads JSON while bounding stored body text and guarding parse failures.
     *
     * @param req - Incoming Node request stream.
     * @returns Parsed JSON body or a typed request error.
     */
    private static async readJsonBody(
        req: IncomingMessage,
    ): Promise<ReadJsonBodyResult> {
        let body = '';
        let byteLength = 0;
        let tooLarge = false;

        req.setEncoding('utf8');
        for await (const chunk of req) {
            const text = String(chunk);
            byteLength += Buffer.byteLength(text, 'utf8');
            if (byteLength > MAX_ANALYSIS_REQUEST_BODY_BYTES) {
                tooLarge = true;
                continue;
            }
            body += text;
        }

        if (tooLarge) {
            return {
                ok: false,
                statusCode: 413,
                body: BackendHttpServer.error(
                    'request_body_too_large',
                    'Request body exceeds the local API limit.',
                ),
            };
        }

        if (body.length === 0) {
            return { ok: true, body: {} };
        }

        try {
            return { ok: true, body: JSON.parse(body) as unknown };
        } catch {
            return {
                ok: false,
                statusCode: 400,
                body: BackendHttpServer.error(
                    'invalid_request',
                    'Malformed JSON request body.',
                ),
            };
        }
    }

    /**
     * Serializes a typed JSON response with the shared content type.
     *
     * @param res - Node response writer.
     * @param statusCode - HTTP status code.
     * @param body - JSON-serializable response body.
     * @returns Nothing.
     */
    private static sendJson(
        res: ServerResponse,
        statusCode: number,
        body: unknown,
    ): void {
        res.writeHead(statusCode, { 'content-type': MIME_APPLICATION_JSON });
        res.end(`${JSON.stringify(body)}\n`);
    }

    /**
     * Builds typed error responses so server and OpenAPI stay aligned.
     *
     * @param code - Stable error code from the local backend contract.
     * @param message - User-safe error summary.
     * @returns Validated error response.
     */
    private static error(
        code: 'invalid_video_id' | 'invalid_request' | 'request_body_too_large',
        message: string,
    ): ErrorResponse {
        return v.parse(errorResponseSchema, {
            status: 'invalid_request',
            error: { code, message },
        });
    }
}

if (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    BackendHttpServer.listen();
}
```

Add to `package.json` scripts:

```json
"backend:dev": "tsx src/backend/server.ts"
```

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm run test tests/backend/analysis-api.test.ts tests/backend/server.test.ts`

Expected: PASS.

**Verification**: A local backend can be started with `pnpm run backend:dev`, responds with deterministic `processing`, returns typed `400` for malformed JSON, and returns typed `413` for oversized request bodies without accumulating unlimited text.

### [x] Task 4: Dev-Only Backend Host Permission

**Files:**

- Modify: `rspack.config.ts`

- [x] **Step 1: Write the failing verification command**

Run:

```bash
TOPSKIP_BUILD=dev pnpm run build
node -e "const fs=require('node:fs'); const m=JSON.parse(fs.readFileSync('dist/manifest.json','utf8')); if (!m.host_permissions.includes('http://127.0.0.1:8787/*')) throw new Error('missing backend host permission');"
TOPSKIP_BUILD=release pnpm run build
node -e "const fs=require('node:fs'); const m=JSON.parse(fs.readFileSync('dist/manifest.json','utf8')); if (m.host_permissions.includes('http://127.0.0.1:8787/*')) throw new Error('release contains backend host permission');"
```

Expected: The first `node -e` command fails before implementation with `missing backend host permission`.

- [x] **Step 2: Write minimal implementation**

In `rspack.config.ts`, replace the single dev match constant with explicit constants:

```ts
const DEV_E2E_MATCH = 'http://127.0.0.1:4173/*';
const DEV_BACKEND_MATCH = 'http://127.0.0.1:8787/*';
```

Then push the backend match only into `host_permissions` when `build === TopSkipBuild.Dev`:

```ts
for (const match of [DEV_E2E_MATCH, DEV_BACKEND_MATCH]) {
    if (!hostPermissions.includes(match)) {
        hostPermissions.push(match);
    }
}
const firstContentScript = manifest.content_scripts?.[0];
if (
    firstContentScript &&
    !firstContentScript.matches.includes(DEV_E2E_MATCH)
) {
    firstContentScript.matches.push(DEV_E2E_MATCH);
}
```

- [x] **Step 3: Run verification to verify it passes**

Run the same command block from Step 1.

Expected: PASS.

**Verification**: Dev builds can fetch the local backend, while release builds keep dev localhost hosts out of the Web Store manifest.

### [x] Task 5: Background Server Client

**Files:**

- Create: `src/background/server-analysis-client.ts`
- Create: `tests/background/server-analysis-client.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerAnalysisClient } from '@/background/server-analysis-client';
import { MIME_APPLICATION_JSON } from '@/shared/constants';

const fetchMock = vi.fn();

describe('ServerAnalysisClient', () => {
    beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('posts video metadata to the configured local backend', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    status: 'processing',
                    videoId: 'dQw4w9WgXcQ',
                    algorithmVersion: 'server-v1',
                    jobId: 'local-dQw4w9WgXcQ-server-v1',
                    pollAfterSec: 3,
                }),
                {
                    status: 202,
                    headers: { 'content-type': MIME_APPLICATION_JSON },
                },
            ),
        );

        const response = await ServerAnalysisClient.requestProcessing({
            videoId: 'dQw4w9WgXcQ',
            durationSec: 213,
            extensionVersion: '0.1.0',
        });

        expect(response.status).toBe('processing');
        expect(fetchMock).toHaveBeenCalledWith(
            'http://127.0.0.1:8787/v1/analysis',
            expect.objectContaining({
                method: 'POST',
                headers: {
                    accept: MIME_APPLICATION_JSON,
                    'content-type': MIME_APPLICATION_JSON,
                },
            }),
        );
        const [, init] = fetchMock.mock.calls[0];
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        expect(body.videoId).toBe('dQw4w9WgXcQ');
        expect(body.durationSec).toBe(213);
        expect(body.extensionVersion).toBe('0.1.0');
        expect(body).not.toHaveProperty('captions');
        expect(body).not.toHaveProperty('transcript');
    });

    it('aborts hung backend requests with a timeout error', async () => {
        vi.useFakeTimers();
        fetchMock.mockImplementation((_url: string, init: RequestInit) => {
            return new Promise((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => {
                    reject(new DOMException('Aborted', 'AbortError'));
                });
            });
        });

        const promise = ServerAnalysisClient.requestProcessing({
            videoId: 'dQw4w9WgXcQ',
            durationSec: 213,
            extensionVersion: '0.1.0',
        });

        await vi.advanceTimersByTimeAsync(5_000);

        await expect(promise).rejects.toThrow(
            'Server analysis timed out.',
        );
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/background/server-analysis-client.test.ts`

Expected: FAIL with `Cannot find module '@/background/server-analysis-client'`.

- [x] **Step 3: Write minimal implementation**

Add multi-line JSDoc to the `ServerAnalysisClient` class and the async `requestProcessing` method, including an `@returns` tag. The method must pass an `AbortSignal` to `fetch`, clear the timeout in `finally`, and throw a stable timeout error when the signal aborts.

```ts
import * as v from 'valibot';

import {
    TOPSKIP_LOCAL_BACKEND_BASE_URL,
    buildServerAnalysisRequest,
    processingResponseSchema,
    type ProcessingResponse,
} from '@/shared/server-analysis-contract';
import { MIME_APPLICATION_JSON } from '@/shared/constants';

const SERVER_ANALYSIS_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Background-owned client for the local TopSkip backend; static API only.
 */
export class ServerAnalysisClient {
    /**
     * Requests a non-blocking server analysis state for the current video.
     *
     * @param input - Current video metadata and extension version.
     * @returns Validated processing response from the local backend.
     */
    static async requestProcessing(input: {
        videoId: string;
        durationSec?: number;
        extensionVersion: string;
    }): Promise<ProcessingResponse> {
        const request = buildServerAnalysisRequest(input);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
            controller.abort();
        }, SERVER_ANALYSIS_REQUEST_TIMEOUT_MS);

        try {
            const res = await fetch(
                `${TOPSKIP_LOCAL_BACKEND_BASE_URL}/v1/analysis`,
                {
                    method: 'POST',
                    headers: {
                        accept: MIME_APPLICATION_JSON,
                        'content-type': MIME_APPLICATION_JSON,
                    },
                    body: JSON.stringify(request),
                    signal: controller.signal,
                },
            );
            const json = (await res.json()) as unknown;
            if (!res.ok) {
                throw new Error(
                    `Server analysis failed with HTTP ${res.status}`,
                );
            }
            return v.parse(processingResponseSchema, json);
        } catch (error) {
            if (controller.signal.aborted) {
                throw new Error('Server analysis timed out.');
            }
            throw error;
        } finally {
            clearTimeout(timeoutId);
        }
    }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/background/server-analysis-client.test.ts`

Expected: PASS.

**Verification**: The extension background can call the configured local endpoint with metadata only, validates the processing response, and aborts hung backend requests with a stable timeout error.

### [x] Task 6: Runtime Message for Server Analysis

**Files:**

- Modify: `src/shared/messages.ts`
- Create: `src/background/messaging/server-analysis-runtime-messages.ts`
- Modify: `src/background/messaging/register-runtime-messages.ts`
- Create: `tests/background/messaging/server-analysis-runtime-messages.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefsMocks = vi.hoisted(() => ({
    ready: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue({
        enabled: true,
        providerId: 'openrouter',
        activeModelId: 'openrouter:google/gemini-3.1-pro-preview',
        analysisMode: 'server',
    }),
}));

vi.mock('@/background/storage/prefs-sync', () => ({
    PrefsSyncStorage: prefsMocks,
}));

const clientMocks = vi.hoisted(() => ({
    requestProcessing: vi.fn().mockResolvedValue({
        status: 'processing',
        videoId: 'dQw4w9WgXcQ',
        algorithmVersion: 'server-v1',
        jobId: 'local-dQw4w9WgXcQ-server-v1',
        pollAfterSec: 3,
    }),
}));

vi.mock('@/background/server-analysis-client', () => ({
    ServerAnalysisClient: clientMocks,
}));

const detectionMocks = vi.hoisted(() => ({
    set: vi.fn(),
}));

vi.mock('@/background/promo-detection-store', () => ({
    PromoDetectionStore: detectionMocks,
}));

vi.mock('@/shared/browser', () => ({
    default: {
        runtime: {
            getManifest: () => ({ version: '0.1.0' }),
        },
    },
}));

import { ServerAnalysisRuntimeMessages } from '@/background/messaging/server-analysis-runtime-messages';

describe('ServerAnalysisRuntimeMessages', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('maps processing response into server pending detection state', async () => {
        const result = await ServerAnalysisRuntimeMessages.handleRequest(
            { videoId: 'dQw4w9WgXcQ', durationSec: 213 },
            { tab: { id: 42 } } as never,
        );

        expect(result).toEqual({ ok: true, status: 'processing' });
        expect(clientMocks.requestProcessing).toHaveBeenCalledWith({
            videoId: 'dQw4w9WgXcQ',
            durationSec: 213,
            extensionVersion: '0.1.0',
        });
        expect(detectionMocks.set).toHaveBeenCalledWith(42, {
            videoId: 'dQw4w9WgXcQ',
            status: 'analyzing',
            source: 'server',
        });
    });

    it('maps client failures into server error detection state', async () => {
        clientMocks.requestProcessing.mockRejectedValueOnce(
            new Error('Server analysis timed out.'),
        );

        const result = await ServerAnalysisRuntimeMessages.handleRequest(
            { videoId: 'dQw4w9WgXcQ', durationSec: 213 },
            { tab: { id: 42 } } as never,
        );

        expect(result).toEqual({
            ok: false,
            error: 'Server analysis timed out.',
        });
        expect(detectionMocks.set).toHaveBeenCalledWith(42, {
            videoId: 'dQw4w9WgXcQ',
            status: 'error',
            source: 'server',
            error: 'Server analysis timed out.',
        });
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/background/messaging/server-analysis-runtime-messages.test.ts`

Expected: FAIL with `Cannot find module '@/background/messaging/server-analysis-runtime-messages'`.

- [x] **Step 3: Write minimal implementation**

In `src/shared/messages.ts`, add:

```ts
REQUEST_SERVER_ANALYSIS: 'TOPSKIP_REQUEST_SERVER_ANALYSIS',
```

Add the request/response types:

```ts
/**
 * Content-to-background payload requesting server-first analysis.
 */
export type RequestServerAnalysisPayload = {
    videoId: string;
    durationSec?: number;
};

/**
 * Ack returned after the background updates server detection state.
 */
export type RequestServerAnalysisResponse =
    | { ok: true; status: 'processing' }
    | { ok: false; error: string };
```

Add the union member:

```ts
| {
      type: typeof TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS;
      payload: RequestServerAnalysisPayload;
  }
```

Create `src/background/messaging/server-analysis-runtime-messages.ts`:

```ts
import type { Runtime } from 'webextension-polyfill/namespaces/runtime';

import { ServerAnalysisClient } from '@/background/server-analysis-client';
import { PromoDetectionStore } from '@/background/promo-detection-store';
import { PrefsSyncStorage } from '@/background/storage/prefs-sync';
import browser from '@/shared/browser';
import { ANALYSIS_MODE } from '@/shared/constants';
import { getErrorMessage } from '@/shared/error';
import type {
    RequestServerAnalysisPayload,
    RequestServerAnalysisResponse,
} from '@/shared/messages';

/**
 * Handles server-first analysis requests from the watch content script; static
 * API only.
 */
export class ServerAnalysisRuntimeMessages {
    /**
     * Calls the local backend and maps the response into popup detection state.
     *
     * @param payload - Current video metadata from the content script.
     * @param sender - Runtime sender containing the source tab id.
     * @returns Processing ack or a user-safe server error.
     */
    static async handleRequest(
        payload: RequestServerAnalysisPayload,
        sender: Runtime.MessageSender,
    ): Promise<RequestServerAnalysisResponse> {
        const tabId = sender.tab?.id;
        if (tabId === undefined) {
            return { ok: false, error: 'Missing sender tab id.' };
        }

        await PrefsSyncStorage.ready();
        const prefs = await PrefsSyncStorage.load();
        if (!prefs.enabled || prefs.analysisMode !== ANALYSIS_MODE.Server) {
            return { ok: true, status: 'processing' };
        }

        try {
            await ServerAnalysisClient.requestProcessing({
                videoId: payload.videoId,
                durationSec: payload.durationSec,
                extensionVersion: browser.runtime.getManifest().version,
            });
            PromoDetectionStore.set(tabId, {
                videoId: payload.videoId,
                status: 'analyzing',
                source: 'server',
            });
            return { ok: true, status: 'processing' };
        } catch (e) {
            const error = getErrorMessage(e);
            PromoDetectionStore.set(tabId, {
                videoId: payload.videoId,
                status: 'error',
                source: 'server',
                error,
            });
            return { ok: false, error };
        }
    }
}
```

In `register-runtime-messages.ts`, import the handler and add:

```ts
case TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS:
    return ServerAnalysisRuntimeMessages.handleRequest(msg.payload, sender);
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/background/messaging/server-analysis-runtime-messages.test.ts`

Expected: PASS.

**Verification**: Processing responses become `PromoDetectionStore` snapshots for the sender tab, and timeout/network/invalid-response failures become `{ status: 'error', source: 'server' }` snapshots instead of leaving the request pending.

### [x] Task 7: Content-Side Server Route

**Files:**

- Create: `src/content/server-analysis-request.ts`
- Create: `tests/content/server-analysis-request.test.ts`
- Modify: `src/content/page-guards.ts`
- Modify: `tests/content/page-guards.test.ts`
- Modify: `src/content/youtube-watch.ts`

- [x] **Step 1: Write the failing helper tests**

```ts
import { describe, expect, it } from 'vitest';

import {
    buildRequestServerAnalysisMessage,
    shouldUseServerAnalysis,
} from '@/content/server-analysis-request';
import { ANALYSIS_MODE } from '@/shared/constants';
import { TOPSKIP_MESSAGE } from '@/shared/messages';

describe('server analysis content request helper', () => {
    it('uses server analysis only when enabled and in server mode', () => {
        expect(
            shouldUseServerAnalysis({
                enabled: true,
                providerId: 'openrouter',
                activeModelId: 'openrouter:test',
                analysisMode: ANALYSIS_MODE.Server,
            }),
        ).toBe(true);

        expect(
            shouldUseServerAnalysis({
                enabled: true,
                providerId: 'openrouter',
                activeModelId: 'openrouter:test',
                analysisMode: ANALYSIS_MODE.Byok,
            }),
        ).toBe(false);
    });

    it('builds a server analysis message with known finite duration', () => {
        expect(
            buildRequestServerAnalysisMessage({
                videoId: 'dQw4w9WgXcQ',
                durationSec: 213,
            }),
        ).toEqual({
            type: TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS,
            payload: {
                videoId: 'dQw4w9WgXcQ',
                durationSec: 213,
            },
        });
    });
});
```

Update `tests/content/page-guards.test.ts`:

```ts
it('returns a valid synthetic id for e2e host', () => {
    expect(getWatchVideoIdFromSearch(E2E_HOST, '')).toBe('e2eFixture1');
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `pnpm run test tests/content/server-analysis-request.test.ts tests/content/page-guards.test.ts`

Expected: FAIL because the helper module is missing and the e2e id is still `e2e-fixture`.

- [x] **Step 3: Write minimal implementation**

Add multi-line JSDoc blocks to both exported helper functions in `src/content/server-analysis-request.ts`; include `@param` and `@returns` because both functions return values.

`src/content/server-analysis-request.ts`:

```ts
import { ANALYSIS_MODE, type UserPreferences } from '@/shared/constants';
import { TOPSKIP_MESSAGE, type TopSkipRuntimeMessage } from '@/shared/messages';

/**
 * Keeps server-mode routing out of the caption capture path.
 *
 * @param prefs - Current preferences cached by the watch content script.
 * @returns `true` when the video should request server analysis.
 */
export function shouldUseServerAnalysis(prefs: UserPreferences): boolean {
    return prefs.enabled && prefs.analysisMode === ANALYSIS_MODE.Server;
}

/**
 * Builds the runtime message sent from content to background for server mode.
 *
 * @param input - Current watch video id and optional finite duration.
 * @returns Runtime message for the background server-analysis handler.
 */
export function buildRequestServerAnalysisMessage(input: {
    videoId: string;
    durationSec?: number;
}): TopSkipRuntimeMessage {
    const payload =
        input.durationSec !== undefined && Number.isFinite(input.durationSec)
            ? { videoId: input.videoId, durationSec: input.durationSec }
            : { videoId: input.videoId };
    return {
        type: TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS,
        payload,
    };
}
```

In `src/content/page-guards.ts`, change the fixture ID to:

```ts
return 'e2eFixture1';
```

In `src/content/youtube-watch.ts`, replace the `enabled` scalar with a full `prefs: UserPreferences` cache. In `syncVideoBinding`, branch:

```ts
if (video && shouldUseServerAnalysis(YoutubeWatch.prefs)) {
    YoutubeWatch.bindVideo(video);
    if (vid !== null && YoutubeWatch.serverRequestedVideoId !== vid) {
        YoutubeWatch.serverRequestedVideoId = vid;
        const durationSec = Number.isFinite(video.duration)
            ? video.duration
            : undefined;
        void browser.runtime.sendMessage(
            buildRequestServerAnalysisMessage({ videoId: vid, durationSec }),
        );
    }
    return;
}

if (video) {
    WatchCaptions.installPageBridge();
    WatchCaptions.scheduleForVideoId(vid, 'video-element-ready');
    YoutubeWatch.bindVideo(video);
}
```

Reset `serverRequestedVideoId` in `resetForNewVideo`, and call `syncVideoBinding()` after `GET_PREFS` resolves so the first request waits for the mode decision.

- [x] **Step 4: Run tests to verify they pass**

Run: `pnpm run test tests/content/server-analysis-request.test.ts tests/content/page-guards.test.ts`

Expected: PASS.

**Verification**: Server mode sends a metadata request, while BYOK remains the only route that schedules caption capture.

### [x] Task 8: Guard Caption Handler from Provider Analysis in Server Mode

**Files:**

- Modify: `src/background/messaging/caption-runtime-messages.ts`
- Create: `tests/background/messaging/caption-runtime-messages.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefsMocks = vi.hoisted(() => ({
    ready: vi.fn().mockResolvedValue(undefined),
    load: vi.fn(),
}));

vi.mock('@/background/storage/prefs-sync', () => ({
    PrefsSyncStorage: prefsMocks,
}));

const promoMocks = vi.hoisted(() => ({
    onCaptionsReady: vi.fn(),
}));

vi.mock('@/background/messaging/promo-analysis', () => ({
    PromoAnalysis: promoMocks,
}));

vi.mock('@/background/captions/log-transcript-dev', () => ({
    logTranscriptForDeveloper: vi.fn().mockResolvedValue(undefined),
}));

import { CaptionRuntimeMessages } from '@/background/messaging/caption-runtime-messages';

const payload = {
    ok: true,
    videoId: 'dQw4w9WgXcQ',
    languageCode: 'en',
    segments: [{ startSec: 0, durationSec: 2, text: 'hello' }],
} as const;

describe('CaptionRuntimeMessages analysis mode guard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('does not invoke provider analysis in server mode', async () => {
        prefsMocks.load.mockResolvedValue({
            enabled: true,
            providerId: 'openrouter',
            activeModelId: 'openrouter:test',
            analysisMode: 'server',
        });

        await CaptionRuntimeMessages.handle(payload, { tab: { id: 42 } } as never);

        expect(promoMocks.onCaptionsReady).not.toHaveBeenCalled();
    });

    it('keeps BYOK mode on the existing provider path', async () => {
        prefsMocks.load.mockResolvedValue({
            enabled: true,
            providerId: 'openrouter',
            activeModelId: 'openrouter:test',
            analysisMode: 'byok',
        });

        await CaptionRuntimeMessages.handle(payload, { tab: { id: 42 } } as never);

        expect(promoMocks.onCaptionsReady).toHaveBeenCalled();
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/background/messaging/caption-runtime-messages.test.ts`

Expected: FAIL because the server-mode branch still calls `PromoAnalysis.onCaptionsReady`.

- [x] **Step 3: Write minimal implementation**

Change `CaptionRuntimeMessages.handle` to be `async`, load prefs after validating `payload.ok`, and return early unless BYOK is active:

```ts
await PrefsSyncStorage.ready();
const prefs = await PrefsSyncStorage.load();
if (prefs.analysisMode !== ANALYSIS_MODE.Byok) {
    return { ok: true };
}
```

Keep the existing `logTranscriptForDeveloper` and `PromoAnalysis.onCaptionsReady` path after that guard.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/background/messaging/caption-runtime-messages.test.ts`

Expected: PASS.

**Verification**: Acceptance criterion 4 is protected even if a stale content script forwards captions while server mode is active.

### [x] Task 9: Server Popup Status States

**Files:**

- Modify: `src/shared/messages.ts`
- Modify: `src/popup/PopupApp.tsx`
- Modify: `tests/popup/popup-view-model.test.ts`
- Modify: every `src/_locales/*/messages.json`

- [x] **Step 1: Write the failing test**

```ts
it('server analyzing state explains that backend work is pending', () => {
    const vm = buildPopupViewModel({
        ...baseArgs,
        detectionState: {
            videoId: 'dQw4w9WgXcQ',
            status: 'analyzing',
            source: 'server',
        },
    });

    expect(vm.title).toBe('Server analysis pending');
    expect(vm.statusHeadline).toBe('Server analysis is in progress.');
    expect(vm.statusBody).toContain('TopSkip backend');
});

it('server error state explains the backend failure path', () => {
    const vm = buildPopupViewModel({
        ...baseArgs,
        detectionState: {
            videoId: 'dQw4w9WgXcQ',
            status: 'error',
            source: 'server',
            error: 'Server analysis timed out.',
        },
    });

    expect(vm.title).toBe('Server analysis unavailable');
    expect(vm.statusHeadline).toBe('Server analysis timed out.');
    expect(vm.statusBody).toContain('local TopSkip backend');
    expect(vm.statusBody).not.toContain('API key');
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/popup/popup-view-model.test.ts`

Expected: FAIL because `source` is not modeled, `analyzing` still renders caption-analysis copy, and server-source errors still render local provider/API-key guidance.

- [x] **Step 3: Write minimal implementation**

In `src/shared/messages.ts`, add:

```ts
/**
 * Origin of the latest promo detection state shown in the popup.
 */
export type PromoDetectionSource =
    | 'server'
    | 'local_provider'
    | 'local_cache'
    | 'server_cache';
```

Add to `PromoDetectionStatePayload`:

```ts
source?: PromoDetectionSource;
```

In `PopupApp.tsx`, handle server analyzing before the existing `switch`:

```ts
if (
    detectionState.status === 'analyzing' &&
    detectionState.source === 'server'
) {
    return {
        tone: 'brand',
        badgeLabel: translator.getMessage('popup_detection_server_pending_badge'),
        badgeColor: 'brand',
        title: translator.getMessage('popup_detection_server_pending_title'),
        description: translator.getMessage(
            'popup_detection_server_pending_description',
        ),
        activityLabel: ACTIVITY_LABEL_ACTIVE,
        statusHeadline: translator.getMessage(
            'popup_detection_server_pending_headline',
        ),
        statusBody: translator.getMessage(
            'popup_detection_server_pending_body',
        ),
        settingsLabel: translator.getMessage('popup_open_settings'),
        providerLabel,
    };
}

if (
    detectionState.status === 'error' &&
    detectionState.source === 'server'
) {
    return {
        tone: 'danger',
        badgeLabel: translator.getMessage('popup_detection_server_error_badge'),
        badgeColor: 'error',
        title: translator.getMessage('popup_detection_server_error_title'),
        description: translator.getMessage(
            'popup_detection_server_error_description',
        ),
        activityLabel: ACTIVITY_LABEL_UNAVAILABLE,
        statusHeadline:
            detectionState.error ??
            translator.getMessage('popup_detection_server_error_headline'),
        statusBody: translator.getMessage(
            'popup_detection_server_error_body',
        ),
        settingsLabel: translator.getMessage('popup_open_settings'),
        providerLabel,
    };
}
```

Add these keys to every locale file, using the English source text if translated copy is not available:

```json
"popup_detection_server_pending_badge": {
    "message": "Server",
    "description": "Popup status badge shown while the TopSkip backend is analyzing the current video."
},
"popup_detection_server_pending_title": {
    "message": "Server analysis pending",
    "description": "Popup title shown while the TopSkip backend is analyzing the current video."
},
"popup_detection_server_pending_description": {
    "message": "TopSkip asked the local backend to analyze this video.",
    "description": "Popup description shown while the local backend is processing a video."
},
"popup_detection_server_pending_headline": {
    "message": "Server analysis is in progress.",
    "description": "Popup headline shown for a server processing response."
},
"popup_detection_server_pending_body": {
    "message": "Skipping will start when the TopSkip backend has promo blocks for a future playback position.",
    "description": "Popup body shown for a server processing response."
},
"popup_detection_server_error_badge": {
    "message": "Server",
    "description": "Popup status badge shown when server analysis fails."
},
"popup_detection_server_error_title": {
    "message": "Server analysis unavailable",
    "description": "Popup title shown when the local backend request fails."
},
"popup_detection_server_error_description": {
    "message": "TopSkip could not use the local backend for this video.",
    "description": "Popup description shown when server analysis cannot run."
},
"popup_detection_server_error_headline": {
    "message": "Server analysis failed.",
    "description": "Fallback popup headline shown when no specific server error is available."
},
"popup_detection_server_error_body": {
    "message": "The local TopSkip backend did not return a usable response. Playback continues without server-detected skips.",
    "description": "Popup body shown for server request failures."
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/popup/popup-view-model.test.ts`

Expected: PASS.

**Verification**: Popup status distinguishes server processing and server failures from local caption/provider analysis, and server failures never show API-key or transcript troubleshooting copy.

### [x] Task 10: End-to-End Server Pending Flow

**Files:**

- Modify: `e2e/extension.spec.ts`

- [x] **Step 1: Write the failing e2e test**

Add a local backend test server inside the Playwright test and assert the popup text:

```ts
test('server mode reports pending analysis from local backend', async () => {
    const backend = createServer((req, res) => {
        if (req.method !== 'POST' || req.url !== '/v1/analysis') {
            res.writeHead(404);
            res.end();
            return;
        }
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (chunk) => {
            body = body + chunk;
        });
        req.on('end', () => {
            expect(JSON.parse(body)).toMatchObject({
                videoId: 'e2eFixture1',
                algorithmVersion: 'server-v1',
            });
            expect(body).not.toContain('transcript');
            res.writeHead(202, { 'content-type': 'application/json' });
            res.end(
                JSON.stringify({
                    status: 'processing',
                    videoId: 'e2eFixture1',
                    algorithmVersion: 'server-v1',
                    jobId: 'local-e2eFixture1-server-v1',
                    pollAfterSec: 3,
                }),
            );
        });
    });
    await new Promise<void>((resolve) => {
        backend.listen(8787, '127.0.0.1', () => resolve());
    });

    const errors: string[] = [];
    const context = await chromium.launchPersistentContext(
        '',
        extensionContextOptions(),
    );

    try {
        trackServiceWorkerConsoleErrors(context, errors);
        const extensionId = await getExtensionId(context);
        const page = await context.newPage();
        trackPageErrors(page, 'fixture', errors);
        await page.goto('/video.html', { waitUntil: 'domcontentloaded' });

        const popupPage = await openPopupAndWaitForUi(
            context,
            extensionId,
            errors,
        );
        await expect(
            popupPage.getByText('Server analysis pending'),
        ).toBeVisible();
        await popupPage.close();
        expectNoCollectedErrors(errors);
    } finally {
        await context.close();
        backend.close();
    }
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run build && pnpm run test:e2e -- --grep "server mode reports pending analysis"`

Expected: FAIL because the extension does not yet send a server request or render server pending status.

- [x] **Step 3: Complete integration fixes**

Ensure the code from Tasks 4, 6, 7, and 9 is wired together:

- Dev manifest includes `http://127.0.0.1:8787/*`.
- `YoutubeWatch` sends `REQUEST_SERVER_ANALYSIS` once per video ID in server mode.
- `ServerAnalysisRuntimeMessages` writes `{ status: 'analyzing', source: 'server' }`.
- Popup renders `Server analysis pending`.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run build && pnpm run test:e2e -- --grep "server mode reports pending analysis"`

Expected: PASS.

**Verification**: The full extension path reaches the local backend and reports server processing in the popup.

### [x] Task 11: Final Validation

**Files:**

- No new files; verify the full touched surface.

- [x] **Step 1: Run focused unit tests**

Run:

```bash
pnpm run test tests/shared/server-analysis-contract.test.ts tests/backend/analysis-api.test.ts tests/backend/server.test.ts tests/background/server-analysis-client.test.ts tests/background/messaging/server-analysis-runtime-messages.test.ts tests/background/messaging/caption-runtime-messages.test.ts tests/content/server-analysis-request.test.ts tests/content/page-guards.test.ts tests/popup/popup-view-model.test.ts tests/background/storage/prefs-sync.test.ts
```

Expected: PASS.

- [x] **Step 2: Run project checks**

Run:

```bash
pnpm run lint
pnpm run build
pnpm run test
pnpm run test:e2e
```

Expected: PASS.

- [x] **Step 3: Manual smoke**

Run:

```bash
pnpm run backend:dev
pnpm run build
```

Load `dist/` as an unpacked extension, open the local fixture or a supported YouTube watch page, open the popup, and verify it shows server analysis pending for the current video.

**Verification**: All acceptance criteria are covered by automated tests and the manual smoke path.

## Self-Review

### Issue Coverage

- **Acceptance criterion 1**: Covered by Tasks 5, 6, 7, and 10. The content script sends a validated `REQUEST_SERVER_ANALYSIS` message, and the background posts to the configured local backend endpoint.
- **Acceptance criterion 2**: Covered by Tasks 1 and 3. The local backend validates the request, rejects malformed JSON and oversized bodies before work starts, and returns deterministic `processing` without extraction, transcription, or LLM work.
- **Acceptance criterion 3**: Covered by Tasks 6, 9, and 10. The background maps processing to `PromoDetectionStore`, maps server failures to `source: 'server'` errors, and the popup renders server pending/error status.
- **Acceptance criterion 4**: Covered by Tasks 7 and 8. Server mode does not schedule caption capture and the caption handler refuses to invoke `PromoAnalysis` unless prefs are in BYOK mode.

### Placeholder Scan

The plan contains no placeholder tokens, no deferred implementation instructions, and no repeated "copy the previous task" steps. Every task names concrete files, test commands, and implementation details.

### Type Consistency

- `analysisMode` is added to `UserPreferences` and flows through prefs broadcasts unchanged.
- `RequestServerAnalysisPayload` is the content-to-background message payload.
- `ServerAnalysisRequest` is the background-to-backend HTTP payload.
- `ProcessingResponse.status === 'processing'` maps to `PromoDetectionStatePayload.status === 'analyzing'` with `source === 'server'`.
- `ServerAnalysisClient` timeout/network/schema failures map to `PromoDetectionStatePayload.status === 'error'` with `source === 'server'`.
- `ProcessingResponse.pollAfterSec` is an integer in both OpenAPI and Valibot.
- `AnalysisRequest.client.capabilities` is unique in both OpenAPI and Valibot.

### Review Findings Addressed

- **Valibot/OpenAPI parity**: Addressed in the Contracts section and Task 1. The plan now requires tests for duplicate `client.capabilities` and fractional `pollAfterSec`, implements `requestCapabilitiesSchema` with `v.check`, and validates `pollAfterSec` with `v.integer()`.
- **Guarded JSON parsing and request body limits**: Addressed in the Contracts section, `.sdd/.current/issues/1-AFK/contracts/openapi.yaml`, and Task 3. The plan now requires `tests/backend/server.test.ts`, guarded `JSON.parse` handling, `MAX_ANALYSIS_REQUEST_BODY_BYTES`, typed `400` malformed JSON responses, and typed `413` oversized-body responses.
- **Request timeout/abort behavior**: Addressed in Task 5 and Task 6. The plan now requires `AbortController`, `SERVER_ANALYSIS_REQUEST_TIMEOUT_MS`, a timeout unit test, and runtime-message mapping from timeout errors into `{ status: 'error', source: 'server' }`.
- **Multi-line JSDoc for new `src/` declarations**: Addressed in Tasks 1, 2, 3, 5, 6, and 7. The plan now calls out multi-line JSDoc for new type aliases, functions, classes, and class methods, including `@param` and `@returns` where required by repo lint rules.
- **Server-specific popup error copy/status**: Addressed in Task 9. The plan now adds server-source error view-model tests, popup rendering, and locale keys so backend failures do not display API-key, transcript, or direct-provider troubleshooting copy.
