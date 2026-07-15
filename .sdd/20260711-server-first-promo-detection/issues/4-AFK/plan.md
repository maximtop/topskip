# Implementation Plan: Cold Analysis Job Lifecycle and Polling

- **Created**: 2026-07-06
- **Status**: Approved
- **Issue**: `.sdd/.current/issues/4-AFK/issue.md`
- **PRD**: `.sdd/.current/prd.md`
- **Model**: GPT-5 Codex
- **User Input**: `ISSUE_ID=4-AFK`, `SPECS_DIR=.sdd/.current`, constraints: revise the existing plan to address `.sdd/.current/issues/4-AFK/review.md`, specifically content-owned polling cancellation on `PREFS_UPDATED` when `shouldUseServerAnalysis` becomes false, a background current-prefs guard before job-status backend fetches, and idempotent `BackendAnalysisJobs.start` behavior for repeated cold requests with the same `videoId` plus `algorithmVersion`.

## Summary

Implement the local cold-miss server analysis lifecycle. The backend will create or return an idempotent in-memory job keyed by `videoId` plus `algorithmVersion` when no ready cache fixture exists, expose a job-status endpoint, and expose a deterministic local fixture-completion hook for manual and automated tests. Repeated cold requests must join the existing active job and return the existing terminal job result after completion without resetting state. The extension will keep backend fetches in the background service worker, but the watch content script will own polling timers through runtime messages so polling is tied to the currently open video and can be cancelled on navigation, terminal responses, or `PREFS_UPDATED` that leaves server analysis mode. The background refresh handler must re-load current prefs and return an inactive ack before any backend fetch when TopSkip is disabled or private BYOK mode is active. Terminal `ready`, `no_promo`, `unavailable`, and `error` states will update popup detection status; `ready` will reuse the existing server-result delivery path and local result cache, while late-arriving blocks will continue to rely on existing crossing-only skip logic so already-passed block starts do not fire retroactively.

## Technical Context

- **Language/Version**: TypeScript 6.0.2 in strict ESM mode; Node.js `>=20`.
- **Primary Dependencies**: Rspack 1.7, React 19.2, Mantine 9, MobX 6, Valibot 1.3, `webextension-polyfill`, Vitest 4, Playwright 1.59.
- **Storage**: `browser.storage.local`, accessed only in the background. This issue does not add durable backend persistence; backend jobs are in-memory and local-dev only.
- **Testing**: Vitest for shared contracts, backend job store/API/server routes, background client/runtime routing, content polling helpers, popup view model, and skip logic; Playwright for the extension plus local fixture.
- **Target Platform**: Chrome Manifest V3 extension plus local Node HTTP backend at `http://127.0.0.1:8787`.

## Research

### Existing Server Analysis Contract

`src/shared/server-analysis-contract.ts:59` already defines `ProcessingResponse`, `src/shared/server-analysis-contract.ts:113` defines `ReadyResponse`, and `src/shared/server-analysis-contract.ts:126` unions only `processing | ready`. Issue 4 should extend this same union with terminal `no_promo`, `unavailable`, and `error` response schemas rather than adding an untyped status path.

### Existing Backend Flow

`src/backend/analysis-api.ts:83` checks the fixture cache and returns `200 ready` for `e2eFixture1`. If there is no fixture hit, `src/backend/analysis-api.ts:91` returns a deterministic `202 processing` response but does not persist a job. Issue 4 should insert an in-memory `BackendAnalysisJobs` module at that cold-miss point and let status reads return the stored processing or terminal response. `BackendAnalysisJobs.start` must be idempotent for the same `videoId` plus `algorithmVersion`: it returns the existing processing response for an active job, and returns the existing terminal response after fixture completion instead of overwriting the record.

### Existing HTTP Boundary

`src/backend/server.ts:81` currently routes only `POST /v1/analysis`, with JSON body parsing centralized in `readJsonBody` at `src/backend/server.ts:126`. New job-status and fixture-completion routes should stay in this class, reuse `sendJson`, and extend the existing `ErrorResponse` with `job_not_found` instead of throwing.

### Existing Extension Server Path

`src/background/messaging/server-analysis-runtime-messages.ts:72` already loads current prefs before initial server analysis, and `src/background/messaging/server-analysis-runtime-messages.ts:78` checks the extension local cache before calling the backend. `src/background/messaging/server-analysis-runtime-messages.ts:124` already saves valid ready responses and delivers blocks through `TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED`. Issue 4 should factor this mapping into a reusable response handler used by both initial requests and job-status refreshes, keeping video ID and algorithm-version guards before any save or delivery. The new `handleRefreshStatus` path must perform the same current-prefs load and return `{ ok: true, status: 'inactive' }` without calling `ServerAnalysisClient.requestJobStatus` when `enabled` is false or `analysisMode` is not `ANALYSIS_MODE.Server`.

### Polling Ownership

The content script currently sends one server request in `src/content/youtube-watch.ts:391` and ignores the ack. Long-lived polling timers should live in the content script, not in the MV3 service worker, because the content page naturally cancels polling on video navigation through `resetForNewVideo` at `src/content/youtube-watch.ts:375`. `src/content/youtube-watch.ts:520` updates cached prefs from `PREFS_UPDATED`; after this issue it must clear any scheduled server-analysis status timer when `shouldUseServerAnalysis(m.prefs)` is false so a disabled extension or private BYOK mode cannot continue polling. The background remains the only code that calls the local backend.

### Server-Mode Preference Guards

