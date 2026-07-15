# Implementation Plan: Extension Local Result Cache

- **Created**: 2026-07-06
- **Status**: Approved
- **Issue**: `.sdd/.current/issues/3-AFK/issue.md`
- **PRD**: `.sdd/.current/prd.md`
- **Model**: GPT-5 Codex
- **User Input**: `ISSUE_ID=3-AFK`, `SPECS_DIR=.sdd/.current`, constraints: revise the plan to address review findings by adding ready-response algorithm/request guards and making cache read, repair, and write failures non-fatal to server fallback or delivery.

## Summary

Add a background-owned extension local cache for ready server analysis results.
The cache stores only validated server results, keyed by YouTube video ID plus
`SERVER_ANALYSIS_ALGORITHM_VERSION`, with backend-provided freshness metadata
and source result ID. `ServerAnalysisRuntimeMessages` must consult the cache
before calling the local backend, deliver fresh hits through the existing
`PROMO_BLOCKS_DETECTED` path with `source: 'local_cache'`, miss on stale,
corrupt, version-mismatched, or storage-failed entries, guard every ready backend
response against the current request video ID and
`SERVER_ANALYSIS_ALGORITHM_VERSION` before saving or delivering blocks, and
treat cache persistence failures as non-fatal so valid server blocks still reach
the content script.

## Technical Context

- **Language/Version**: TypeScript 6.0.2 in strict ESM mode; Node.js `>=20`.
- **Primary Dependencies**: Rspack 1.7, React 19.2, Mantine 9, MobX 6, Valibot 1.3, `webextension-polyfill`, Vitest 4, Playwright 1.59.
- **Storage**: `browser.storage.local`, accessed from the background service worker only. This issue adds a new server-result cache key and does not let content or popup read storage directly.
- **Testing**: Vitest for schema, storage, and runtime routing; Playwright for extension plus fixture-page behavior.
- **Target Platform**: Chrome Manifest V3 service worker and content script, with a local backend at `http://127.0.0.1:8787`.

## Research

### Existing Server Analysis Flow

`src/content/youtube-watch.ts:391` sends one
`REQUEST_SERVER_ANALYSIS` message per video when server mode is active.
`src/background/messaging/server-analysis-runtime-messages.ts:37` loads prefs,
calls `ServerAnalysisClient.requestAnalysis`, maps `processing` to popup
`source: 'server'`, and maps `ready` to `PROMO_BLOCKS_DETECTED` plus
`source: 'server_cache'`. `src/content/youtube-watch.ts:491` already accepts
that message, ignores mismatched video IDs, stores `promoBlocks`, and reuses the
existing promo-block skip logic. The local cache should therefore be inserted in
the background handler before `ServerAnalysisClient.requestAnalysis`, not as a
new content-script path.

### Storage Pattern To Follow

`src/background/storage/prefs-sync.ts:144` reads from
`browser.storage.local`, validates untrusted values with Valibot, repairs corrupt
data, and exposes a static-only class API. `src/shared/constants.ts:16` already
holds background-owned storage keys. The new cache should follow the same
pattern in `src/background/storage/server-result-cache.ts`, with a dedicated
`STORAGE_KEY_SERVER_RESULT_CACHE` prefix in `src/shared/constants.ts`.

### Ready Response Metadata Gap

`src/shared/server-analysis-contract.ts:96` currently validates ready responses
with `videoId`, `algorithmVersion`, `source`, and `promoBlocks`, but issue 3
requires local entries to retain freshness metadata and source result ID. The
local backend fixture in `src/backend/cache-fixtures.ts:14`, backend tests, and
e2e response fixture in `e2e/extension.spec.ts:341` must add these fields so the
extension cache stores only server-confirmed metadata.

### Freshness Policy

The server owns freshness. The extension local cache should treat an entry as
fresh only when the stored entry's `freshness.expiresAtMs` is greater than the
current time. Stale entries should be removed and reported as a miss, allowing
the normal backend request path. Corrupt entries and entries stored under the
right key but containing a different `videoId` or `algorithmVersion` should also
be removed and treated as misses.

### Revision Findings

The previous plan validated local cache entries against the algorithm version
but did not guard ready backend responses the same way before saving and
delivering blocks. The runtime handler must reject any response whose
`algorithmVersion` differs from `SERVER_ANALYSIS_ALGORITHM_VERSION` before the
ready branch can call `saveReadyResponse` or `PROMO_BLOCKS_DETECTED`.

Cache storage is an optimization, not the detection source of truth. If
`browser.storage.local.get` rejects, or if a stale/corrupt-row repair
`browser.storage.local.remove` rejects, `ServerResultCacheStorage.loadFresh`
must return `null` so `ServerAnalysisRuntimeMessages` continues to the backend
request. If `saveReadyResponse` rejects after a valid ready backend response,
the runtime handler must still deliver blocks to the tab and update popup
detection state.

### Dependency Status

Issue `2-AFK` is `Validated`, so this cache plan can depend on the existing
server-ready response path and `PROMO_BLOCKS_DETECTED` delivery behavior.

### Sub-Agent Availability

