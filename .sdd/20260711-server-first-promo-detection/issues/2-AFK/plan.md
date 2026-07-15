# Implementation Plan: Server Cache Hit Applies Promo Blocks

- **Created**: 2026-07-06
- **Status**: Approved
- **Issue**: `.sdd/.current/issues/2-AFK/issue.md`
- **PRD**: `.sdd/.current/prd.md`
- **Model**: GPT-5 Codex
- **User Input**: `ISSUE_ID=2-AFK`, `SPECS_DIR=.sdd/.current`, constraints: revise the existing plan to address review findings by making server-cache ready popup state take precedence over Chrome provider availability branches and by adding finite promo-block timeline validation/tests before server blocks can reach seek logic.

## Summary

Extend the validated local backend tracer bullet so a seeded in-memory cache entry returns `ready` promo blocks for the requested video and algorithm version. The background service worker validates the `ready` response, rejects mismatched video IDs, updates popup detection state as a server cache hit, and forwards the same blocks to the current tab through the existing `PROMO_BLOCKS_DETECTED` path. Ready response validation must reject non-finite `startSec` and `endSec` values before they can reach content seek logic. The popup must render server-cache ready state before any Chrome provider availability setup/unavailable branches, so server cache hits are not hidden by private-provider setup state.

## Technical Context

- **Language/Version**: TypeScript 6.0.2 in strict ESM mode; Node.js `>=20`.
- **Primary Dependencies**: Rspack, React 19.2, Mantine 9, MobX 6, Valibot 1.3, `webextension-polyfill`, Vitest, Playwright.
- **Storage**: Existing extension preferences stay in `browser.storage.local` through `PrefsSyncStorage`; this issue adds only an in-memory, fixture-backed backend cache.
- **Testing**: Vitest for shared schemas, backend API, HTTP server, background client, background runtime routing, popup view model, and pure content skip logic; Playwright for the extension plus local fixture.
- **Target Platform**: Chrome Manifest V3 service worker plus a local Node HTTP backend at `http://127.0.0.1:8787`.

## Research

### Existing Server Handshake

`src/shared/server-analysis-contract.ts:45` validates metadata-only requests, and `src/shared/server-analysis-contract.ts:59` currently accepts only `processing` responses. `src/backend/analysis-api.ts:46` returns `202 processing` for every valid request. `src/background/server-analysis-client.ts:23` parses only `processingResponseSchema`, and `src/background/messaging/server-analysis-runtime-messages.ts:42` maps every successful backend response to popup `status: 'analyzing', source: 'server'`. This issue extends those exact points with a `ready` union member rather than creating a second request path.

### Existing Promo Block Delivery Path

The local provider path already sends detected blocks with `browser.tabs.sendMessage` at `src/background/messaging/promo-analysis.ts:408` and `src/background/messaging/promo-analysis.ts:542`, using `TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED`. The content script receives that message in `src/content/youtube-watch.ts:491`, ignores mismatched `videoId` values at `src/content/youtube-watch.ts:497`, and stores active blocks at `src/content/youtube-watch.ts:511`. The server cache path should emit the same runtime message shape so content skip behavior stays shared.

### Existing Skip Behavior

`src/content/promo-skip-logic.ts:65` skips only when playback crosses an unseen block start during natural playback, suppresses seek-sized deltas, and uses rounded `startSec` keys to prevent duplicate skips. `src/content/youtube-watch.ts:240` resets fired keys on backward seek and `src/content/youtube-watch.ts:268` records the block start key before applying a seek. No new content skip algorithm is needed for this slice.

### Popup Source Metadata

`src/shared/messages.ts:213` already includes `server_cache` in `PromoDetectionSource`, but `src/popup/PopupApp.tsx:388` currently reaches detected states only after the Chrome Prompt API availability branch at `src/popup/PopupApp.tsx:334`. User Story 7 requires a server cache hit to be visible as server-detected blocks even when Chrome Built-in is selected and unavailable/downloading/downloadable, so the popup view model needs one source-specific branch for `status: 'detected'` plus `source: 'server_cache'` placed with the existing server-source branches before provider availability checks.

### Sub-Agent Availability

The requested explorer sub-agent is not callable in this session, so repository exploration was performed locally with `rg`, `sed`, and targeted line-number reads. No external research is needed because this issue only extends local code and an issue-owned OpenAPI contract.

## Entities

### Server Cache Fixture Entry