There are two required guards against stale server polling. The content guard owns timer cleanup: `onPrefsUpdatedMessage` stores the new prefs, calls `clearServerAnalysisPolling()` whenever `shouldUseServerAnalysis(m.prefs)` is false, and then re-syncs binding. The background guard owns backend access: `handleRefreshStatus` loads current prefs with `PrefsSyncStorage.ready()` and `PrefsSyncStorage.load()` immediately after validating the sender tab id and before checking local cache or calling `ServerAnalysisClient.requestJobStatus`. If current prefs are not enabled server mode, it returns an `inactive` ack and must not touch the backend client.

### Existing Late-Result Skip Behavior

`src/content/promo-skip-logic.ts:96` requires `prevTime < startSec && currentTime >= startSec`, and `tests/content/youtube-watch-skip-integration.test.ts:251` already proves late-arriving blocks do not retroactively seek. Issue 4 should preserve this logic and add a regression named for server job completion so the behavior is explicitly tied to this slice.

### Popup Status Gaps

`src/popup/PopupApp.tsx:280` already renders server `analyzing`, and `src/popup/PopupApp.tsx:308` renders server `error`. It does not yet have server-specific `no_promo` or `unavailable` branches before the Chrome provider availability branch at `src/popup/PopupApp.tsx:362`, so terminal server states can be hidden by Chrome Built-in setup state. Add server terminal branches and locale keys before provider-specific checks.

### Dependency Status

Issue `1-AFK` is `Validated`, issue `2-AFK` is `Validated`, and issue `3-AFK` is also `Validated`. This plan depends on the existing request contract, ready response delivery, and extension local result cache, but it does not require rate limiting, subtitle extraction, LLM analysis, or artifact persistence from future issues.

### Sub-Agent Availability

The requested explorer sub-agent is not callable in this session, so repository exploration was performed locally with `rg`, `sed`, and targeted `nl -ba` reads. No external research is needed because this issue is confined to local code and issue-owned API contract documentation.

## Entities

### Analysis Job

- **Fields**:
    - `jobId`: `string` - deterministic local id such as `local-dQw4w9WgXcQ-server-v1`.
    - `jobKey`: `string` - internal dedupe key `${videoId}:${algorithmVersion}` used to enforce one job record per algorithm version.
    - `videoId`: `string` - canonical YouTube-shaped id from the validated request.
    - `algorithmVersion`: `string` - must match `SERVER_ANALYSIS_ALGORITHM_VERSION`.
    - `pollAfterSec`: `number` - positive integer interval returned to the extension.
    - `createdAtMs`: `number` - local timestamp for deterministic tests and future diagnostics.
    - `terminalResponse`: `ReadyResponse | NoPromoResponse | UnavailableResponse | TerminalErrorResponse | null`.
- **Relationships**: Created by `BackendAnalysisApi` on cold miss; read by `GET /v1/analysis/jobs/{jobId}`; completed by the local fixture hook.
- **Validation**: Job creation only happens after `serverAnalysisRequestSchema` validates the request. `start` must first check the `jobKey`; if an active or terminal record already exists, it returns that record's current response and does not rewrite `createdAtMs`, `terminalResponse`, `joinedRequestCount`, or `jobId`. Terminal responses are parsed with the shared Valibot schemas before storage.
- **States**: `processing -> ready`, `processing -> no_promo`, `processing -> unavailable`, or `processing -> error`; repeated `start` calls preserve the current active or terminal state.

### Server Analysis Response

- **Fields**:
    - `ProcessingResponse`: existing non-terminal response with `jobId` and `pollAfterSec`.
    - `ReadyResponse`: existing terminal response with validated `promoBlocks`, `sourceResultId`, and freshness metadata.
    - `NoPromoResponse`: terminal clean result with `sourceResultId` and freshness metadata.
    - `UnavailableResponse`: terminal non-error failure with `reason` and user-safe `message`.
    - `TerminalErrorResponse`: terminal job failure with `error.code` and `error.message`.
- **Relationships**: Parsed by `ServerAnalysisClient` for both initial requests and status refreshes; mapped by `ServerAnalysisRuntimeMessages` into popup/content state.
- **Validation**: Every member is a strict Valibot object keyed by `status`. Ready blocks keep the existing finite timeline checks.
- **States**: `processing` is non-terminal; all other members are terminal.

### Fixture Completion Request

- **Fields**:
    - `status`: `'ready' | 'no_promo' | 'unavailable' | 'error'`.
- **Relationships**: Sent only to the local HTTP fixture route to move an in-memory job into a deterministic terminal state.
- **Validation**: Strict backend-only schema; unknown job ids return typed `job_not_found`.
- **States**: One request moves a processing job to the chosen terminal response; repeated calls return the already-stored terminal response.

### Server Polling State

- **Fields**:
    - `serverRequestedVideoId`: existing `YoutubeWatch` field preventing duplicate initial requests for one video.
    - `serverAnalysisPollTimerId`: new `number | null` content timer id for pending status refreshes.
    - `serverAnalysisPollingJobId`: new `string | null` active backend job id.
    - `serverAnalysisPollingVideoId`: new `string | null` video id paired with the active job id so stale timers can validate the current page before sending a refresh.
- **Relationships**: The content script schedules `REFRESH_SERVER_ANALYSIS_STATUS` runtime messages; the background fetches status and maps responses.
- **Validation**: Before scheduling or refreshing, content verifies the video id still equals `currentVideoId` and `shouldUseServerAnalysis(YoutubeWatch.prefs)` is true. On `PREFS_UPDATED`, content clears polling immediately when `shouldUseServerAnalysis(m.prefs)` is false. Background verifies current prefs are still enabled server mode before any job-status backend fetch, then verifies response `videoId` and `algorithmVersion` before delivery.
- **States**: idle -> scheduled -> refreshing -> scheduled, or idle after terminal/navigation/prefs change/background inactive ack.

## Contracts

Contract file: `.sdd/.current/issues/4-AFK/contracts/openapi.yaml`.

This issue extends the local backend API with:

- `POST /v1/analysis` creating a new processing job on first cold miss, returning the existing `202 ProcessingResponse` for duplicate active cold requests with the same `videoId` plus `algorithmVersion`, and returning the existing terminal `ReadyResponse | NoPromoResponse | UnavailableResponse | TerminalErrorResponse` for duplicate cold requests after fixture completion.
- `GET /v1/analysis/jobs/{jobId}` returning `202 ProcessingResponse` while the job is active and `200` terminal `ReadyResponse | NoPromoResponse | UnavailableResponse | TerminalErrorResponse` after completion.
- `POST /v1/analysis/jobs/{jobId}/fixture-result` as a local deterministic test hook with body `{ "status": "ready" | "no_promo" | "unavailable" | "error" }`.
- `ErrorResponse.error.code` gains `job_not_found` for unknown job ids.

No public production API hardening is included in this slice. The fixture completion endpoint is local development/test infrastructure only.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `.sdd/.current/issues/4-AFK/contracts/openapi.yaml` | Modify | Documents job polling, terminal responses, idempotent duplicate `POST /v1/analysis` responses, and the local fixture completion hook. |
| `src/shared/server-analysis-contract.ts` | Modify | Adds terminal response schemas/types and includes them in `serverAnalysisResponseSchema`. |
| `tests/shared/server-analysis-contract.test.ts` | Modify | Covers terminal response validation and union parsing. |
| `src/backend/analysis-jobs.ts` | Create | Owns the in-memory local job store, processing responses, status reads, and fixture terminal completion. |
| `tests/backend/analysis-jobs.test.ts` | Create | Verifies job creation, idempotent active/terminal `start` calls for the same video/version, processing reads, ready/no-promo/unavailable/error completion, and unknown job misses. |
| `src/backend/analysis-api.ts` | Modify | Creates or returns an in-memory job on cold miss and exposes job status/completion methods for the HTTP layer. |
| `tests/backend/analysis-api.test.ts` | Modify | Verifies cold miss creates a job, duplicate active cold requests return the existing job, duplicate terminal cold requests return the existing terminal response, status reads terminal results, and fixture completion returns typed states. |
| `src/backend/server.ts` | Modify | Routes `GET /v1/analysis/jobs/{jobId}` and `POST /v1/analysis/jobs/{jobId}/fixture-result`. |
| `tests/backend/server.test.ts` | Modify | Verifies HTTP status polling, fixture completion, and `job_not_found` responses. |
| `src/background/server-analysis-client.ts` | Modify | Adds `requestJobStatus(jobId)` and parses the extended response union. |
| `tests/background/server-analysis-client.test.ts` | Modify | Verifies GET status fetches, terminal parsing, and timeout behavior. |
| `src/shared/messages.ts` | Modify | Adds `REFRESH_SERVER_ANALYSIS_STATUS`, polling payload/response types, and terminal status acknowledgements. |
| `src/content/server-analysis-request.ts` | Modify | Adds a typed runtime message builder for job-status refreshes. |
| `tests/content/server-analysis-request.test.ts` | Modify | Covers the refresh message builder and finite-duration request behavior. |
| `src/background/messaging/server-analysis-runtime-messages.ts` | Modify | Handles initial analysis and status refresh with one guarded response mapper. |
| `tests/background/messaging/server-analysis-runtime-messages.test.ts` | Modify | Covers polling refresh, current-prefs guard before backend status fetches, terminal mapping, no delivery for non-ready terminals, and response guards. |
| `src/background/messaging/register-runtime-messages.ts` | Modify | Dispatches `REFRESH_SERVER_ANALYSIS_STATUS` to the server-analysis handler. |
| `src/content/youtube-watch.ts` | Modify | Schedules/cancels polling timers based on processing acks, navigation, terminal responses, inactive refresh acks, and `PREFS_UPDATED` changes that leave server mode. |
| `tests/content/youtube-watch-skip-integration.test.ts` | Modify | Adds an explicit server-late-result regression for already-passed block starts. |
| `src/popup/PopupApp.tsx` | Modify | Adds server no-promo and unavailable branches before provider availability checks. |
| `tests/popup/popup-view-model.test.ts` | Modify | Verifies server terminal states are visible and not hidden by Chrome provider availability. |
| `src/_locales/*/messages.json` | Modify | Adds server no-promo and unavailable popup strings to every locale, using English fallback text where translations are unavailable. |
| `e2e/extension.spec.ts` | Modify | Adds deterministic local backend tests for processing -> fixture ready -> status polling -> future skip only, plus clearing scheduled polling when a prefs update disables server analysis. |

## Tasks

### [x] Task 1: Extend Shared Server Response Contracts

**Files:**

- Modify: `src/shared/server-analysis-contract.ts`
- Modify: `tests/shared/server-analysis-contract.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import {
    noPromoResponseSchema,
    terminalErrorResponseSchema,
    unavailableResponseSchema,
} from '@/shared/server-analysis-contract';

it('parses terminal job responses through the server response union', () => {
    expect(
        v.parse(serverAnalysisResponseSchema, {
            status: 'no_promo',
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            sourceResultId: 'result-dQw4w9WgXcQ-server-v1',
            freshness: { expiresAtMs: 4_102_444_800_000 },
        }).status,
    ).toBe('no_promo');

    expect(
        v.parse(serverAnalysisResponseSchema, {
            status: 'unavailable',
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            reason: 'fixture_unavailable',
            message: 'Fixture analysis is unavailable.',
        }).status,
    ).toBe('unavailable');

    expect(
        v.parse(serverAnalysisResponseSchema, {
            status: 'error',
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            error: {
                code: 'fixture_error',
                message: 'Fixture job failed.',
            },
        }).status,
    ).toBe('error');
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/shared/server-analysis-contract.test.ts`