The requested explorer sub-agent is not callable in this session, so repository
exploration was performed locally with `rg`, `cat`, and targeted `nl -ba` reads.
No external research is needed because the slice is confined to local extension
code and issue-owned API contract documentation.

## Entities

### Ready Response Freshness

- **Fields**:
    - `expiresAtMs`: `number` - Unix epoch milliseconds after which the local extension cache must miss.
- **Relationships**: Nested in backend `ReadyResponse`; copied unchanged into `LocalServerResultCacheEntry`.
- **Validation**: Finite positive integer; no extra properties.
- **States**: fresh while `expiresAtMs > Date.now()`, stale once `expiresAtMs <= Date.now()`.

### Ready Response

- **Fields**:
    - `status`: `'ready'`
    - `videoId`: `string`
    - `algorithmVersion`: `string`
    - `source`: `'server_cache'`
    - `sourceResultId`: `string`
    - `freshness`: `ReadyResponseFreshness`
    - `promoBlocks`: `PromoBlock[]`
- **Relationships**: Returned by the local backend; parsed by `ServerAnalysisClient`; saved by `ServerResultCacheStorage`; delivered to content as active promo blocks.
- **Validation**: Existing promo-block timeline validation still applies; source result ID must be non-empty; freshness must be finite and positive; the runtime handler must additionally require `videoId` to equal the request video ID and `algorithmVersion` to equal `SERVER_ANALYSIS_ALGORITHM_VERSION` before save or delivery.
- **States**: `ready` is terminal for this slice.

### Local Server Result Cache Entry

- **Fields**:
    - `videoId`: `string` - YouTube ID for the stored result.
    - `algorithmVersion`: `string` - cache namespace; must match `SERVER_ANALYSIS_ALGORITHM_VERSION` when read.
    - `sourceResultId`: `string` - backend result ID for diagnostics and future invalidation.
    - `freshness`: `ReadyResponseFreshness` - server-provided expiry metadata.
    - `promoBlocks`: `PromoBlock[]` - validated blocks to deliver on a hit.
    - `storedAtMs`: `number` - local write time for debugging and deterministic tests.
- **Relationships**: Created from a `ReadyResponse`; consumed by `ServerAnalysisRuntimeMessages` before network lookup.
- **Validation**: Strict Valibot object; `videoId` and `algorithmVersion` must match the lookup input; entry expires at `freshness.expiresAtMs`; storage read and repair failures are treated as misses.
- **States**: fresh → stale → removed; corrupt → removed.

## Contracts

Contract file: `.sdd/.current/issues/3-AFK/contracts/openapi.yaml`.

No new endpoint is added. This slice extends the existing `POST /v1/analysis`
`200 ReadyResponse` contract with:

- `sourceResultId: string`
- `freshness: { expiresAtMs: integer }`

The extension must reject ready responses that omit either field, so every local
backend fixture and test response must include them.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `.sdd/.current/issues/3-AFK/contracts/openapi.yaml` | Create | Documents ready-response freshness and source-result metadata consumed by the extension cache. |
| `src/shared/server-analysis-contract.ts` | Modify | Adds `readyResponseFreshnessSchema`, `sourceResultId`, and `freshness` to `readyResponseSchema`. |
| `tests/shared/server-analysis-contract.test.ts` | Modify | Covers ready metadata acceptance and missing/non-finite freshness rejection. |
| `src/backend/cache-fixtures.ts` | Modify | Adds deterministic source result ID and far-future expiry to the seeded ready response. |
| `tests/backend/analysis-api.test.ts` | Modify | Updates seeded ready response expectations to include metadata. |
| `tests/backend/server.test.ts` | Modify | Verifies HTTP ready response includes source result ID and freshness. |
| `tests/background/server-analysis-client.test.ts` | Modify | Updates parsed ready response test to require metadata. |
| `e2e/extension.spec.ts` | Modify | Updates server-ready fixture responses and adds fresh-local-cache no-network coverage. |
| `src/shared/constants.ts` | Modify | Adds `STORAGE_KEY_SERVER_RESULT_CACHE` for background-owned cache entries. |
| `src/background/storage/server-result-cache.ts` | Create | Validates, stores, reads, expires, and repairs local server-result cache entries while treating storage read/repair failures as misses. |
| `tests/background/storage/server-result-cache.test.ts` | Create | Covers fresh hit, stale miss, corrupt repair/miss, version mismatch, storage read failure miss, repair failure miss, and ready-response save. |
| `src/background/messaging/server-analysis-runtime-messages.ts` | Modify | Checks local cache before backend request, guards backend responses against current video/version before ready delivery, saves ready server responses non-fatally, and emits local-cache hit state. |
| `tests/background/messaging/server-analysis-runtime-messages.test.ts` | Modify | Verifies no backend call on fresh hit, backend call on miss, rejection of mismatched ready response versions, and delivery despite cache write failure. |

## Tasks

### [x] Task 1: Extend Ready Responses With Cache Metadata

**Files:**

- Modify: `src/shared/server-analysis-contract.ts`
- Modify: `tests/shared/server-analysis-contract.test.ts`
- Modify: `src/backend/cache-fixtures.ts`
- Modify: `tests/backend/analysis-api.test.ts`
- Modify: `tests/backend/server.test.ts`
- Modify: `tests/background/server-analysis-client.test.ts`
- Modify: `e2e/extension.spec.ts`

