# Implementation Plan: Job Dedupe, Validation, and Local Rate Limits

- **Created**: 2026-07-07
- **Status**: Approved
- **Issue**: `.sdd/.current/issues/5-AFK/issue.md`
- **PRD**: `.sdd/.current/prd.md`
- **Model**: GPT-5 Codex
- **User Input**: `ISSUE_ID=5-AFK`, `SPECS_DIR=.sdd/.current`, constraints: no additional constraints.

## Summary

Harden the existing local backend `POST /v1/analysis` path so invalid requests are rejected before any job lookup or creation, active or terminal jobs are reused by `videoId` plus `algorithmVersion`, and only true cold job starts consume a local expensive-work rate-limit bucket. The current code already has seeded cache hits, in-memory jobs, status polling, and fixture completion from earlier issues; this slice adds a small backend-owned protection module and rewires `BackendAnalysisApi.handleAnalysisRequest` so cache hits and job joins are accounted as cheap work while cold starts can return a retryable HTTP `429` response without creating a job.

## Technical Context

- **Language/Version**: TypeScript 6.0.2 in strict ESM mode; Node.js `>=20`.
- **Primary Dependencies**: Valibot 1.3 for boundary validation, Node `http` for the local backend, Vitest 4 for unit/integration tests, `tsx` for `pnpm run backend:dev`.
- **Storage**: No durable backend storage in this slice. Existing backend jobs and protection counters remain process-local in memory and are reset by test helpers.
- **Testing**: Vitest tests under `tests/backend/**` and `tests/shared/server-analysis-contract.test.ts`; final focused command is `pnpm run test tests/shared/server-analysis-contract.test.ts tests/backend/api-protection.test.ts tests/backend/analysis-jobs.test.ts tests/backend/analysis-api.test.ts tests/backend/server.test.ts`.
- **Target Platform**: Local Node backend at `http://127.0.0.1:8787` plus the Chrome MV3 extension background client that already calls it.

## Research

### Current Backend Request Flow

`src/backend/analysis-api.ts:59` validates raw JSON, gives malformed video IDs a specific `invalid_video_id` response at `src/backend/analysis-api.ts:60`, checks seeded cache fixtures at `src/backend/analysis-api.ts:87`, and calls `BackendAnalysisJobs.start` at `src/backend/analysis-api.ts:95`. That ordering is close, but it does not expose a rate-limit decision point before a cold job is created and it cannot classify an existing job join without calling the idempotent start method.

### Existing Job Dedupe

`src/backend/analysis-jobs.ts:79` already dedupes starts by a private `${videoId}:${algorithmVersion}` key and returns either the existing processing response or the terminal response. This behavior should stay as a defensive invariant. Issue 5 needs a read-only lookup before the cold-start path so the API can classify duplicates as cheap joins without consuming the expensive-work bucket.

### Existing HTTP Boundary

`src/backend/server.ts:84` routes `POST /v1/analysis` through `handleAnalysis`, and `src/backend/server.ts:214` bounds request-body parsing before API handling. The server can continue sending `result.statusCode` from `BackendAnalysisApi`; adding `429` to the API result union does not require a new route or body parser.

### Current Contract Shape

`src/shared/server-analysis-contract.ts:45` owns the `AnalysisRequest` schema and `src/shared/server-analysis-contract.ts:172` owns typed request errors. Successful analysis responses are already modeled separately from errors. A retryable rate-limit response should therefore be a new strict schema with `status: 'rate_limited'`, `retryAfterSec`, and `error.code: 'rate_limited'`, rather than overloading `ErrorResponse.status: 'invalid_request'`.

### Existing Tests to Extend

`tests/backend/analysis-api.test.ts:43` already verifies invalid video IDs return `400`; extend this with no-job/no-protection-side-effect assertions. `tests/backend/analysis-api.test.ts:112` and `tests/backend/analysis-api.test.ts:131` already cover duplicate active and terminal requests; extend them to prove duplicate joins do not consume cold-start quota. `tests/backend/server.test.ts:156` covers HTTP job polling; add HTTP `429` coverage there.