Expected: FAIL with missing exports for `noPromoResponseSchema`, `unavailableResponseSchema`, and `terminalErrorResponseSchema`.

- [x] **Step 3: Write minimal implementation**

Add strict schemas and inferred types:

```ts
export const noPromoResponseSchema = v.strictObject({
    status: v.literal('no_promo'),
    videoId: youtubeVideoIdSchema,
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    sourceResultId: v.pipe(v.string(), v.minLength(1)),
    freshness: readyResponseFreshnessSchema,
});

export const unavailableResponseSchema = v.strictObject({
    status: v.literal('unavailable'),
    videoId: youtubeVideoIdSchema,
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    reason: v.literal('fixture_unavailable'),
    message: v.pipe(v.string(), v.minLength(1)),
});

export const terminalErrorResponseSchema = v.strictObject({
    status: v.literal('error'),
    videoId: youtubeVideoIdSchema,
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    error: v.strictObject({
        code: v.literal('fixture_error'),
        message: v.pipe(v.string(), v.minLength(1)),
    }),
});

export const serverAnalysisResponseSchema = v.union([
    processingResponseSchema,
    readyResponseSchema,
    noPromoResponseSchema,
    unavailableResponseSchema,
    terminalErrorResponseSchema,
]);
```

Also add `job_not_found` to `errorResponseSchema.error.code`.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/shared/server-analysis-contract.test.ts`

Expected: PASS.

**Verification**: All successful server states parse through one shared union, and unknown job errors have a typed code.

### [x] Task 2: Add the In-Memory Backend Job Store

**Files:**

- Create: `src/backend/analysis-jobs.ts`
- Create: `tests/backend/analysis-jobs.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import { BackendAnalysisJobs } from '@/backend/analysis-jobs';

it('creates a processing job and later completes it as ready', () => {
    BackendAnalysisJobs.resetForTests();

    const processing = BackendAnalysisJobs.start({
        videoId: 'dQw4w9WgXcQ',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        nowMs: 1_900_000_000_000,
    });

    expect(processing.status).toBe('processing');
    expect(BackendAnalysisJobs.getStatus(processing.jobId)).toEqual(processing);

    const ready = BackendAnalysisJobs.completeFixture({
        jobId: processing.jobId,
        status: 'ready',
        nowMs: 1_900_000_001_000,
    });

    expect(ready?.status).toBe('ready');
    expect(BackendAnalysisJobs.getStatus(processing.jobId)).toEqual(ready);
});

it('returns the same active job for duplicate cold starts', () => {
    BackendAnalysisJobs.resetForTests();

    const first = BackendAnalysisJobs.start({
        videoId: 'dQw4w9WgXcQ',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        nowMs: 1_900_000_000_000,
    });
    const second = BackendAnalysisJobs.start({
        videoId: 'dQw4w9WgXcQ',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        nowMs: 1_900_000_009_000,
    });

    expect(second).toEqual(first);
    expect(second.status).toBe('processing');
});