- [x] **Step 1: Write the failing tests**

Update ready-response tests to require `sourceResultId` and `freshness`.

```ts
it('accepts a ready server cache response with local cache metadata', () => {
    const parsed = v.parse(readyResponseSchema, {
        status: 'ready',
        videoId: 'e2eFixture1',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        source: 'server_cache',
        sourceResultId: 'result-e2eFixture1-server-v1',
        freshness: { expiresAtMs: 4_102_444_800_000 },
        promoBlocks: [{ startSec: 4, endSec: 24, confidence: 'high' }],
    });

    expect(parsed.sourceResultId).toBe('result-e2eFixture1-server-v1');
    expect(parsed.freshness.expiresAtMs).toBe(4_102_444_800_000);
});

it('rejects ready responses without required cache metadata', () => {
    expect(
        v.safeParse(readyResponseSchema, {
            status: 'ready',
            videoId: 'e2eFixture1',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            source: 'server_cache',
            promoBlocks: [{ startSec: 4, endSec: 24 }],
        }).success,
    ).toBe(false);
});

it('rejects non-finite ready response freshness', () => {
    for (const expiresAtMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(
            v.safeParse(readyResponseSchema, {
                status: 'ready',
                videoId: 'e2eFixture1',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                source: 'server_cache',
                sourceResultId: 'result-e2eFixture1-server-v1',
                freshness: { expiresAtMs },
                promoBlocks: [{ startSec: 4, endSec: 24 }],
            }).success,
        ).toBe(false);
    }
});
```

Update every existing ready fixture in backend, client, runtime, and e2e tests
to include:

```ts
sourceResultId: 'result-e2eFixture1-server-v1',
freshness: { expiresAtMs: 4_102_444_800_000 },
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm run test \
  tests/shared/server-analysis-contract.test.ts \
  tests/backend/analysis-api.test.ts \
  tests/backend/server.test.ts \
  tests/background/server-analysis-client.test.ts \
  tests/background/messaging/server-analysis-runtime-messages.test.ts
```

Expected: FAIL because `readyResponseSchema` does not yet require
`sourceResultId` or `freshness`, and fixture expectations are missing those
fields.

- [x] **Step 3: Write minimal implementation**

In `src/shared/server-analysis-contract.ts`, add freshness validation next to the
existing ready-response schemas:

```ts
const finiteEpochMsSchema = v.pipe(
    v.number(),
    v.check((value) => Number.isFinite(value), 'Epoch milliseconds must be finite.'),
    v.integer(),
    v.minValue(1),
);

/**
 * Validates server-owned freshness metadata mirrored by the extension cache.
 */
export const readyResponseFreshnessSchema = v.strictObject({
    expiresAtMs: finiteEpochMsSchema,
});

/**
 * Validates ready cache-hit responses from the local backend.
 */
export const readyResponseSchema = v.strictObject({
    status: v.literal('ready'),
    videoId: youtubeVideoIdSchema,
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    source: v.literal('server_cache'),
    sourceResultId: v.pipe(v.string(), v.minLength(1)),
    freshness: readyResponseFreshnessSchema,
    promoBlocks: v.pipe(v.array(promoBlockSchema), v.minLength(1)),
});

/**
 * Freshness metadata returned by the backend for local cache reuse.
 */
export type ReadyResponseFreshness = v.InferOutput<
    typeof readyResponseFreshnessSchema
>;
```

In `src/backend/cache-fixtures.ts`, add deterministic fixture constants and
include them in `SEEDED_READY_RESPONSE`:

```ts
const SEEDED_READY_RESPONSE_EXPIRES_AT_MS = 4_102_444_800_000;
const SEEDED_READY_SOURCE_RESULT_ID = 'result-e2eFixture1-server-v1';

const SEEDED_READY_RESPONSE = v.parse(readyResponseSchema, {
    status: 'ready',
    videoId: SEEDED_SERVER_CACHE_VIDEO_ID,
    algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
    source: 'server_cache',
    sourceResultId: SEEDED_READY_SOURCE_RESULT_ID,
    freshness: { expiresAtMs: SEEDED_READY_RESPONSE_EXPIRES_AT_MS },
    promoBlocks: [{ startSec: 4, endSec: 24, confidence: 'high' }],
});
```

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm run test \
  tests/shared/server-analysis-contract.test.ts \
  tests/backend/analysis-api.test.ts \
  tests/backend/server.test.ts \
  tests/background/server-analysis-client.test.ts \
  tests/background/messaging/server-analysis-runtime-messages.test.ts