- **Fields**:
    - `videoId`: `string` - canonical 11-character YouTube ID; seeded fixture uses `e2eFixture1`.
    - `algorithmVersion`: `string` - must equal `SERVER_ANALYSIS_ALGORITHM_VERSION`.
    - `source`: `'server_cache'` - tells the extension this came from backend cache.
    - `promoBlocks`: `PromoBlock[]` - normalized blocks returned by the cache hit.
- **Relationships**: Looked up by `BackendAnalysisApi` after request validation; serialized as `ReadyResponse`.
- **Validation**: `videoId` must match `youtubeVideoIdSchema`; `algorithmVersion` must match the request; at least one valid promo block is required.
- **States**: Seeded in memory for this slice; later persistence replaces the fixture source.

### Ready Response

- **Fields**:
    - `status`: `'ready'`
    - `videoId`: `string`
    - `algorithmVersion`: `string`
    - `source`: `'server_cache'`
    - `promoBlocks`: `PromoBlock[]`
- **Relationships**: Returned by `POST /v1/analysis` with HTTP `200`; parsed by `ServerAnalysisClient`; delivered to content as `PROMO_BLOCKS_DETECTED`; stored in `PromoDetectionStore`.
- **Validation**: Strict Valibot object; blocks must have finite non-negative `startSec`, optional finite non-negative `endSec` greater than `startSec`, optional confidence in `'low' | 'medium' | 'high'`, and no extra properties.
- **States**: `ready` is terminal for this slice.

### Server Analysis Response

- **Fields**:
    - `ProcessingResponse`: existing `status: 'processing'` shape.
    - `ReadyResponse`: new `status: 'ready'` shape.
- **Relationships**: `ServerAnalysisClient.requestAnalysis` returns this union to the background runtime handler.
- **Validation**: Valibot union keyed by `status`; both members must match `.sdd/.current/issues/2-AFK/contracts/openapi.yaml`.
- **States**: `processing` keeps the popup in server pending; `ready` activates skips and marks detection as server cache.

### Promo Block

- **Fields**:
    - `startSec`: `number`
    - `endSec`: `number | undefined`
    - `confidence`: `'low' | 'medium' | 'high' | undefined`
- **Relationships**: Existing shared type in `src/shared/promo-types.ts`; consumed by `YoutubeWatch` and popup formatting.
- **Validation**: Server-ready response schema validates `Number.isFinite(startSec)` and `Number.isFinite(endSec)` before delivery; content skip logic clamps final seek targets to media duration.
- **States**: Delivered → active in content → fired once when crossed; fired state resets on backward seek or new video.

## Contracts

Contract file: `.sdd/.current/issues/2-AFK/contracts/openapi.yaml`.

Implemented routes after this issue:

- `GET /v1/health` returns `{ ok: true, service: 'topskip-backend', version }`.
- `POST /v1/analysis` returns `200 ReadyResponse` when the local in-memory cache has a matching `videoId + algorithmVersion`.
- `POST /v1/analysis` returns `202 ProcessingResponse` for valid uncached requests.
- Malformed JSON and invalid request bodies continue to return `400 ErrorResponse`.
- Oversized request bodies continue to return `413 ErrorResponse`.

The implementation must keep Valibot parity with the contract: `ReadyResponse.promoBlocks` is non-empty, promo block confidence is constrained to the documented enum, `endSec` must be greater than `startSec` when present, and extra properties are rejected. The OpenAPI contract uses JSON `number`, but the Valibot schema must still reject JavaScript `Infinity`, `-Infinity`, and `NaN` when direct tests or non-HTTP callers parse unknown values before the content seek path sees them.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `.sdd/.current/issues/2-AFK/contracts/openapi.yaml` | Create | Documents the new `200 ready` cache-hit response and promo block schema. |
| `src/shared/server-analysis-contract.ts` | Modify | Adds `promoBlockSchema`, `readyResponseSchema`, `serverAnalysisResponseSchema`, and response union types. |
| `tests/shared/server-analysis-contract.test.ts` | Modify | Verifies ready response schema, response union parsing, invalid block rejection, and non-finite timeline rejection. |
| `src/backend/cache-fixtures.ts` | Create | Holds the in-memory seeded cache entry for `e2eFixture1` and lookup logic by video/version. |
| `src/backend/analysis-api.ts` | Modify | Returns `200 ready` for matching fixture cache entries before falling back to `202 processing`. |
| `tests/backend/analysis-api.test.ts` | Modify | Covers cached ready response and uncached processing response. |
| `tests/backend/server.test.ts` | Modify | Verifies the HTTP server returns status `200` and the ready JSON body for the seeded video. |
| `src/background/server-analysis-client.ts` | Modify | Parses the server analysis response union instead of only `processing`. |
| `tests/background/server-analysis-client.test.ts` | Modify | Covers ready response parsing and keeps timeout/non-transcript request assertions. |
| `src/shared/messages.ts` | Modify | Extends `RequestServerAnalysisResponse` success status to include `'ready'`. |
| `src/background/messaging/server-analysis-runtime-messages.ts` | Modify | Sends ready blocks to the originating tab, updates `PromoDetectionStore` as `server_cache`, and rejects mismatched response video IDs. |
| `tests/background/messaging/server-analysis-runtime-messages.test.ts` | Modify | Verifies ready delivery, store parity, and mismatch non-delivery. |
| `src/popup/PopupApp.tsx` | Modify | Adds source-specific detected copy for `source: 'server_cache'` before Chrome provider availability branches. |
| `tests/popup/popup-view-model.test.ts` | Modify | Verifies server-cache ready copy, block summary, and precedence over Chrome provider setup/unavailable branches. |
| `src/_locales/*/messages.json` | Modify | Adds server-cache ready popup strings to every locale, using English fallback where translations are unavailable. |
| `e2e/extension.spec.ts` | Modify | Adds a deterministic fixture test proving a server ready response activates a skip at the seeded block start. |