it('does not reset a terminal job on duplicate cold starts', () => {
    BackendAnalysisJobs.resetForTests();

    const processing = BackendAnalysisJobs.start({
        videoId: 'dQw4w9WgXcQ',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        nowMs: 1_900_000_000_000,
    });
    const terminal = BackendAnalysisJobs.completeFixture({
        jobId: processing.jobId,
        status: 'no_promo',
        nowMs: 1_900_000_001_000,
    });
    const duplicate = BackendAnalysisJobs.start({
        videoId: 'dQw4w9WgXcQ',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        nowMs: 1_900_000_010_000,
    });

    expect(duplicate).toEqual(terminal);
    expect(BackendAnalysisJobs.getStatus(processing.jobId)).toEqual(terminal);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/backend/analysis-jobs.test.ts`

Expected: FAIL because `src/backend/analysis-jobs.ts` does not exist.

- [x] **Step 3: Write minimal implementation**

Create a static-only class with a private `Map<string, AnalysisJobRecord>` by `jobId` plus a private `Map<string, string>` from `jobKey` to `jobId`, where `jobKey` is the string `${videoId}:${algorithmVersion}`. Add `start`, `getStatus`, `completeFixture`, and `resetForTests`. `start` must check the key map before creating a record; for an active job it returns the stored `ProcessingResponse`, and for a terminal job it returns the stored terminal response without changing the record. Use `v.parse(processingResponseSchema, ...)` and `v.parse(readyResponseSchema | noPromoResponseSchema | unavailableResponseSchema | terminalErrorResponseSchema, ...)` at creation time. Use deterministic fixture ready blocks:

```ts
promoBlocks: [
    { startSec: 4, endSec: 24, confidence: 'high' },
    { startSec: 35, endSec: 45, confidence: 'medium' },
],
```

The first block is intentionally early so tests can prove late results do not fire it; the second block is a future crossing for E2E.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/backend/analysis-jobs.test.ts`

Expected: PASS.

**Verification**: Cold jobs are represented in memory, duplicate starts join the existing active or terminal record, and fixture jobs can reach every terminal state without extraction or LLM work.

### [x] Task 3: Wire Jobs Into the Backend API

**Files:**

- Modify: `src/backend/analysis-api.ts`
- Modify: `tests/backend/analysis-api.test.ts`

- [x] **Step 1: Write the failing test**

```ts
it('creates a local job for an uncached valid request', () => {
    BackendAnalysisJobs.resetForTests();

    const response = BackendAnalysisApi.handleAnalysisRequest({
        videoId: 'dQw4w9WgXcQ',
        extensionVersion: '0.1.0',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        client: {
            source: 'chrome-extension',
            capabilities: ['processing-status'],
        },
    });

    expect(response.statusCode).toBe(202);
    expect(response.body.status).toBe('processing');
    if (response.body.status !== 'processing') {
        throw new Error('Expected processing response.');
    }
    expect(
        BackendAnalysisApi.handleJobStatusRequest(response.body.jobId).body,
    ).toEqual(response.body);
});

it('returns the existing active job for duplicate cold analysis requests', () => {
    BackendAnalysisJobs.resetForTests();

    const request = {
        videoId: 'dQw4w9WgXcQ',
        extensionVersion: '0.1.0',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        client: {
            source: 'chrome-extension',
            capabilities: ['processing-status'],
        },
    };

    const first = BackendAnalysisApi.handleAnalysisRequest(request);
    const second = BackendAnalysisApi.handleAnalysisRequest(request);

    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.body).toEqual(first.body);
});

it('returns the existing terminal job for duplicate cold analysis requests', () => {
    BackendAnalysisJobs.resetForTests();

    const request = {
        videoId: 'dQw4w9WgXcQ',
        extensionVersion: '0.1.0',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        client: {
            source: 'chrome-extension',
            capabilities: ['processing-status'],
        },
    };

    const first = BackendAnalysisApi.handleAnalysisRequest(request);
    if (first.body.status !== 'processing') {
        throw new Error('Expected processing response.');
    }
    const terminal = BackendAnalysisApi.handleFixtureCompletionRequest(
        first.body.jobId,
        { status: 'unavailable' },
    );
    const duplicate = BackendAnalysisApi.handleAnalysisRequest(request);

    expect(terminal.statusCode).toBe(200);
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.body).toEqual(terminal.body);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/backend/analysis-api.test.ts`

Expected: FAIL because `BackendAnalysisApi.handleJobStatusRequest` does not exist and cold requests are not backed by a job store.

- [x] **Step 3: Write minimal implementation**

Replace the current cold-miss `v.parse(processingResponseSchema, ...)` block at `src/backend/analysis-api.ts:91` with `BackendAnalysisJobs.start(...)`. Update `BackendApiResult` so `200` can carry `ReadyResponse | NoPromoResponse | UnavailableResponse | TerminalErrorResponse` when a duplicate request finds a terminal in-memory job. Add:

```ts
static handleJobStatusRequest(jobId: string): BackendApiResult
static handleFixtureCompletionRequest(jobId: string, raw: unknown): BackendApiResult
```

Return `404` with `job_not_found` for unknown jobs. Keep the seeded ready-cache path at `src/backend/analysis-api.ts:83` before job creation. Map `BackendAnalysisJobs.start(...)` responses to HTTP `202` for `processing` and HTTP `200` for terminal states.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/backend/analysis-api.test.ts`

Expected: PASS.

**Verification**: A cold miss now creates a pollable local job, duplicate cold requests do not reset active or terminal state, and the existing seeded cache hit still bypasses job creation.

### [x] Task 4: Add HTTP Job Status and Fixture Routes

**Files:**

- Modify: `src/backend/server.ts`
- Modify: `tests/backend/server.test.ts`

- [x] **Step 1: Write the failing test**

```ts
it('polls and completes a local analysis job over HTTP', async () => {
    const server = BackendHttpServer.create();
    servers.push(server);
    await listenOnEphemeralPort(server);
    const baseUrl = localServerUrl(server);

    const initial = await postJson(`${baseUrl}/v1/analysis`, {
        videoId: 'dQw4w9WgXcQ',
        extensionVersion: '0.1.0',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        client: {
            source: 'chrome-extension',
            capabilities: ['processing-status'],
        },
    });

    expect(initial.status).toBe(202);
    const processing = await initial.json();

    const statusBefore = await fetch(
        `${baseUrl}/v1/analysis/jobs/${processing.jobId}`,
    );
    expect(statusBefore.status).toBe(202);

    const completed = await postJson(
        `${baseUrl}/v1/analysis/jobs/${processing.jobId}/fixture-result`,
        { status: 'ready' },
    );
    expect(completed.status).toBe(200);

    const statusAfter = await fetch(
        `${baseUrl}/v1/analysis/jobs/${processing.jobId}`,
    );
    expect(statusAfter.status).toBe(200);
    await expect(statusAfter.json()).resolves.toMatchObject({
        status: 'ready',
        videoId: 'dQw4w9WgXcQ',
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/backend/server.test.ts`

Expected: FAIL because the HTTP server returns `404 Unknown route` for both job routes.

- [x] **Step 3: Write minimal implementation**

Parse `req.url` with `new URL(req.url ?? '/', 'http://127.0.0.1')`, route:

- `GET /v1/analysis/jobs/{jobId}` -> `BackendAnalysisApi.handleJobStatusRequest(decodeURIComponent(jobId))`
- `POST /v1/analysis/jobs/{jobId}/fixture-result` -> existing `readJsonBody` then `BackendAnalysisApi.handleFixtureCompletionRequest(...)`

Keep `POST /v1/analysis` validation and seeded-cache priority unchanged. For uncached requests, route through `BackendAnalysisJobs.start(...)` so duplicate active requests return the existing `202 ProcessingResponse` and duplicate terminal requests return the existing terminal body with `200`.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/backend/server.test.ts`

Expected: PASS.

**Verification**: Manual local workflow has a concrete HTTP way to start, poll, and fixture-complete a job.

### [x] Task 5: Add Background Job Status Client

**Files:**

- Modify: `src/background/server-analysis-client.ts`
- Modify: `tests/background/server-analysis-client.test.ts`

- [x] **Step 1: Write the failing test**

```ts
it('gets job status from the local backend', async () => {
    fetchMock.mockResolvedValue(
        new Response(
            JSON.stringify({
                status: 'no_promo',
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: 'server-v1',
                sourceResultId: 'result-dQw4w9WgXcQ-server-v1',
                freshness: { expiresAtMs: 4_102_444_800_000 },
            }),
            {
                status: 200,
                headers: { 'content-type': MIME_APPLICATION_JSON },
            },
        ),
    );

    const response = await ServerAnalysisClient.requestJobStatus(
        'local-dQw4w9WgXcQ-server-v1',
    );

    expect(response.status).toBe('no_promo');
    expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:8787/v1/analysis/jobs/local-dQw4w9WgXcQ-server-v1',
        expect.objectContaining({ method: 'GET' }),
    );
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/background/server-analysis-client.test.ts`

Expected: FAIL because `requestJobStatus` does not exist.

- [x] **Step 3: Write minimal implementation**

Add `static async requestJobStatus(jobId: string): Promise<ServerAnalysisResponse>`. Use `encodeURIComponent(jobId)`, `accept: MIME_APPLICATION_JSON`, the same timeout policy as `requestAnalysis`, and `v.parse(serverAnalysisResponseSchema, json)`.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/background/server-analysis-client.test.ts`

Expected: PASS.

**Verification**: The background client can parse every terminal state through the same contract as initial analysis responses.

### [x] Task 6: Add Runtime Status Refresh Messages

**Files:**

- Modify: `src/shared/messages.ts`
- Modify: `src/content/server-analysis-request.ts`
- Modify: `tests/content/server-analysis-request.test.ts`

- [x] **Step 1: Write the failing test**

```ts
it('builds a server analysis status refresh message', () => {
    expect(
        buildRefreshServerAnalysisStatusMessage({
            videoId: 'dQw4w9WgXcQ',
            jobId: 'local-dQw4w9WgXcQ-server-v1',
        }),
    ).toEqual({
        type: TOPSKIP_MESSAGE.REFRESH_SERVER_ANALYSIS_STATUS,
        payload: {
            videoId: 'dQw4w9WgXcQ',
            jobId: 'local-dQw4w9WgXcQ-server-v1',
        },
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/content/server-analysis-request.test.ts`

Expected: FAIL because the message type and helper do not exist.

- [x] **Step 3: Write minimal implementation**

In `TOPSKIP_MESSAGE`, add `REFRESH_SERVER_ANALYSIS_STATUS: 'TOPSKIP_REFRESH_SERVER_ANALYSIS_STATUS'`. Add:

```ts
export type RefreshServerAnalysisStatusPayload = {
    videoId: string;
    jobId: string;
};

export type ServerAnalysisTerminalStatus =
    | 'ready'
    | 'no_promo'
    | 'unavailable'
    | 'error';

export type RequestServerAnalysisResponse =
    | { ok: true; status: 'processing'; jobId: string; pollAfterSec: number }
    | { ok: true; status: 'inactive' }
    | { ok: true; status: ServerAnalysisTerminalStatus }
    | { ok: false; error: string };
```

Use the same response type for `RefreshServerAnalysisStatusResponse`, and add the runtime union member. `inactive` is a no-op ack used when current prefs no longer allow server analysis; content must treat it as a stop signal and must not reschedule polling. In `src/content/server-analysis-request.ts`, add `buildRefreshServerAnalysisStatusMessage`.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/content/server-analysis-request.test.ts`

Expected: PASS.

**Verification**: Content can schedule typed refresh messages without direct backend access.

### [x] Task 7: Map Status Refreshes in Background Runtime

**Files:**

- Modify: `src/background/messaging/server-analysis-runtime-messages.ts`
- Modify: `src/background/messaging/register-runtime-messages.ts`
- Modify: `tests/background/messaging/server-analysis-runtime-messages.test.ts`

- [x] **Step 1: Write the failing test**

```ts
it('refreshes a processing job and delivers ready blocks', async () => {
    const blocks: PromoBlock[] = [
        { startSec: 4, endSec: 24, confidence: 'high' },
        { startSec: 35, endSec: 45, confidence: 'medium' },
    ];
    clientMocks.requestJobStatus.mockResolvedValueOnce({
        status: 'ready',
        videoId: 'dQw4w9WgXcQ',
        algorithmVersion: 'server-v1',
        source: 'server_cache',
        sourceResultId: 'result-dQw4w9WgXcQ-server-v1',
        freshness: { expiresAtMs: 4_102_444_800_000 },
        promoBlocks: blocks,
    });

    const result = await ServerAnalysisRuntimeMessages.handleRefreshStatus(
        {
            videoId: 'dQw4w9WgXcQ',
            jobId: 'local-dQw4w9WgXcQ-server-v1',
        },
        { tab: { id: 42 } } as never,
    );

    expect(result).toEqual({ ok: true, status: 'ready' });
    expect(browserMocks.tabsSendMessage).toHaveBeenCalledWith(42, {
        type: TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED,
        videoId: 'dQw4w9WgXcQ',
        promoBlocks: blocks,
    });
});

it('does not fetch job status when current prefs leave server mode', async () => {
    prefsMocks.load.mockResolvedValueOnce({
        enabled: true,
        providerId: 'openrouter',
        activeModelId: 'openrouter:google/gemini-3.1-pro-preview',
        analysisMode: 'byok',
    });

    const result = await ServerAnalysisRuntimeMessages.handleRefreshStatus(
        {
            videoId: 'dQw4w9WgXcQ',
            jobId: 'local-dQw4w9WgXcQ-server-v1',
        },
        { tab: { id: 42 } } as never,
    );

    expect(result).toEqual({ ok: true, status: 'inactive' });
    expect(clientMocks.requestJobStatus).not.toHaveBeenCalled();
    expect(browserMocks.tabsSendMessage).not.toHaveBeenCalled();
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/background/messaging/server-analysis-runtime-messages.test.ts`

Expected: FAIL because `handleRefreshStatus` and `ServerAnalysisClient.requestJobStatus` are not wired into the mocked handler.

- [x] **Step 3: Write minimal implementation**

Refactor response mapping into a private helper:

```ts
private static async applyServerResponse(input: {
    tabId: number;
    requestedVideoId: string;
    response: ServerAnalysisResponse;
}): Promise<RequestServerAnalysisResponse>
```

The helper must:

- reject mismatched `videoId`
- reject mismatched `algorithmVersion`
- for `processing`, set `PromoDetectionStore` to `{ status: 'analyzing', source: 'server' }` and return `jobId` plus `pollAfterSec`
- for `ready`, save cache non-fatally, deliver blocks, and return `ready`
- for `no_promo`, set `{ status: 'no_promo', source: 'server' }` and return `no_promo`
- for `unavailable`, set `{ status: 'unavailable', source: 'server', error: response.message }` and return `unavailable`
- for `error`, set `{ status: 'error', source: 'server', error: response.error.message }` and return `error`

Add a private helper such as `loadServerModeActive()` that calls `PrefsSyncStorage.ready()`, then `PrefsSyncStorage.load()`, and returns `prefs.enabled && prefs.analysisMode === ANALYSIS_MODE.Server`. Use it in both `handleRequest` and `handleRefreshStatus`. `handleRefreshStatus(payload, sender)` must validate `sender.tab?.id`, call the prefs helper, return `{ ok: true, status: 'inactive' }` when server mode is not currently active, and only then call `ServerAnalysisClient.requestJobStatus(payload.jobId)` plus `applyServerResponse`. Register the new message in `register-runtime-messages.ts`.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/background/messaging/server-analysis-runtime-messages.test.ts`

Expected: PASS.

**Verification**: Initial and polling responses share one guard and terminal-state mapping path, and a stale refresh message cannot reach the backend after the user disables TopSkip or switches to private BYOK mode.

### [x] Task 8: Poll From the Watch Content Script

**Files:**

- Modify: `src/content/youtube-watch.ts`
- Modify: `e2e/extension.spec.ts`

- [x] **Step 1: Write the failing test**

Add a Playwright test that starts a local backend, returns `processing` for a cold video, waits for the extension to poll `GET /v1/analysis/jobs/{jobId}`, triggers `POST /fixture-result` with `{ "status": "ready" }`, and then confirms playback skips only at the future fixture block start. The test should fail initially because no polling request is made after the first `processing` ack.

Add a second Playwright regression that returns `processing` with a short `pollAfterSec`, disables TopSkip from the popup before the first poll fires, and asserts the backend never receives `GET /v1/analysis/jobs/{jobId}` after the `PREFS_UPDATED` broadcast. The test should fail initially because there is no content-owned polling timer yet and no explicit prefs-update cancellation logic exists.

Run: `pnpm run test:e2e -- e2e/extension.spec.ts`

Expected: FAIL with the test timing out while waiting for `GET /v1/analysis/jobs/local-dQw4w9WgXcQ-server-v1`.

- [x] **Step 2: Write minimal implementation**

In `YoutubeWatch`, add:

```ts
private static serverAnalysisPollTimerId: number | null = null;
private static serverAnalysisPollingJobId: string | null = null;
private static serverAnalysisPollingVideoId: string | null = null;
```

Add `clearServerAnalysisPolling`, `scheduleServerAnalysisStatusRefresh`, and `handleServerAnalysisResponse`. `requestServerAnalysis` should await `browser.runtime.sendMessage(...)`, pass the response to `handleServerAnalysisResponse`, and schedule the next refresh only when the response is `{ ok: true, status: 'processing' }`. `resetForNewVideo` must call `clearServerAnalysisPolling`.

The scheduled refresh must check `videoId === YoutubeWatch.currentVideoId` and `YoutubeWatch.prefs !== null && shouldUseServerAnalysis(YoutubeWatch.prefs)` before sending a runtime message. If the response is terminal, `inactive`, or false, clear the timer/job id/video id and do not reschedule. In `onPrefsUpdatedMessage`, assign `YoutubeWatch.prefs = m.prefs`, call `clearServerAnalysisPolling()` immediately when `shouldUseServerAnalysis(m.prefs)` is false, then call `syncVideoBinding()`.

- [x] **Step 3: Run test to verify it passes**

Run: `pnpm run test:e2e -- e2e/extension.spec.ts`

Expected: PASS for the new polling and prefs-update cancellation tests.

**Verification**: The open watch page drives polling while the background remains the only backend client, and prefs updates stop content-owned polling before a disabled/private-mode page can send another refresh.

### [x] Task 9: Preserve Late-Arriving Block Semantics

**Files:**

- Modify: `tests/content/youtube-watch-skip-integration.test.ts`

- [x] **Step 1: Write the regression test**

Add a named regression for server job completion:

```ts
it('server ready blocks arriving after an early start only apply future crossings', () => {
    const fired = new Set<number>();
    const blocks: PromoBlock[] = [
        { startSec: 4, endSec: 24 },
        { startSec: 35, endSec: 45 },
    ];

    const early = simulateTimeUpdate({
        prevTime: 12,
        currentTime: 12.5,
        duration: 120,
        isSeeking: false,
        firedStartKeys: fired,
        blocks,
    });
    expect(early.action).toBe('none');

    const future = simulateTimeUpdate({
        prevTime: 34.5,
        currentTime: 35.2,
        duration: 120,
        isSeeking: false,
        firedStartKeys: fired,
        blocks,
    });
    expect(future).toEqual({ action: 'skip', blockIndex: 1, targetTime: 45 });
});
```

- [x] **Step 2: Run test to verify existing behavior stays intact**

Run: `pnpm run test tests/content/youtube-watch-skip-integration.test.ts`

Expected: PASS. If it fails, do not change the skip predicate to retroactively fire already-passed starts; fix only the regression introduced by polling work.

**Verification**: Acceptance criterion 4 is pinned to server-ready results and remains enforced by existing pure skip logic.

### [x] Task 10: Surface Server Terminal States in Popup

**Files:**

- Modify: `src/popup/PopupApp.tsx`
- Modify: `tests/popup/popup-view-model.test.ts`
- Modify: `src/_locales/*/messages.json`

- [x] **Step 1: Write the failing test**

```ts
it.each(['downloading', 'unavailable', 'downloadable'] as const)(
    'server no-promo terminal state takes precedence over Chrome %s state',
    (chromeModelAvailability) => {
        const vm = buildPopupViewModel({
            ...baseArgs,
            providerId: 'chrome-prompt-api',
            providerDisplayName: 'Chrome Built-in',
            modelDisplayName: 'Gemini Nano',
            chromeModelAvailability,
            detectionState: {
                videoId: 'dQw4w9WgXcQ',
                status: 'no_promo',
                source: 'server',
            },
        });

        expect(vm.title).toBe('Server analysis complete');
        expect(vm.statusHeadline).toBe('No server promo blocks detected.');
    },
);
```

Add a companion test for `{ status: 'unavailable', source: 'server', error: 'Fixture analysis is unavailable.' }`.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/popup/popup-view-model.test.ts`

Expected: FAIL because Chrome provider availability branches still take precedence over server no-promo/unavailable states.

- [x] **Step 3: Write minimal implementation**

Before the Chrome provider availability branch, add source-specific branches:

- `detectionState.status === 'no_promo' && detectionState.source === 'server'`
- `detectionState.status === 'unavailable' && detectionState.source === 'server'`

Use new locale keys:

- `popup_detection_server_no_promo_badge`
- `popup_detection_server_no_promo_title`
- `popup_detection_server_no_promo_description`
- `popup_detection_server_no_promo_headline`
- `popup_detection_server_no_promo_body`
- `popup_detection_server_unavailable_badge`
- `popup_detection_server_unavailable_title`
- `popup_detection_server_unavailable_description`
- `popup_detection_server_unavailable_headline`
- `popup_detection_server_unavailable_body`

Add these keys to every locale file under `src/_locales/*/messages.json`, using the English message consistently where translations are not available.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/popup/popup-view-model.test.ts`

Expected: PASS.

**Verification**: Server terminal statuses remain visible even when private-provider setup state exists.

### [x] Task 11: Run Focused and Full Verification

**Files:**

- No source file changes in this task.

- [x] **Step 1: Run focused unit tests**

Run:

```bash
pnpm run test tests/shared/server-analysis-contract.test.ts \
  tests/backend/analysis-jobs.test.ts \
  tests/backend/analysis-api.test.ts \
  tests/backend/server.test.ts \
  tests/background/server-analysis-client.test.ts \
  tests/background/messaging/server-analysis-runtime-messages.test.ts \
  tests/content/server-analysis-request.test.ts \
  tests/content/youtube-watch-skip-integration.test.ts \
  tests/popup/popup-view-model.test.ts
```

Expected: PASS.

- [x] **Step 2: Run build and lint gates**

Run:

```bash
pnpm run lint
pnpm run build
```

Expected: PASS.

- [x] **Step 3: Run E2E**

Run:

```bash
pnpm run test:e2e
```

Expected: PASS, including the processing -> fixture-ready polling flow and the prefs-update polling cancellation regression.

**Verification**: The full issue slice is green locally and ready for issue validation.

## Self-Review

- **Acceptance criterion 1**: Covered by Tasks 2, 3, and 4. A cold miss creates an in-memory job and returns `processing` with `jobId` and `pollAfterSec`; duplicate active cold requests return the same processing job without resetting it.
- **Acceptance criterion 2**: Covered by Task 7 and existing popup branch at `src/popup/PopupApp.tsx:280`. Processing responses set `PromoDetectionStore` to `{ status: 'analyzing', source: 'server' }`.
- **Acceptance criterion 3**: Covered by Tasks 4, 5, 7, and 8. The extension polls status through runtime messages; terminal ready responses are saved and delivered through `PROMO_BLOCKS_DETECTED`; stale polling is stopped by both content-side prefs updates and background-side current-prefs checks.
- **Acceptance criterion 4**: Covered by Task 9 and the E2E scenario in Task 8. Late ready blocks do not fire already-passed starts; future block crossings still skip.
- **Dependencies**: `1-AFK`, `2-AFK`, and `3-AFK` are `Validated`, so the plan can rely on request contracts, ready delivery, and local ready-result cache behavior.
- **Contracts**: `.sdd/.current/issues/4-AFK/contracts/openapi.yaml` defines all new endpoint and response shapes. No GraphQL contract is needed.
- **Review finding 1 resolved**: The high-severity polling/privacy finding is addressed by the Server-Mode Preference Guards research section, Task 6's `inactive` runtime ack, Task 7's `handleRefreshStatus` current-prefs guard before `ServerAnalysisClient.requestJobStatus`, and Task 8's `PREFS_UPDATED` timer cancellation requirement and E2E regression.
- **Review finding 2 resolved**: The medium-severity duplicate-job finding is addressed by the Analysis Job entity validation, Task 2's active and terminal duplicate `BackendAnalysisJobs.start` tests, Task 3's duplicate cold-request API tests, and the updated `.sdd/.current/issues/4-AFK/contracts/openapi.yaml` `/v1/analysis` responses.
- **Scope control**: Rate limiting belongs to `5-AFK`; subtitle extraction belongs to `6-AFK`; LLM analysis belongs to `7-AFK`; artifact persistence belongs to `8-AFK`. This plan uses only deterministic fixture completion for terminal job states.