```

Expected: PASS.

**Verification**: The contract now exposes the metadata required to persist
extension cache entries, and all ready-response fixtures are aligned before
cache storage code is added.

### [x] Task 2: Add Background Local Result Cache Storage

**Files:**

- Modify: `src/shared/constants.ts`
- Create: `src/background/storage/server-result-cache.ts`
- Create: `tests/background/storage/server-result-cache.test.ts`

- [x] **Step 1: Write the failing test**

Create `tests/background/storage/server-result-cache.test.ts` with a mocked
`browser.storage.local` and deterministic time.

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';

const storageGet = vi.fn();
const storageSet = vi.fn();
const storageRemove = vi.fn();

vi.mock('@/shared/browser', () => ({
    default: {
        storage: {
            local: {
                get: storageGet,
                set: storageSet,
                remove: storageRemove,
            },
        },
    },
}));

const { SERVER_ANALYSIS_ALGORITHM_VERSION } = await import(
    '@/shared/server-analysis-contract'
);
const { STORAGE_KEY_SERVER_RESULT_CACHE } = await import('@/shared/constants');
const { ServerResultCacheStorage } = await import(
    '@/background/storage/server-result-cache'
);

const NOW_MS = 1_900_000_000_000;
const EXPIRES_AT_MS = NOW_MS + 60_000;
const CACHE_KEY =
    `${STORAGE_KEY_SERVER_RESULT_CACHE}:${SERVER_ANALYSIS_ALGORITHM_VERSION}:e2eFixture1`;

describe('ServerResultCacheStorage', () => {
    beforeEach(() => {
        storageGet.mockReset();
        storageSet.mockReset();
        storageRemove.mockReset();
    });

    it('returns a fresh cache entry for the current video and algorithm', async () => {
        storageGet.mockResolvedValue({
            [CACHE_KEY]: {
                videoId: 'e2eFixture1',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                sourceResultId: 'result-e2eFixture1-server-v1',
                freshness: { expiresAtMs: EXPIRES_AT_MS },
                promoBlocks: [{ startSec: 4, endSec: 24, confidence: 'high' }],
                storedAtMs: NOW_MS - 1_000,
            },
        });

        const hit = await ServerResultCacheStorage.loadFresh({
            videoId: 'e2eFixture1',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: NOW_MS,
        });

        expect(hit?.sourceResultId).toBe('result-e2eFixture1-server-v1');
        expect(hit?.promoBlocks).toEqual([
            { startSec: 4, endSec: 24, confidence: 'high' },
        ]);
        expect(storageRemove).not.toHaveBeenCalled();
    });

    it('removes stale entries and returns a miss', async () => {
        storageGet.mockResolvedValue({
            [CACHE_KEY]: {
                videoId: 'e2eFixture1',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                sourceResultId: 'result-e2eFixture1-server-v1',
                freshness: { expiresAtMs: NOW_MS },
                promoBlocks: [{ startSec: 4, endSec: 24 }],
                storedAtMs: NOW_MS - 120_000,
            },
        });

        await expect(
            ServerResultCacheStorage.loadFresh({
                videoId: 'e2eFixture1',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                nowMs: NOW_MS,
            }),
        ).resolves.toBeNull();
        expect(storageRemove).toHaveBeenCalledWith(CACHE_KEY);
    });

    it('removes corrupt entries and returns a miss', async () => {
        storageGet.mockResolvedValue({
            [CACHE_KEY]: { videoId: 'e2eFixture1', promoBlocks: 'bad' },
        });

        await expect(
            ServerResultCacheStorage.loadFresh({
                videoId: 'e2eFixture1',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                nowMs: NOW_MS,
            }),
        ).resolves.toBeNull();
        expect(storageRemove).toHaveBeenCalledWith(CACHE_KEY);
    });

    it('treats storage read failures as cache misses', async () => {
        storageGet.mockRejectedValueOnce(new Error('storage unavailable'));

        await expect(
            ServerResultCacheStorage.loadFresh({
                videoId: 'e2eFixture1',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                nowMs: NOW_MS,
            }),
        ).resolves.toBeNull();
        expect(storageRemove).not.toHaveBeenCalled();
    });

    it('treats corrupt-entry repair failures as cache misses', async () => {
        storageGet.mockResolvedValue({
            [CACHE_KEY]: { videoId: 'e2eFixture1', promoBlocks: 'bad' },
        });
        storageRemove.mockRejectedValueOnce(new Error('remove failed'));

        await expect(
            ServerResultCacheStorage.loadFresh({
                videoId: 'e2eFixture1',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                nowMs: NOW_MS,
            }),
        ).resolves.toBeNull();
        expect(storageRemove).toHaveBeenCalledWith(CACHE_KEY);
    });

    it('stores a validated ready response for future use', async () => {
        await ServerResultCacheStorage.saveReadyResponse(
            {
                status: 'ready',
                videoId: 'e2eFixture1',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                source: 'server_cache',
                sourceResultId: 'result-e2eFixture1-server-v1',
                freshness: { expiresAtMs: EXPIRES_AT_MS },
                promoBlocks: [{ startSec: 4, endSec: 24, confidence: 'high' }],
            },
            NOW_MS,
        );

        expect(storageSet).toHaveBeenCalledWith({
            [CACHE_KEY]: {
                videoId: 'e2eFixture1',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                sourceResultId: 'result-e2eFixture1-server-v1',
                freshness: { expiresAtMs: EXPIRES_AT_MS },
                promoBlocks: [{ startSec: 4, endSec: 24, confidence: 'high' }],
                storedAtMs: NOW_MS,
            },
        });
    });
});
```