## Tasks

### [x] Task 1: Add Ready Response Contract Schemas

**Files:**

- Modify: `src/shared/server-analysis-contract.ts`
- Modify: `tests/shared/server-analysis-contract.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import {
    readyResponseSchema,
    serverAnalysisResponseSchema,
} from '@/shared/server-analysis-contract';

it('accepts a ready server cache response with promo blocks', () => {
    const parsed = v.parse(readyResponseSchema, {
        status: 'ready',
        videoId: 'e2eFixture1',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        source: 'server_cache',
        promoBlocks: [{ startSec: 4, endSec: 24, confidence: 'high' }],
    });

    expect(parsed.status).toBe('ready');
    expect(parsed.promoBlocks).toEqual([
        { startSec: 4, endSec: 24, confidence: 'high' },
    ]);
});

it('parses processing and ready responses through one union schema', () => {
    expect(
        v.parse(serverAnalysisResponseSchema, {
            status: 'processing',
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            jobId: 'local-dQw4w9WgXcQ-server-v1',
            pollAfterSec: 3,
        }).status,
    ).toBe('processing');

    expect(
        v.parse(serverAnalysisResponseSchema, {
            status: 'ready',
            videoId: 'e2eFixture1',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            source: 'server_cache',
            promoBlocks: [{ startSec: 4, endSec: 24 }],
        }).status,
    ).toBe('ready');
});

it('rejects invalid ready promo blocks', () => {
    expect(
        v.safeParse(readyResponseSchema, {
            status: 'ready',
            videoId: 'e2eFixture1',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            source: 'server_cache',
            promoBlocks: [{ startSec: 24, endSec: 4 }],
        }).success,
    ).toBe(false);
});

it('rejects non-finite ready promo block timeline values', () => {
    for (const promoBlocks of [
        [{ startSec: Number.POSITIVE_INFINITY, endSec: 24 }],
        [{ startSec: Number.NaN, endSec: 24 }],
        [{ startSec: 4, endSec: Number.POSITIVE_INFINITY }],
        [{ startSec: 4, endSec: Number.NaN }],
    ]) {
        expect(
            v.safeParse(readyResponseSchema, {
                status: 'ready',
                videoId: 'e2eFixture1',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                source: 'server_cache',
                promoBlocks,
            }).success,
        ).toBe(false);
    }
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/shared/server-analysis-contract.test.ts`

Expected: FAIL with TypeScript errors that `readyResponseSchema` and `serverAnalysisResponseSchema` are not exported; after the exports exist but before finite checks are added, the non-finite timeline test must still fail because plain `v.number()` does not reject `Infinity`.

- [x] **Step 3: Write minimal implementation**