### Dependency Status

Issue `4-AFK` is `Validated`, so this issue can rely on the cold job lifecycle, job status route, terminal fixture completion, server response contracts, and content-owned polling from that slice.

### Sub-Agent Availability

The explorer prompt exists at `/Users/maximtop/.codex/skills/oneshot-agent/agents/oneshot-explorer.agent.md`, but no sub-agent launch tool is available in this session. Repository exploration was performed locally with `rg`, `find`, `sed`, and targeted `nl -ba` reads.

## Entities

### Backend Protection Decision

- **Fields**:
    - `allowed`: `boolean` - whether the backend may proceed.
    - `costClass`: `'cache_lookup' | 'job_join' | 'cold_job_start'` - request cost category after validation and cheap lookup checks.
    - `retryAfterSec`: `number | undefined` - positive integer for denied cold starts.
- **Relationships**: Produced by `BackendApiProtection.evaluate`; consumed by `BackendAnalysisApi.handleAnalysisRequest`.
- **Validation**: Only `cold_job_start` can be denied in this slice. Cache hits and job joins are recorded separately and return allowed.
- **States**: allowed cheap lookup, allowed job join, allowed cold start, denied cold start.

### Local Rate-Limit Bucket

- **Fields**:
    - `windowStartedAtMs`: `number` - start timestamp for the current local fixed window.
    - `coldJobStarts`: `number` - count of allowed cold job starts in the current window.
    - `cacheLookups`: `number` - diagnostic count for cheap cache lookups.
    - `jobJoins`: `number` - diagnostic count for existing active or terminal job joins.
- **Relationships**: Owned by `BackendApiProtection`; reset by `BackendApiProtection.resetForTests`.
- **Validation**: Window timestamps use finite milliseconds. The cold bucket limit is a named constant, not an inline literal.
- **States**: empty window -> accumulating allowed cold starts -> exhausted until the window rolls over.

### Analysis Job

- **Fields**:
    - `jobId`: `string` - deterministic local job id.
    - `jobKey`: `string` - internal dedupe key from `videoId` and `algorithmVersion`.
    - `processingResponse`: `ProcessingResponse` - active job response.
    - `terminalResponse`: `BackendAnalysisTerminalResponse | null` - completed response.
- **Relationships**: Existing entity in `src/backend/analysis-jobs.ts`; `BackendAnalysisApi` will read it through a new `findExisting` method before creating new work.
- **Validation**: `findExisting` must not create records or change `createdAtMs`, `completedAtMs`, or terminal response state.
- **States**: missing -> processing -> terminal.

### Rate-Limited Response

- **Fields**:
    - `status`: `'rate_limited'`
    - `retryAfterSec`: `number`
    - `error.code`: `'rate_limited'`
    - `error.message`: `string`
- **Relationships**: Returned only by `POST /v1/analysis` for denied cold starts; documented in `.sdd/.current/issues/5-AFK/contracts/openapi.yaml`.
- **Validation**: `retryAfterSec` is a positive integer; the response is strict and has no extra properties.
- **States**: retryable terminal response for the request; it does not create or mutate an analysis job.

## Contracts

Contract file: `.sdd/.current/issues/5-AFK/contracts/openapi.yaml`.

This issue extends the local backend API with:

- `POST /v1/analysis` keeps existing `200`, `202`, `400`, and `413` behavior.
- `POST /v1/analysis` adds `429 RateLimitedResponse` for exhausted cold-start quota.
- Invalid or missing `videoId` values are rejected as `400 ErrorResponse` before cache lookup, rate-limit accounting, or job creation.
- Existing active or terminal jobs for the same `videoId` plus `algorithmVersion` return the existing response and are classified as `job_join`, not `cold_job_start`.
- Ready cache hits are classified as `cache_lookup`, not `cold_job_start`.
- `GET /v1/analysis/jobs/{jobId}` and `POST /v1/analysis/jobs/{jobId}/fixture-result` keep the issue 4 contract unchanged.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `.sdd/.current/issues/5-AFK/contracts/openapi.yaml` | Create | Documents the retryable `429` response and the cost classification semantics for `POST /v1/analysis`. |
| `src/shared/server-analysis-contract.ts` | Modify | Adds `rateLimitedResponseSchema` and `RateLimitedResponse` for backend API responses. |
| `tests/shared/server-analysis-contract.test.ts` | Modify | Verifies strict parsing of the rate-limit response and rejection of invalid retry metadata. |
| `src/backend/api-protection.ts` | Create | Owns local cost classification counters, cold-start rate-limit decisions, and test reset/snapshot helpers. |
| `tests/backend/api-protection.test.ts` | Create | Covers cheap accounting, cold-start limits, retry metadata, and fixed-window reset behavior. |
| `src/backend/analysis-jobs.ts` | Modify | Adds read-only lookup and snapshot helpers so the API can join existing jobs without creating work. |
| `tests/backend/analysis-jobs.test.ts` | Modify | Verifies read-only lookup before start, active lookup after start, terminal lookup after completion, and no mutation during lookup. |
| `src/backend/analysis-api.ts` | Modify | Orders validation, cache lookup, existing-job join, cold-start rate-limit evaluation, and job creation. |
| `tests/backend/analysis-api.test.ts` | Modify | Covers no side effects for invalid requests, duplicate join classification, cheap cache lookup accounting, and `429` without job creation. |
| `src/backend/server.ts` | Modify | Accepts the new `429` API result status without changing routing. |
| `tests/backend/server.test.ts` | Modify | Covers HTTP `429` body shape and confirms repeated cache hits or duplicate joins do not exhaust cold-start quota. |

## Tasks

### [x] Task 1: Shared Rate-Limit Contract

**Files:**

- Modify: `src/shared/server-analysis-contract.ts`
- Modify: `tests/shared/server-analysis-contract.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import {
    rateLimitedResponseSchema,
    type RateLimitedResponse,
} from '@/shared/server-analysis-contract';

it('parses retryable rate-limit responses separately from invalid requests', () => {
    const parsed: RateLimitedResponse = v.parse(rateLimitedResponseSchema, {
        status: 'rate_limited',
        retryAfterSec: 60,
        error: {
            code: 'rate_limited',
            message: 'Local cold-analysis limit reached. Retry later.',
        },
    });

    expect(parsed.retryAfterSec).toBe(60);
    expect(parsed.error.code).toBe('rate_limited');
});

it('rejects non-positive retry metadata', () => {
    expect(
        v.safeParse(rateLimitedResponseSchema, {
            status: 'rate_limited',
            retryAfterSec: 0,
            error: {
                code: 'rate_limited',
                message: 'Local cold-analysis limit reached. Retry later.',
            },
        }).success,
    ).toBe(false);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/shared/server-analysis-contract.test.ts`

Expected: FAIL with missing export `rateLimitedResponseSchema`.

- [x] **Step 3: Write minimal implementation**

Add the schema and type next to the existing error response schema:

```ts
export const rateLimitedResponseSchema = v.strictObject({
    status: v.literal('rate_limited'),
    retryAfterSec: v.pipe(v.number(), v.integer(), v.minValue(1)),
    error: v.strictObject({
        code: v.literal('rate_limited'),
        message: v.pipe(v.string(), v.minLength(1)),
    }),
});

export type RateLimitedResponse = v.InferOutput<
    typeof rateLimitedResponseSchema
>;
```

Do not add `rateLimitedResponseSchema` to `serverAnalysisResponseSchema`; that union remains the successful analysis response contract consumed by the extension client.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/shared/server-analysis-contract.test.ts`

Expected: PASS.

**Verification**: The backend has a strict retryable response type without changing successful analysis response parsing.

### [x] Task 2: Backend API Protection Module

**Files:**

- Create: `src/backend/api-protection.ts`
- Create: `tests/backend/api-protection.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import {
    BACKEND_REQUEST_COST_CLASS,
    BackendApiProtection,
} from '@/backend/api-protection';