Add one separate version-mismatch case by returning an entry with
`algorithmVersion: 'server-v0'` under `CACHE_KEY`; expected result is `null` and
`storageRemove(CACHE_KEY)`. Keep the read-failure and repair-failure tests in
this storage suite so `loadFresh` itself proves those failures are normalized to
misses before the runtime handler decides whether to call the backend.

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm run test tests/background/storage/server-result-cache.test.ts
```

Expected: FAIL because `STORAGE_KEY_SERVER_RESULT_CACHE` and
`ServerResultCacheStorage` do not exist.

- [x] **Step 3: Write minimal implementation**

Add the storage key to `src/shared/constants.ts`:

```ts
/**
 * Prefix for background-owned local copies of ready server results.
 */
export const STORAGE_KEY_SERVER_RESULT_CACHE = 'topskip:server-result-cache';
```

Create `src/background/storage/server-result-cache.ts`:

```ts
import * as v from 'valibot';

import browser from '@/shared/browser';
import { STORAGE_KEY_SERVER_RESULT_CACHE } from '@/shared/constants';
import {
    readyResponseSchema,
    promoBlockSchema,
    youtubeVideoIdSchema,
    type ReadyResponse,
} from '@/shared/server-analysis-contract';

const finiteEpochMsSchema = v.pipe(
    v.number(),
    v.check((value) => Number.isFinite(value), 'Epoch milliseconds must be finite.'),
    v.integer(),
    v.minValue(1),
);

/**
 * Validates one stored local cache row before any skip path can use it.
 */
export const serverResultCacheEntrySchema = v.strictObject({
    videoId: youtubeVideoIdSchema,
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    sourceResultId: v.pipe(v.string(), v.minLength(1)),
    freshness: v.strictObject({
        expiresAtMs: finiteEpochMsSchema,
    }),
    promoBlocks: v.pipe(v.array(promoBlockSchema), v.minLength(1)),
    storedAtMs: finiteEpochMsSchema,
});

/**
 * Local copy of a ready server result.
 */
export type ServerResultCacheEntry = v.InferOutput<
    typeof serverResultCacheEntrySchema
>;

/**
 * Background-owned local result cache; static API only.
 */
export class ServerResultCacheStorage {
    /**
     * Builds the storage key for one video/version cache row.
     *
     * @param input - Cache namespace and video id.
     * @returns Stable `browser.storage.local` key.
     */
    private static keyFor(input: {
        videoId: string;
        algorithmVersion: string;
    }): string {
        return `${STORAGE_KEY_SERVER_RESULT_CACHE}:${input.algorithmVersion}:${input.videoId}`;
    }

    /**
     * Best-effort repair keeps cache corruption from blocking server fallback.
     *
     * @param key - Storage row to remove.
     * @returns Promise resolved after the repair attempt is complete.
     */
    private static async removeInvalidEntry(key: string): Promise<void> {
        try {
            await browser.storage.local.remove(key);
        } catch {
            // Cache repair is opportunistic; the backend path remains authoritative.
        }
    }

    /**
     * Reads a fresh cache row or repairs stale/corrupt data as a miss.
     *
     * @param input - Cache lookup key and optional test clock.
     * @returns Fresh cache entry, otherwise `null`.
     */
    static async loadFresh(input: {
        videoId: string;
        algorithmVersion: string;
        nowMs?: number;
    }): Promise<ServerResultCacheEntry | null> {
        const key = ServerResultCacheStorage.keyFor(input);
        let result: Record<string, unknown>;
        try {
            result = await browser.storage.local.get(key);
        } catch {
            return null;
        }

        const raw = result[key];
        if (raw === undefined) {
            return null;
        }

        const parsed = v.safeParse(serverResultCacheEntrySchema, raw);
        if (!parsed.success || !parsed.typed) {
            await ServerResultCacheStorage.removeInvalidEntry(key);
            return null;
        }

        const entry = parsed.output;
        const nowMs = input.nowMs ?? Date.now();
        if (
            entry.videoId !== input.videoId ||
            entry.algorithmVersion !== input.algorithmVersion ||
            entry.freshness.expiresAtMs <= nowMs
        ) {
            await ServerResultCacheStorage.removeInvalidEntry(key);
            return null;
        }

        return entry;
    }

    /**
     * Persists a validated ready server response for future server-mode starts.
     *
     * @param response - Ready response accepted from the backend.
     * @param nowMs - Local write time, injectable for tests.
     * @returns Promise resolved after the row is written.
     */
    static async saveReadyResponse(
        response: ReadyResponse,
        nowMs = Date.now(),
    ): Promise<void> {
        const ready = v.parse(readyResponseSchema, response);
        const entry = v.parse(serverResultCacheEntrySchema, {
            videoId: ready.videoId,
            algorithmVersion: ready.algorithmVersion,
            sourceResultId: ready.sourceResultId,
            freshness: ready.freshness,
            promoBlocks: ready.promoBlocks,
            storedAtMs: nowMs,
        });
        await browser.storage.local.set({
            [ServerResultCacheStorage.keyFor(entry)]: entry,
        });
    }
}
```

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm run test tests/background/storage/server-result-cache.test.ts
```