```ts
const promoConfidenceSchema = v.picklist(['low', 'medium', 'high'] as const);

const finiteTimelineSecSchema = v.pipe(
    v.number(),
    v.check(
        (value) => Number.isFinite(value),
        'Promo block timeline values must be finite.',
    ),
    v.minValue(0),
);

/**
 * Validates cached promo block timings returned by the backend.
 */
export const promoBlockSchema = v.pipe(
    v.strictObject({
        startSec: finiteTimelineSecSchema,
        endSec: v.optional(finiteTimelineSecSchema),
        confidence: v.optional(promoConfidenceSchema),
    }),
    v.check(
        (block) => block.endSec === undefined || block.endSec > block.startSec,
        'Promo block endSec must be greater than startSec.',
    ),
);

/**
 * Validates ready cache-hit responses from the local backend.
 */
export const readyResponseSchema = v.strictObject({
    status: v.literal('ready'),
    videoId: youtubeVideoIdSchema,
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    source: v.literal('server_cache'),
    promoBlocks: v.pipe(v.array(promoBlockSchema), v.minLength(1)),
});

/**
 * Validates every successful analysis response consumed by the extension.
 */
export const serverAnalysisResponseSchema = v.union([
    processingResponseSchema,
    readyResponseSchema,
]);

/**
 * Ready cache-hit response with normalized promo blocks.
 */
export type ReadyResponse = v.InferOutput<typeof readyResponseSchema>;

/**
 * Successful server analysis response consumed by background messaging.
 */
export type ServerAnalysisResponse = v.InferOutput<
    typeof serverAnalysisResponseSchema
>;
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/shared/server-analysis-contract.test.ts`

Expected: PASS.

**Verification**: The shared schema accepts both existing `processing` and new `ready` responses and rejects invalid ordering plus non-finite `startSec`/`endSec` before any background delivery or content seek logic.

### [x] Task 2: Return Ready From Backend Fixture Cache

**Files:**

- Create: `src/backend/cache-fixtures.ts`
- Modify: `src/backend/analysis-api.ts`
- Modify: `tests/backend/analysis-api.test.ts`
- Modify: `tests/backend/server.test.ts`

- [x] **Step 1: Write the failing tests**

Add this case to `tests/backend/analysis-api.test.ts`:

```ts
it('returns ready promo blocks for a seeded cache hit', () => {
    const response = BackendAnalysisApi.handleAnalysisRequest({
        videoId: 'e2eFixture1',
        extensionVersion: '0.1.0',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        client: {
            source: 'chrome-extension',
            capabilities: ['processing-status'],
        },
    });

    expect(response).toEqual({
        statusCode: 200,
        body: {
            status: 'ready',
            videoId: 'e2eFixture1',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            source: 'server_cache',
            promoBlocks: [{ startSec: 4, endSec: 24, confidence: 'high' }],
        },
    });
});
```

Add this case to `tests/backend/server.test.ts`:

```ts
it('responds with HTTP 200 for a seeded ready cache hit', async () => {
    const server = BackendHttpServer.create();
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
    });
    try {
        const address = server.address();
        if (address === null || typeof address === 'string') {
            throw new Error('Expected TCP address.');
        }

        const response = await fetch(
            `http://127.0.0.1:${address.port}/v1/analysis`,
            {
                method: 'POST',
                headers: { 'content-type': MIME_APPLICATION_JSON },
                body: JSON.stringify({
                    videoId: 'e2eFixture1',
                    extensionVersion: '0.1.0',
                    algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                    client: {
                        source: 'chrome-extension',
                        capabilities: ['processing-status'],
                    },
                }),
            },
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            status: 'ready',
            videoId: 'e2eFixture1',
            source: 'server_cache',
            promoBlocks: [{ startSec: 4, endSec: 24, confidence: 'high' }],
        });
    } finally {
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
    }
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/backend/analysis-api.test.ts tests/backend/server.test.ts`

Expected: FAIL because valid requests still return `202 processing`.

- [x] **Step 3: Write minimal implementation**

Create `src/backend/cache-fixtures.ts`:

```ts
import * as v from 'valibot';

import {
    SERVER_ANALYSIS_ALGORITHM_VERSION,
    readyResponseSchema,
    type ReadyResponse,
} from '@/shared/server-analysis-contract';

/**
 * Valid YouTube-shaped id used by the Playwright watch fixture.
 */
export const SEEDED_SERVER_CACHE_VIDEO_ID = 'e2eFixture1';

const SEEDED_READY_RESPONSE = v.parse(readyResponseSchema, {
    status: 'ready',
    videoId: SEEDED_SERVER_CACHE_VIDEO_ID,
    algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
    source: 'server_cache',
    promoBlocks: [{ startSec: 4, endSec: 24, confidence: 'high' }],
});

/**
 * In-memory server cache fixture for the local tracer bullet; static API only.
 */