describe('BackendApiProtection', () => {
    beforeEach(() => {
        BackendApiProtection.resetForTests();
    });

    it('accounts cache lookups separately from cold job starts', () => {
        expect(
            BackendApiProtection.evaluate({
                costClass: BACKEND_REQUEST_COST_CLASS.CacheLookup,
                nowMs: 1_900_000_000_000,
            }),
        ).toEqual({ allowed: true, costClass: 'cache_lookup' });

        expect(BackendApiProtection.snapshotForTests()).toMatchObject({
            cacheLookups: 1,
            jobJoins: 0,
            coldJobStarts: 0,
        });
    });

    it('denies cold starts after the local bucket is exhausted', () => {
        expect(
            BackendApiProtection.evaluate({
                costClass: BACKEND_REQUEST_COST_CLASS.ColdJobStart,
                nowMs: 1_900_000_000_000,
            }).allowed,
        ).toBe(true);
        expect(
            BackendApiProtection.evaluate({
                costClass: BACKEND_REQUEST_COST_CLASS.ColdJobStart,
                nowMs: 1_900_000_001_000,
            }).allowed,
        ).toBe(true);

        expect(
            BackendApiProtection.evaluate({
                costClass: BACKEND_REQUEST_COST_CLASS.ColdJobStart,
                nowMs: 1_900_000_002_000,
            }),
        ).toEqual({
            allowed: false,
            costClass: 'cold_job_start',
            retryAfterSec: 58,
        });
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/backend/api-protection.test.ts`

Expected: FAIL with module not found for `@/backend/api-protection`.

- [x] **Step 3: Write minimal implementation**

Create a static-only class with named constants and fixed-window accounting:

```ts
import { MS_PER_SECOND } from '@/shared/constants';

const LOCAL_RATE_LIMIT_WINDOW_MS = 60_000;
const LOCAL_COLD_JOB_START_LIMIT = 2;

export const BACKEND_REQUEST_COST_CLASS = {
    CacheLookup: 'cache_lookup',
    JobJoin: 'job_join',
    ColdJobStart: 'cold_job_start',
} as const;

type BackendRequestCostClass =
    (typeof BACKEND_REQUEST_COST_CLASS)[keyof typeof BACKEND_REQUEST_COST_CLASS];

type BackendProtectionDecision =
    | { allowed: true; costClass: BackendRequestCostClass }
    | {
          allowed: false;
          costClass: typeof BACKEND_REQUEST_COST_CLASS.ColdJobStart;
          retryAfterSec: number;
      };

export class BackendApiProtection {
    private static windowStartedAtMs = 0;
    private static cacheLookups = 0;
    private static jobJoins = 0;
    private static coldJobStarts = 0;

    static evaluate(input: {
        costClass: BackendRequestCostClass;
        nowMs: number;
    }): BackendProtectionDecision {
        BackendApiProtection.rollWindow(input.nowMs);

        if (input.costClass === BACKEND_REQUEST_COST_CLASS.CacheLookup) {
            BackendApiProtection.cacheLookups += 1;
            return { allowed: true, costClass: input.costClass };
        }

        if (input.costClass === BACKEND_REQUEST_COST_CLASS.JobJoin) {
            BackendApiProtection.jobJoins += 1;
            return { allowed: true, costClass: input.costClass };
        }

        if (
            BackendApiProtection.coldJobStarts >= LOCAL_COLD_JOB_START_LIMIT
        ) {
            return {
                allowed: false,
                costClass: input.costClass,
                retryAfterSec: BackendApiProtection.retryAfterSec(input.nowMs),
            };
        }

        BackendApiProtection.coldJobStarts += 1;
        return { allowed: true, costClass: input.costClass };
    }

    static resetForTests(): void {
        BackendApiProtection.windowStartedAtMs = 0;
        BackendApiProtection.cacheLookups = 0;
        BackendApiProtection.jobJoins = 0;
        BackendApiProtection.coldJobStarts = 0;
    }

    static snapshotForTests(): {
        cacheLookups: number;
        jobJoins: number;
        coldJobStarts: number;
    } {
        return {
            cacheLookups: BackendApiProtection.cacheLookups,
            jobJoins: BackendApiProtection.jobJoins,
            coldJobStarts: BackendApiProtection.coldJobStarts,
        };
    }
}
```

Add private `rollWindow` and `retryAfterSec` helpers with multi-line JSDoc, using `Math.ceil((windowEndsAtMs - nowMs) / MS_PER_SECOND)` and `Math.max(1, value)`.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/backend/api-protection.test.ts`

Expected: PASS.

**Verification**: Cheap request accounting and cold-start throttling are isolated from the API route orchestration.

### [x] Task 3: Read-Only Job Lookup

**Files:**

- Modify: `src/backend/analysis-jobs.ts`
- Modify: `tests/backend/analysis-jobs.test.ts`

- [x] **Step 1: Write the failing test**

```ts
it('finds existing jobs by video and algorithm without creating records', () => {
    BackendAnalysisJobs.resetForTests();

    expect(
        BackendAnalysisJobs.findExisting({
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        }),
    ).toBeNull();
    expect(BackendAnalysisJobs.snapshotForTests().jobCount).toBe(0);

    const processing = BackendAnalysisJobs.start({
        videoId: 'dQw4w9WgXcQ',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        nowMs: 1_900_000_000_000,
    });

    expect(
        BackendAnalysisJobs.findExisting({
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        }),
    ).toEqual(processing);
    expect(BackendAnalysisJobs.snapshotForTests().jobCount).toBe(1);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/backend/analysis-jobs.test.ts`

Expected: FAIL with missing `findExisting` and `snapshotForTests` methods.

- [x] **Step 3: Write minimal implementation**

Add a read-only lookup above `getStatus`:

```ts
static findExisting(input: {
    videoId: string;
    algorithmVersion: string;
}): BackendAnalysisJobResponse | null {
    const jobKey = BackendAnalysisJobs.buildJobKey(input);
    const jobId = BackendAnalysisJobs.jobIdsByKey.get(jobKey);
    if (jobId === undefined) {
        return null;
    }

    const record = BackendAnalysisJobs.jobsById.get(jobId);
    if (record === undefined) {
        return null;
    }

    return record.terminalResponse ?? record.processingResponse;
}

static snapshotForTests(): { jobCount: number } {
    return { jobCount: BackendAnalysisJobs.jobsById.size };
}
```

Keep `BackendAnalysisJobs.start` idempotent exactly as it is today so direct callers still cannot create duplicates.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/backend/analysis-jobs.test.ts`

Expected: PASS.

**Verification**: The API can classify duplicate requests without using a method that may create a new job.

### [x] Task 4: Enforce Request Ordering in BackendAnalysisApi

**Files:**

- Modify: `src/backend/analysis-api.ts`
- Modify: `tests/backend/analysis-api.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import { BackendApiProtection } from '@/backend/api-protection';

beforeEach(() => {
    BackendAnalysisJobs.resetForTests();
    BackendApiProtection.resetForTests();
});

it('rejects missing video ids without protection accounting or job creation', () => {
    const response = BackendAnalysisApi.handleAnalysisRequest({
        extensionVersion: '0.1.0',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        client: {
            source: 'chrome-extension',
            capabilities: ['processing-status'],
        },
    });

    expect(response.statusCode).toBe(400);
    expect(BackendAnalysisJobs.snapshotForTests().jobCount).toBe(0);
    expect(BackendApiProtection.snapshotForTests()).toMatchObject({
        cacheLookups: 0,
        jobJoins: 0,
        coldJobStarts: 0,
    });
});

it('rate-limits only new cold job starts', () => {
    const requestFor = (videoId: string) => ({
        videoId,
        extensionVersion: '0.1.0',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        client: {
            source: 'chrome-extension',
            capabilities: ['processing-status'],
        },
    });

    expect(
        BackendAnalysisApi.handleAnalysisRequest(requestFor('dQw4w9WgXcQ'), {
            nowMs: 1_900_000_000_000,
        }).statusCode,
    ).toBe(202);
    expect(
        BackendAnalysisApi.handleAnalysisRequest(requestFor('M7lc1UVf-VE'), {
            nowMs: 1_900_000_001_000,
        }).statusCode,
    ).toBe(202);

    const limited = BackendAnalysisApi.handleAnalysisRequest(
        requestFor('aqz-KE-bpKQ'),
        { nowMs: 1_900_000_002_000 },
    );

    expect(limited).toEqual({
        statusCode: 429,
        body: {
            status: 'rate_limited',
            retryAfterSec: 58,
            error: {
                code: 'rate_limited',
                message: 'Local cold-analysis limit reached. Retry later.',
            },
        },
    });
    expect(BackendAnalysisJobs.snapshotForTests().jobCount).toBe(2);
});

it('does not spend cold-start quota for duplicate active jobs or cache hits', () => {
    const coldRequest = {
        videoId: 'dQw4w9WgXcQ',
        extensionVersion: '0.1.0',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        client: {
            source: 'chrome-extension',
            capabilities: ['processing-status'],
        },
    };

    const first = BackendAnalysisApi.handleAnalysisRequest(coldRequest, {
        nowMs: 1_900_000_000_000,
    });
    const duplicate = BackendAnalysisApi.handleAnalysisRequest(coldRequest, {
        nowMs: 1_900_000_001_000,
    });
    const cacheHit = BackendAnalysisApi.handleAnalysisRequest({
        ...coldRequest,
        videoId: 'e2eFixture1',
    }, {
        nowMs: 1_900_000_002_000,
    });

    expect(duplicate.body).toEqual(first.body);
    expect(cacheHit.statusCode).toBe(200);
    expect(BackendApiProtection.snapshotForTests()).toMatchObject({
        cacheLookups: 1,
        jobJoins: 1,
        coldJobStarts: 1,
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/backend/analysis-api.test.ts`

Expected: FAIL with missing `BackendApiProtection`, missing optional API options, and missing `429` result handling.

- [x] **Step 3: Write minimal implementation**

Update the result union and method signature:

```ts
import {
    BACKEND_REQUEST_COST_CLASS,
    BackendApiProtection,
} from '@/backend/api-protection';

type BackendApiResult =
    | { statusCode: 200; body: BackendAnalysisTerminalResponse }
    | { statusCode: 202; body: ProcessingResponse }
    | { statusCode: 400; body: ErrorResponse }
    | { statusCode: 404; body: ErrorResponse }
    | { statusCode: 429; body: RateLimitedResponse };

static handleAnalysisRequest(
    raw: unknown,
    options: { nowMs?: number } = {},
): BackendApiResult {
    const nowMs = options.nowMs ?? Date.now();
```

Then order the accepted request path this way:

```ts
const ready = BackendCacheFixtures.findReady({
    videoId: parsed.output.videoId,
    algorithmVersion: parsed.output.algorithmVersion,
});
if (ready !== null) {
    BackendApiProtection.evaluate({
        costClass: BACKEND_REQUEST_COST_CLASS.CacheLookup,
        nowMs,
    });
    return { statusCode: 200, body: ready };
}

const existingJob = BackendAnalysisJobs.findExisting({
    videoId: parsed.output.videoId,
    algorithmVersion: parsed.output.algorithmVersion,
});
if (existingJob !== null) {
    BackendApiProtection.evaluate({
        costClass: BACKEND_REQUEST_COST_CLASS.JobJoin,
        nowMs,
    });
    return BackendAnalysisApi.jobResponseResult(existingJob);
}

const protection = BackendApiProtection.evaluate({
    costClass: BACKEND_REQUEST_COST_CLASS.ColdJobStart,
    nowMs,
});
if (!protection.allowed) {
    return {
        statusCode: 429,
        body: BackendAnalysisApi.rateLimited(protection.retryAfterSec),
    };
}

const jobResponse = BackendAnalysisJobs.start({
    videoId: parsed.output.videoId,
    algorithmVersion: parsed.output.algorithmVersion,
    nowMs,
});
return BackendAnalysisApi.jobResponseResult(jobResponse);
```

Add a private `rateLimited(retryAfterSec: number): RateLimitedResponse` helper that parses `rateLimitedResponseSchema` with message `Local cold-analysis limit reached. Retry later.`

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/backend/analysis-api.test.ts`

Expected: PASS.

**Verification**: Invalid requests have no side effects, duplicates join existing jobs, cache hits stay cheap, and exhausted cold-start quota does not create a new job.

### [x] Task 5: HTTP Boundary and Focused Verification

**Files:**

- Modify: `src/backend/server.ts`
- Modify: `tests/backend/server.test.ts`
- Review: `.sdd/.current/issues/5-AFK/contracts/openapi.yaml`

- [x] **Step 1: Write the failing test**

```ts
import { BackendApiProtection } from '@/backend/api-protection';

beforeEach(() => {
    BackendAnalysisJobs.resetForTests();
    BackendApiProtection.resetForTests();
});

it('returns HTTP 429 for rate-limited cold starts without creating a third job', async () => {
    const server = BackendHttpServer.create();
    servers.push(server);
    await listenOnEphemeralPort(server);
    const baseUrl = localServerUrl(server);

    const requestFor = (videoId: string) => ({
        videoId,
        extensionVersion: '0.1.0',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        client: {
            source: 'chrome-extension',
            capabilities: ['processing-status'],
        },
    });

    expect((await postJson(`${baseUrl}/v1/analysis`, requestFor('dQw4w9WgXcQ'))).status).toBe(202);
    expect((await postJson(`${baseUrl}/v1/analysis`, requestFor('M7lc1UVf-VE'))).status).toBe(202);

    const limited = await postJson(
        `${baseUrl}/v1/analysis`,
        requestFor('aqz-KE-bpKQ'),
    );

    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toEqual({
        status: 'rate_limited',
        retryAfterSec: expect.any(Number),
        error: {
            code: 'rate_limited',
            message: 'Local cold-analysis limit reached. Retry later.',
        },
    });
    expect(BackendAnalysisJobs.snapshotForTests().jobCount).toBe(2);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/backend/server.test.ts`

Expected: FAIL until the API returns `429` and the server accepts the result status in TypeScript.

- [x] **Step 3: Write minimal implementation**

`BackendHttpServer.handleAnalysis` already sends `result.statusCode`, so keep runtime changes minimal. If TypeScript requires no server change after `BackendApiResult` gains `429`, only update the test `beforeEach` to call `BackendApiProtection.resetForTests`. If a named HTTP status constant is added for readability, use:

```ts
const HTTP_STATUS_TOO_MANY_REQUESTS = 429;
```

and keep response body construction inside `BackendAnalysisApi`, not the HTTP server.

- [x] **Step 4: Run focused verification**

Run: `pnpm run test tests/shared/server-analysis-contract.test.ts tests/backend/api-protection.test.ts tests/backend/analysis-jobs.test.ts tests/backend/analysis-api.test.ts tests/backend/server.test.ts`

Expected: PASS.

Run: `pnpm run lint:types`

Expected: PASS.

**Verification**: The HTTP boundary returns a documented retryable `429`, and all touched TypeScript compiles under strict settings.

## Self-Review

- **Acceptance criterion 1** is covered by Task 4: invalid and missing video IDs return `400` before protection accounting or job creation.
- **Acceptance criterion 2** is covered by Tasks 3 and 4: existing active or terminal jobs are found and returned without creating duplicates.
- **Acceptance criterion 3** is covered by Tasks 2, 4, and 5: exhausted cold-start quota returns `429 RateLimitedResponse` and leaves `jobCount` unchanged.
- **Acceptance criterion 4** is covered by Tasks 2 and 4: `cache_lookup`, `job_join`, and `cold_job_start` are separate cost classes with separate test assertions.
- **Placeholder scan**: The plan contains concrete file paths, type names, commands, and code snippets with no unresolved placeholder language.
- **Type consistency**: The plan uses `RateLimitedResponse`, `BackendApiProtection`, `BACKEND_REQUEST_COST_CLASS`, `findExisting`, and `snapshotForTests` consistently across tasks.
- **Review findings**: No `review.md` exists for `5-AFK`, so revision findings do not apply.