Expected: PASS.

**Verification**: Storage reads are background-only, all untrusted entries are
validated before use, stale/corrupt/version-mismatched entries miss, storage
read and repair failures also miss, and ready server responses can be saved
deterministically.

### [x] Task 3: Use Cache Before Backend Requests And Save Ready Results

**Files:**

- Modify: `src/background/messaging/server-analysis-runtime-messages.ts`
- Modify: `tests/background/messaging/server-analysis-runtime-messages.test.ts`

- [x] **Step 1: Write the failing tests**

Mock `ServerResultCacheStorage` in
`tests/background/messaging/server-analysis-runtime-messages.test.ts`:

```ts
const cacheMocks = vi.hoisted(() => ({
    loadFresh: vi.fn().mockResolvedValue(null),
    saveReadyResponse: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/background/storage/server-result-cache', () => ({
    ServerResultCacheStorage: cacheMocks,
}));
```

Add a no-network fresh-hit test:

```ts
it('delivers a fresh local cache hit without calling the backend', async () => {
    const blocks: PromoBlock[] = [
        { startSec: 4, endSec: 24, confidence: 'high' },
    ];
    cacheMocks.loadFresh.mockResolvedValueOnce({
        videoId: 'e2eFixture1',
        algorithmVersion: 'server-v1',
        sourceResultId: 'result-e2eFixture1-server-v1',
        freshness: { expiresAtMs: 4_102_444_800_000 },
        promoBlocks: blocks,
        storedAtMs: 1_900_000_000_000,
    });

    const result = await ServerAnalysisRuntimeMessages.handleRequest(
        { videoId: 'e2eFixture1', durationSec: 120 },
        { tab: { id: 42 } } as never,
    );

    expect(result).toEqual({ ok: true, status: 'ready' });
    expect(clientMocks.requestAnalysis).not.toHaveBeenCalled();
    expect(browserMocks.tabsSendMessage).toHaveBeenCalledWith(42, {
        type: TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED,
        videoId: 'e2eFixture1',
        promoBlocks: blocks,
    });
    expect(detectionMocks.set).toHaveBeenCalledWith(42, {
        videoId: 'e2eFixture1',
        status: 'detected',
        source: 'local_cache',
        promoBlocks: blocks,
    });
});
```

Add a cache-save assertion to the existing ready server response test:

```ts
expect(cacheMocks.saveReadyResponse).toHaveBeenCalledWith({
    status: 'ready',
    videoId: 'e2eFixture1',
    algorithmVersion: 'server-v1',
    source: 'server_cache',
    sourceResultId: 'result-e2eFixture1-server-v1',
    freshness: { expiresAtMs: 4_102_444_800_000 },
    promoBlocks: blocks,
});
```

Add one miss-routing assertion:

```ts
expect(cacheMocks.loadFresh).toHaveBeenCalledWith({
    videoId: 'dQw4w9WgXcQ',
    algorithmVersion: 'server-v1',
});
expect(clientMocks.requestAnalysis).toHaveBeenCalled();
```

Add a ready-response algorithm guard test:

```ts
it('rejects ready backend results for a different algorithm version', async () => {
    clientMocks.requestAnalysis.mockResolvedValueOnce({
        status: 'ready',
        videoId: 'e2eFixture1',
        algorithmVersion: 'server-v0',
        source: 'server_cache',
        sourceResultId: 'result-e2eFixture1-server-v0',
        freshness: { expiresAtMs: 4_102_444_800_000 },
        promoBlocks: [{ startSec: 4, endSec: 24 }],
    });

    const result = await ServerAnalysisRuntimeMessages.handleRequest(
        { videoId: 'e2eFixture1', durationSec: 120 },
        { tab: { id: 42 } } as never,
    );

    expect(result).toEqual({
        ok: false,
        error: 'Server returned analysis for an unsupported algorithm version.',
    });
    expect(cacheMocks.saveReadyResponse).not.toHaveBeenCalled();
    expect(browserMocks.tabsSendMessage).not.toHaveBeenCalled();
    expect(detectionMocks.set).toHaveBeenCalledWith(42, {
        videoId: 'e2eFixture1',
        status: 'error',
        source: 'server',
        error: 'Server returned analysis for an unsupported algorithm version.',
    });
});
```

Add a non-fatal cache-write failure test:

```ts
it('delivers ready backend blocks when saving the local cache fails', async () => {
    const blocks: PromoBlock[] = [{ startSec: 4, endSec: 24 }];
    cacheMocks.saveReadyResponse.mockRejectedValueOnce(
        new Error('storage write failed'),
    );
    clientMocks.requestAnalysis.mockResolvedValueOnce({
        status: 'ready',
        videoId: 'e2eFixture1',
        algorithmVersion: 'server-v1',
        source: 'server_cache',
        sourceResultId: 'result-e2eFixture1-server-v1',
        freshness: { expiresAtMs: 4_102_444_800_000 },
        promoBlocks: blocks,
    });

    const result = await ServerAnalysisRuntimeMessages.handleRequest(
        { videoId: 'e2eFixture1', durationSec: 120 },
        { tab: { id: 42 } } as never,
    );

    expect(result).toEqual({ ok: true, status: 'ready' });
    expect(cacheMocks.saveReadyResponse).toHaveBeenCalled();
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
```

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm run test tests/background/messaging/server-analysis-runtime-messages.test.ts
```

Expected: FAIL because the runtime handler does not call
`ServerResultCacheStorage`, always calls `ServerAnalysisClient` on server-mode
requests, does not save ready responses, does not reject ready responses with a
stale `algorithmVersion`, and lets cache write failures prevent delivery.

- [x] **Step 3: Write minimal implementation**

In `src/background/messaging/server-analysis-runtime-messages.ts`, import:

```ts
import { ServerResultCacheStorage } from '@/background/storage/server-result-cache';
import { SERVER_ANALYSIS_ALGORITHM_VERSION } from '@/shared/server-analysis-contract';
import type { PromoBlock } from '@/shared/promo-types';
```

Extract the repeated ready-block delivery into a private helper:

```ts
private static async deliverDetectedBlocks(input: {
    tabId: number;
    videoId: string;
    promoBlocks: PromoBlock[];
    source: 'local_cache' | 'server_cache';
}): Promise<void> {
    const message = {
        type: TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED,
        videoId: input.videoId,
        promoBlocks: input.promoBlocks,
    } satisfies TopSkipRuntimeMessage;

    try {
        await browser.tabs.sendMessage(input.tabId, message);
    } catch {
        // The tab may have navigated away after requesting analysis.
    }

    PromoDetectionStore.set(input.tabId, {
        videoId: input.videoId,
        status: 'detected',
        source: input.source,
        promoBlocks: input.promoBlocks,
    });
}
```

Place the cache lookup after prefs confirm server mode and before
`ServerAnalysisClient.requestAnalysis`:

```ts
const cached = await ServerResultCacheStorage.loadFresh({
    videoId: payload.videoId,
    algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
});
if (cached !== null) {
    await ServerAnalysisRuntimeMessages.deliverDetectedBlocks({
        tabId,
        videoId: cached.videoId,
        promoBlocks: cached.promoBlocks,
        source: 'local_cache',
    });
    return { ok: true, status: 'ready' };
}
```

Keep the existing mismatched `videoId` guard before saving, so a backend response
for another video cannot poison the cache or activate skips. Immediately after
that guard and before the `response.status === 'ready'` branch, add a matching
algorithm-version guard:

```ts
if (response.algorithmVersion !== SERVER_ANALYSIS_ALGORITHM_VERSION) {
    const error =
        'Server returned analysis for an unsupported algorithm version.';
    PromoDetectionStore.set(tabId, {
        videoId: payload.videoId,
        status: 'error',
        source: 'server',
        error,
    });
    return { ok: false, error };
}
```

In the existing `response.status === 'ready'` branch, attempt to save before
delivery, but do not let a cache write failure block valid blocks from the
current request:

```ts
try {
    await ServerResultCacheStorage.saveReadyResponse(response);
} catch {
    // Local cache persistence must never block delivery of a valid server result.
}

await ServerAnalysisRuntimeMessages.deliverDetectedBlocks({
    tabId,
    videoId: response.videoId,
    promoBlocks: response.promoBlocks,
    source: 'server_cache',
});
return { ok: true, status: 'ready' };
```

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm run test tests/background/messaging/server-analysis-runtime-messages.test.ts
```

Expected: PASS.

**Verification**: Fresh cache hits do not call the backend, misses preserve the
existing server request path, ready server responses are stored only after the
video ID and algorithm version match the current request, cache write failures
are non-fatal, and both local-cache and server-cache results still use the same
content skip message.

### [x] Task 4: Add No-Backend Fixture Coverage For Fresh Local Cache

**Files:**

- Modify: `e2e/extension.spec.ts`

- [x] **Step 1: Write the failing test**

Add a helper near `seedDetectedPopupState` to seed extension storage from an
extension page:

```ts
async function seedFreshLocalServerCache(popupPage: Page): Promise<void> {
    await popupPage.evaluate(async () => {
        const chromeApi = Reflect.get(globalThis, 'chrome');
        if (typeof chromeApi !== 'object' || chromeApi === null) {
            throw new Error('Missing chrome API');
        }
        const storage = Reflect.get(chromeApi, 'storage');
        if (typeof storage !== 'object' || storage === null) {
            throw new Error('Missing chrome.storage API');
        }
        const local = Reflect.get(storage, 'local');
        if (typeof local !== 'object' || local === null) {
            throw new Error('Missing chrome.storage.local API');
        }
        const set = Reflect.get(local, 'set');
        if (typeof set !== 'function') {
            throw new Error('Missing chrome.storage.local.set API');
        }

        const key = 'topskip:server-result-cache:server-v1:e2eFixture1';
        await new Promise<void>((resolve, reject) => {
            Reflect.apply(set, local, [
                {
                    [key]: {
                        videoId: 'e2eFixture1',
                        algorithmVersion: 'server-v1',
                        sourceResultId: 'result-e2eFixture1-server-v1',
                        freshness: { expiresAtMs: 4_102_444_800_000 },
                        promoBlocks: [
                            { startSec: 4, endSec: 24, confidence: 'high' },
                        ],
                        storedAtMs: 1_900_000_000_000,
                    },
                },
                () => {
                    const runtime = Reflect.get(chromeApi, 'runtime');
                    const lastError =
                        typeof runtime === 'object' && runtime !== null
                            ? Reflect.get(runtime, 'lastError')
                            : undefined;
                    if (typeof lastError === 'object' && lastError !== null) {
                        reject(new Error(String(Reflect.get(lastError, 'message'))));
                        return;
                    }
                    resolve();
                },
            ]);
        });
    });
}
```