export class BackendCacheFixtures {
    /**
     * Returns a ready cache response when the fixture key matches exactly.
     *
     * @param input - Validated request cache key.
     * @returns Ready response for the seeded video, otherwise `null`.
     */
    static findReady(input: {
        videoId: string;
        algorithmVersion: string;
    }): ReadyResponse | null {
        if (
            input.videoId !== SEEDED_SERVER_CACHE_VIDEO_ID ||
            input.algorithmVersion !== SERVER_ANALYSIS_ALGORITHM_VERSION
        ) {
            return null;
        }
        return SEEDED_READY_RESPONSE;
    }
}
```

Modify `src/backend/analysis-api.ts`:

```ts
import { BackendCacheFixtures } from '@/backend/cache-fixtures';
import type { ReadyResponse } from '@/shared/server-analysis-contract';

type BackendApiResult =
    | { statusCode: 200; body: ReadyResponse }
    | { statusCode: 202; body: ProcessingResponse }
    | { statusCode: 400; body: ErrorResponse };

const ready = BackendCacheFixtures.findReady({
    videoId: parsed.output.videoId,
    algorithmVersion: parsed.output.algorithmVersion,
});
if (ready !== null) {
    return { statusCode: 200, body: ready };
}
```

Place the `ready` lookup after `serverAnalysisRequestSchema` succeeds and before the existing `202 processing` return.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/backend/analysis-api.test.ts tests/backend/server.test.ts`

Expected: PASS.

**Verification**: The backend returns a ready cache hit without entering the processing/job response path, while uncached valid videos still return `202 processing`.

### [x] Task 3: Parse Ready Responses In The Background Client

**Files:**

- Modify: `src/background/server-analysis-client.ts`
- Modify: `tests/background/server-analysis-client.test.ts`

- [x] **Step 1: Write the failing test**

```ts
it('parses ready cache-hit responses from the local backend', async () => {
    fetchMock.mockResolvedValue(
        new Response(
            JSON.stringify({
                status: 'ready',
                videoId: 'e2eFixture1',
                algorithmVersion: 'server-v1',
                source: 'server_cache',
                promoBlocks: [{ startSec: 4, endSec: 24, confidence: 'high' }],
            }),
            {
                status: 200,
                headers: { 'content-type': MIME_APPLICATION_JSON },
            },
        ),
    );

    const response = await ServerAnalysisClient.requestAnalysis({
        videoId: 'e2eFixture1',
        durationSec: 120,
        extensionVersion: '0.1.0',
    });

    expect(response).toEqual({
        status: 'ready',
        videoId: 'e2eFixture1',
        algorithmVersion: 'server-v1',
        source: 'server_cache',
        promoBlocks: [{ startSec: 4, endSec: 24, confidence: 'high' }],
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/background/server-analysis-client.test.ts`

Expected: FAIL because `requestAnalysis` does not exist or the client still parses only `processingResponseSchema`.

- [x] **Step 3: Write minimal implementation**

```ts
import {
    TOPSKIP_LOCAL_BACKEND_BASE_URL,
    buildServerAnalysisRequest,
    serverAnalysisResponseSchema,
    type ServerAnalysisResponse,
} from '@/shared/server-analysis-contract';

/**
 * Requests the current server analysis state for a video.
 *
 * @param input - Current video metadata and extension version.
 * @returns Validated server analysis response from the local backend.
 */
static async requestAnalysis(input: {
    videoId: string;
    durationSec?: number;
    extensionVersion: string;
}): Promise<ServerAnalysisResponse> {
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
            throw new Error(`Server analysis failed with HTTP ${res.status}`);
        }
        return v.parse(serverAnalysisResponseSchema, json);
    } catch (error) {
        if (controller.signal.aborted) {
            throw new Error('Server analysis timed out.');
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}
```

Update existing tests and call sites from `requestProcessing` to `requestAnalysis`.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/background/server-analysis-client.test.ts`

Expected: PASS.

**Verification**: The client still sends metadata-only JSON, still times out hung requests, and now validates both successful response statuses consumed by the background.

### [x] Task 4: Deliver Ready Blocks Through Existing Runtime Message Path

**Files:**

- Modify: `src/shared/messages.ts`
- Modify: `src/background/messaging/server-analysis-runtime-messages.ts`
- Modify: `tests/background/messaging/server-analysis-runtime-messages.test.ts`

- [x] **Step 1: Write the failing tests**

Update the client mock to expose `requestAnalysis`, add
`import type { PromoBlock } from '@/shared/promo-types';`, then add:

```ts
it('sends ready server cache blocks to content and popup state', async () => {
    const blocks: PromoBlock[] = [
        { startSec: 4, endSec: 24, confidence: 'high' },
    ];
    clientMocks.requestAnalysis.mockResolvedValueOnce({
        status: 'ready',
        videoId: 'e2eFixture1',
        algorithmVersion: 'server-v1',
        source: 'server_cache',
        promoBlocks: blocks,
    });

    const result = await ServerAnalysisRuntimeMessages.handleRequest(
        { videoId: 'e2eFixture1', durationSec: 120 },
        { tab: { id: 42 } } as never,
    );

    expect(result).toEqual({ ok: true, status: 'ready' });
    expect(browserMocks.tabsSendMessage).toHaveBeenCalledWith(42, {
        type: TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED,
        videoId: 'e2eFixture1',
        promoBlocks: blocks,
    });
    expect(detectionMocks.set).toHaveBeenCalledWith(42, {
        videoId: 'e2eFixture1',
        status: 'detected',
        source: 'server_cache',
        promoBlocks: blocks,
    });
});