Add the e2e case:

```ts
test('fresh local cache hit skips fixture playback without a backend', async () => {
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
        await seedFreshLocalServerCache(warmupPopup);
        await warmupPopup.close();

        const page = await context.newPage();
        trackPageErrors(page, 'fixture-local-cache', errors);
        await page.goto('/video.html', { waitUntil: 'domcontentloaded' });
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

        expectNoCollectedErrors(errors);
    } finally {
        await context.close();
    }
});
```

This test intentionally does not start a backend on port `8787`; if the local
cache path does not short-circuit the network request, the content script will
not receive blocks and the fixture will fail to skip beyond `23s`.

- [x] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm run build && pnpm run test:e2e -- e2e/extension.spec.ts
```

Expected: FAIL because the seeded local cache is ignored and no backend-ready
response is available to deliver blocks.

- [x] **Step 3: Write minimal implementation**

No additional production code should be needed beyond Tasks 1-3. If this e2e
fails after unit tests pass, inspect only the seeded storage key and the current
video ID in `src/content/page-guards.ts`; do not add a second content skip path.

- [x] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm run build && pnpm run test:e2e -- e2e/extension.spec.ts
```

Expected: PASS.

**Verification**: A ready result stored in `browser.storage.local` is enough for
server mode to activate promo blocks after reload/revisit, even with the local
backend stopped.

### [x] Task 5: Run Focused Regression Checks

**Files:**

- No additional source files.

- [x] **Step 1: Run focused unit tests**

Run:

```bash
pnpm run test \
  tests/shared/server-analysis-contract.test.ts \
  tests/backend/analysis-api.test.ts \
  tests/backend/server.test.ts \
  tests/background/server-analysis-client.test.ts \
  tests/background/storage/server-result-cache.test.ts \
  tests/background/messaging/server-analysis-runtime-messages.test.ts \
  tests/content/server-analysis-request.test.ts \
  tests/content/promo-skip-logic.test.ts \
  tests/content/youtube-watch-skip-integration.test.ts
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

Run:

```bash
pnpm run lint
```

Expected: PASS. If lint fails only on unrelated dirty-worktree files, report
those paths during validation instead of changing unrelated code.

**Verification**: Focused checks prove schema metadata, cache storage behavior,
storage failure misses, runtime no-network hits, server misses, ready-response
version rejection, non-fatal cache-write failure, unchanged content skip logic,
and fixture behavior.

## Self-Review

- **Acceptance criterion 1** is covered by Task 3 and Task 4: a fresh local cache
  entry is read before `ServerAnalysisClient.requestAnalysis`, delivered through
  `PROMO_BLOCKS_DETECTED`, and proven in e2e without a running backend.
- **Acceptance criterion 2** is covered by Task 2 and Task 3: stale cache entries
  are removed by `ServerResultCacheStorage.loadFresh`, return `null`, and the
  runtime handler continues into the normal backend request path. Storage read
  and repair failures also return `null`, so cache failures cannot block backend
  fallback.
- **Acceptance criterion 3** is covered by Task 1 and Task 3: ready server
  responses must include `sourceResultId` and `freshness`, then
  `ServerAnalysisRuntimeMessages` verifies the response `videoId` and
  `algorithmVersion` match the current request before
  `ServerResultCacheStorage.saveReadyResponse` persists the validated entry.
  If that write fails, delivery still proceeds.
- **Acceptance criterion 4** is covered by Task 2: corrupt rows and rows whose
  stored `videoId` or `algorithmVersion` do not match the lookup are removed and
  never delivered to content.
- **No backend persistence is introduced**: backend changes are limited to adding
  deterministic metadata to the existing in-memory fixture response.
- **Type consistency**: `ReadyResponse.freshness`, `ReadyResponse.sourceResultId`,
  and `ServerResultCacheEntry` use the same property names across contract,
  storage, runtime, and tests.
- **Review finding addressed - ready response version guard**: Task 3 adds a
  failing test for a ready response with `algorithmVersion: 'server-v0'` and the
  implementation guard that rejects it before save or
  `PROMO_BLOCKS_DETECTED` delivery.
- **Review finding addressed - storage failures are non-fatal**: Task 2 adds
  failing tests for `browser.storage.local.get` rejection and failed corrupt-row
  repair, and Task 3 adds a failing test proving a rejected
  `saveReadyResponse` does not prevent valid server blocks from being delivered.
- **Scope control**: popup state receives `source: 'local_cache'`, but this plan
  does not add localized UI copy; issue 3 is the cache behavior slice, while
  status wording can be handled by a status-UI issue.