it('does not deliver ready blocks when the backend video id differs', async () => {
    clientMocks.requestAnalysis.mockResolvedValueOnce({
        status: 'ready',
        videoId: 'dQw4w9WgXcQ',
        algorithmVersion: 'server-v1',
        source: 'server_cache',
        promoBlocks: [{ startSec: 4, endSec: 24 }],
    });

    const result = await ServerAnalysisRuntimeMessages.handleRequest(
        { videoId: 'e2eFixture1', durationSec: 120 },
        { tab: { id: 42 } } as never,
    );

    expect(result).toEqual({
        ok: false,
        error: 'Server returned analysis for a different video.',
    });
    expect(browserMocks.tabsSendMessage).not.toHaveBeenCalled();
    expect(detectionMocks.set).toHaveBeenCalledWith(42, {
        videoId: 'e2eFixture1',
        status: 'error',
        source: 'server',
        error: 'Server returned analysis for a different video.',
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/background/messaging/server-analysis-runtime-messages.test.ts`

Expected: FAIL because the handler still calls `requestProcessing`, never sends `PROMO_BLOCKS_DETECTED`, and cannot return `status: 'ready'`.

- [x] **Step 3: Write minimal implementation**

In `src/shared/messages.ts`:

```ts
export type RequestServerAnalysisResponse =
    | { ok: true; status: 'processing' | 'ready' }
    | { ok: false; error: string };
```

In `src/background/messaging/server-analysis-runtime-messages.ts`:

```ts
const response = await ServerAnalysisClient.requestAnalysis({
    videoId: payload.videoId,
    durationSec: payload.durationSec,
    extensionVersion: browser.runtime.getManifest().version,
});

if (response.videoId !== payload.videoId) {
    const error = 'Server returned analysis for a different video.';
    PromoDetectionStore.set(tabId, {
        videoId: payload.videoId,
        status: 'error',
        source: 'server',
        error,
    });
    return { ok: false, error };
}

if (response.status === 'ready') {
    const message = {
        type: TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED,
        videoId: response.videoId,
        promoBlocks: response.promoBlocks,
    } satisfies TopSkipRuntimeMessage;

    try {
        await browser.tabs.sendMessage(tabId, message);
    } catch {
        // The tab may have navigated away after requesting analysis.
    }

    PromoDetectionStore.set(tabId, {
        videoId: response.videoId,
        status: 'detected',
        source: 'server_cache',
        promoBlocks: response.promoBlocks,
    });
    return { ok: true, status: 'ready' };
}

PromoDetectionStore.set(tabId, {
    videoId: payload.videoId,
    status: 'analyzing',
    source: 'server',
});
return { ok: true, status: 'processing' };
```

Add `TOPSKIP_MESSAGE` and `type TopSkipRuntimeMessage` imports from `@/shared/messages`. Update the mocked `@/shared/browser` in the test to include `tabs: { sendMessage: tabsSendMessage }`.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/background/messaging/server-analysis-runtime-messages.test.ts`

Expected: PASS.

**Verification**: Ready blocks are delivered through the same content message as local provider detections, popup state stores the same blocks with `source: 'server_cache'`, and mismatched backend video IDs cannot activate skips.

### [x] Task 5: Show Server Cache Ready State In Popup

**Files:**

- Modify: `src/popup/PopupApp.tsx`
- Modify: `tests/popup/popup-view-model.test.ts`
- Modify: `src/_locales/*/messages.json`

- [x] **Step 1: Write the failing test**

Add the new locale keys to the popup test mock, then add:

```ts
it.each(['downloading', 'unavailable', 'downloadable'] as const)(
    'server cache detected state takes precedence over Chrome %s state',
    (chromeModelAvailability) => {
        const vm = buildPopupViewModel({
            ...baseArgs,
            providerId: 'chrome-prompt-api',
            providerDisplayName: 'Chrome Built-in',
            modelDisplayName: 'Gemini Nano',
            chromeModelAvailability,
            detectionState: {
                videoId: 'e2eFixture1',
                status: 'detected',
                source: 'server_cache',
                promoBlocks: [{ startSec: 4, endSec: 24 }],
            },
        });

        expect(vm.badgeLabel).toBe('Server cache');
        expect(vm.title).toBe('Server-detected blocks ready');
        expect(vm.statusHeadline).toBe('Server cache hit.');
        expect(vm.statusBody).toBe('0:04–0:24');
    },
);
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/popup/popup-view-model.test.ts`

Expected: FAIL because `buildPopupViewModel` returns Chrome downloading/unavailable/download-required copy before it reaches the generic detected-state switch.

- [x] **Step 3: Write minimal implementation**

Add these keys to every `src/_locales/*/messages.json` file:

```json
"popup_detection_server_cache_badge": {
    "message": "Server cache",
    "description": "Popup status badge shown when promo blocks came from the TopSkip backend cache."
},
"popup_detection_server_cache_title": {
    "message": "Server-detected blocks ready",
    "description": "Popup title shown when the TopSkip backend returns cached promo blocks."
},
"popup_detection_server_cache_description": {
    "message": "TopSkip received cached promo blocks from the local backend.",
    "description": "Popup description shown for a server cache-hit response."
},
"popup_detection_server_cache_headline": {
    "message": "Server cache hit.",
    "description": "Popup headline shown when a server cache hit is ready."
}
```

Add this branch immediately after the existing server `analyzing` and server `error` branches, and before the Chrome Prompt API availability branch in `buildPopupViewModel`:

```ts
if (
    detectionState.status === 'detected' &&
    detectionState.source === 'server_cache'
) {
    return {
        tone: 'brand',
        badgeLabel: translator.getMessage(
            'popup_detection_server_cache_badge',
        ),
        badgeColor: 'brand',
        title: translator.getMessage('popup_detection_server_cache_title'),
        description: translator.getMessage(
            'popup_detection_server_cache_description',
        ),
        activityLabel: ACTIVITY_LABEL_ACTIVE,
        statusHeadline: translator.getMessage(
            'popup_detection_server_cache_headline',
        ),
        statusBody:
            detectionState.promoBlocks !== undefined &&
            detectionState.promoBlocks.length > 0
                ? formatPromoBlocksSummary(detectionState.promoBlocks)
                : null,
        settingsLabel: translator.getMessage('popup_open_settings'),
        providerLabel,
    };
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/popup/popup-view-model.test.ts`

Expected: PASS.

**Verification**: The popup distinguishes server cache hits from local provider detections, preserves the existing detected block list and timeline rendering, and server-cache ready state wins over Chrome provider availability setup/downloading/unavailable branches.

### [x] Task 6: Prove Server Ready Blocks Trigger A Fixture Skip

**Files:**

- Modify: `e2e/extension.spec.ts`

- [x] **Step 1: Write the failing test**

```ts
test('server cache hit applies promo blocks and skips fixture playback', async () => {
    let resolveRequestSeen: () => void = () => {};
    const requestSeen = new Promise<void>((resolve) => {
        resolveRequestSeen = resolve;
    });
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
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
                JSON.stringify({
                    status: 'ready',
                    videoId: 'e2eFixture1',
                    algorithmVersion: 'server-v1',
                    source: 'server_cache',
                    promoBlocks: [
                        { startSec: 4, endSec: 24, confidence: 'high' },
                    ],
                }),
            );
            resolveRequestSeen();
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
        const warmupPopup = await openPopupAndWaitForUi(
            context,
            extensionId,
            errors,
        );
        await warmupPopup.close();

        const page = await context.newPage();
        trackPageErrors(page, 'fixture-ready', errors);
        await page.goto('/video.html', { waitUntil: 'domcontentloaded' });
        await Promise.race([
            requestSeen,
            new Promise<never>((_resolve, reject) => {
                setTimeout(
                    () =>
                        reject(
                            new Error(
                                'Timed out waiting for server ready request.',
                            ),
                        ),
                    15_000,
                );
            }),
        ]);

        await page.evaluate(async () => {
            const video = document.querySelector('video');
            if (!(video instanceof HTMLVideoElement)) {
                throw new Error('Missing fixture video.');
            }
            await new Promise<void>((resolve, reject) => {
                if (video.readyState >= 1) {
                    resolve();
                    return;
                }
                video.addEventListener('loadedmetadata', () => resolve(), {
                    once: true,
                });
                video.addEventListener(
                    'error',
                    () => reject(new Error('video error')),
                    { once: true },
                );
            });
            video.muted = true;
            video.playbackRate = 1;
            void video.play();
        });

        await expect
            .poll(
                async () =>
                    page.evaluate(() => {
                        const video = document.querySelector(
                            'video',
                        ) as HTMLVideoElement;
                        return video.currentTime;
                    }),
                { timeout: 12_000 },
            )
            .toBeGreaterThan(23);

        const popupPage = await openPopupAndWaitForUi(
            context,
            extensionId,
            errors,
        );
        await expect(
            popupPage.getByText('Server-detected blocks ready'),
        ).toBeVisible({ timeout: 10_000 });
        await popupPage.close();

        expectNoCollectedErrors(errors);
    } finally {
        await context.close();
        await new Promise<void>((resolve) => {
            backend.close(() => resolve());
        });
    }
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run build && pnpm run test:e2e -- e2e/extension.spec.ts`

Expected: FAIL because the background does not yet forward ready server blocks and the popup does not yet render server-cache ready copy.

- [x] **Step 3: Write minimal implementation**

No additional production code should be required beyond Tasks 1-5. If this test fails after those tasks pass, inspect only the request timing and the existing content message listener in `src/content/youtube-watch.ts:491`; do not add a second content skip path.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run build && pnpm run test:e2e -- e2e/extension.spec.ts`

Expected: PASS.

**Verification**: A server `ready` response for `e2eFixture1` installs active promo blocks before playback crosses `4s`; the content script skips to `24s`, and the popup identifies the result as server-detected.

### [x] Task 7: Run Focused Regression Checks

**Files:**

- No production files beyond Tasks 1-6.

- [x] **Step 1: Run focused unit tests**

Run:

```bash
pnpm run test \
  tests/shared/server-analysis-contract.test.ts \
  tests/backend/analysis-api.test.ts \
  tests/backend/server.test.ts \
  tests/background/server-analysis-client.test.ts \
  tests/background/messaging/server-analysis-runtime-messages.test.ts \
  tests/content/promo-skip-logic.test.ts \
  tests/content/youtube-watch-skip-integration.test.ts \
  tests/popup/popup-view-model.test.ts
```

Expected: PASS.

- [x] **Step 2: Run build and e2e**

Run:

```bash
pnpm run build
pnpm run test:e2e -- e2e/extension.spec.ts
```

Expected: PASS.

- [x] **Step 3: Run lint if time permits in the implementation turn**

Run: `pnpm run lint`

Expected: PASS. If lint fails on files touched by this issue, fix those files before validation. If lint fails on unrelated existing work, report the unrelated file paths in validation rather than changing them.

**Verification**: Focused checks prove the cache-hit path, unchanged processing path, mismatch guard, popup server-cache status, and content skip behavior.

## Self-Review

- **Acceptance criterion 1** is covered by Task 2: the backend returns `200 ready` for the seeded video/version without using the processing response path.
- **Acceptance criterion 2** is covered by Task 4: the background sends `PROMO_BLOCKS_DETECTED` to the source tab only after validating the ready response and matching `videoId`.
- **Acceptance criterion 3** is covered by Task 6 plus existing `promo-skip-logic` checks: server-provided blocks enter the existing content skip pipeline and skip at the block start once.
- **Acceptance criterion 4** is covered by Task 4: mismatched ready responses set a server error state and do not call `tabs.sendMessage`.
- **User Story 7 status visibility** is covered by Task 5: the popup renders server-cache ready copy when `source === 'server_cache'`, even when Chrome Built-in provider availability would otherwise return setup/downloading/unavailable copy.
- **Type consistency**: `ReadyResponse.promoBlocks` uses the existing `PromoBlock` shape consumed by `PROMO_BLOCKS_DETECTED`, `PromoDetectionStatePayload`, popup formatting, and `YoutubeWatch`.
- **Review finding 1 addressed**: Task 5 Step 1 adds a Chrome availability precedence test, and Task 5 Step 3 places the `server_cache` detected branch before `providerId === PROVIDER_ID.ChromePromptApi` availability checks instead of only before the generic detected-state switch.
- **Review finding 2 addressed**: Task 1 Step 1 adds non-finite `startSec`/`endSec` tests, and Task 1 Step 3 introduces `finiteTimelineSecSchema` with `Number.isFinite` before server-ready promo blocks can be delivered to content seek logic.
