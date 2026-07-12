# Implementation Plan: Failure and no-promo states end-to-end

- **Created**: 2026-07-08
- **Status**: Approved
- **Issue**: `.sdd/.current/issues/9-AFK/issue.md`
- **PRD**: `.sdd/.current/prd.md`
- **Model**: GPT-5 Codex
- **User Input**: `ISSUE_ID=9-AFK`, `SPECS_DIR=.sdd/.current`; no additional constraints

## Summary

Complete the server-mode non-happy paths so backend terminal states, HTTP rate limits, invalid backend responses, network failures, popup status, and content-script skip behavior stay consistent. The codebase already contains server terminal response shapes for `no_promo`, `unavailable`, and `error`; this slice hardens the remaining gaps by treating `rate_limited` as a validated server response, mapping retryable failures into an explicit no-skip server state, and adding regression coverage proving only `ready` responses with valid promo blocks reach the content script.

## Technical Context

- **Language/Version**: TypeScript 5.x in strict ESM mode on Node.js 20+.
- **Primary Dependencies**: Valibot for contracts, React 19/Mantine 9/MobX for popup UI, `webextension-polyfill` for extension APIs, Node `http` for the local backend.
- **Storage**: `browser.storage.local` through background-owned storage helpers only; local server artifacts are currently process-local/in-memory.
- **Testing**: Vitest unit tests under `tests/**`; Playwright E2E exists but this issue can be covered by focused unit/integration tests.
- **Target Platform**: Chrome MV3 extension plus local development backend at `http://127.0.0.1:8787`.

## Research

### Server Response Contract

`src/shared/server-analysis-contract.ts:126` defines `no_promo`, `src/shared/server-analysis-contract.ts:150` defines `unavailable`, and `src/shared/server-analysis-contract.ts:178` defines terminal `error`. `rateLimitedResponseSchema` exists at `src/shared/server-analysis-contract.ts:191`, but `serverAnalysisResponseSchema` at `src/shared/server-analysis-contract.ts:203` omits it, so the background client cannot validate a backend `429` body as a typed retryable state.

### Backend API and Rate Limit

`src/backend/api-protection.ts:78` denies cold starts after the local fixed-window quota, and `src/backend/analysis-api.ts:137` converts that decision into `{ statusCode: 429, body: rate_limited }`. Because the extension client currently throws on all non-2xx responses in `src/background/server-analysis-client.ts:86`, rate limits become generic HTTP errors instead of structured popup state.

### Runtime Mapping and Content Delivery

`ServerAnalysisRuntimeMessages.applyServerResponse` at `src/background/messaging/server-analysis-runtime-messages.ts:109` sends `PROMO_BLOCKS_DETECTED` only for `ready`. Existing tests at `tests/background/messaging/server-analysis-runtime-messages.test.ts:352` cover `no_promo`, `unavailable`, and `error` during status refresh, but there is no request-path `rate_limited` coverage and no network/invalid-response tests that assert no content delivery.

### Popup Status

`buildPopupViewModel` in `src/popup/PopupApp.tsx:280` already has server-specific branches for pending, error, cache-hit, no-promo, and unavailable states. Rate-limited responses should reuse server `unavailable` or server `error` copy with a retryable message; no new UI surface is required unless the implementation introduces a distinct serialized popup status.

### Skip Invariant

The content skip loop evaluates only its current `PromoBlock[]`. `tests/content/youtube-watch-skip-integration.test.ts:96` already proves an empty block list produces no skip. This issue should add explicit server-terminal wording to that regression so future server non-ready handling cannot accidentally populate blocks.

## Entities

### ServerAnalysisResponse

- **Fields**:
    - `status`: `'processing' | 'ready' | 'no_promo' | 'unavailable' | 'error' | 'rate_limited'` after this issue.
    - `videoId`: YouTube video ID for metadata-bearing video-specific states; omitted for `rate_limited`.
    - `algorithmVersion`: server algorithm/cache version for metadata-bearing video-specific states; omitted for `rate_limited`.
    - `promoBlocks`: non-empty normalized blocks, present only on `ready`.
    - `reason` / `message`: unavailable reason and user-safe message.
    - `error.code` / `error.message`: terminal or retryable error detail.
    - `retryAfterSec`: positive integer retry hint for `rate_limited`.
- **Relationships**: Produced by backend API and consumed by `ServerAnalysisClient` and `ServerAnalysisRuntimeMessages`.
- **Validation**: Valibot validates all untrusted backend JSON before runtime mapping.
- **States**: `processing` polls; `ready` delivers blocks; `no_promo`, `unavailable`, `error`, and `rate_limited` must not deliver blocks.

### PromoDetectionStatePayload

- **Fields**:
    - `videoId`: active watch video.
    - `status`: popup-visible detection status.
    - `source`: `'server' | 'server_cache' | 'local_cache' | 'local_provider'`.
    - `promoBlocks`: present only when status is `detected`.
    - `error`: optional user-safe status detail.
- **Relationships**: Stored in background memory by `PromoDetectionStore`, rendered by `buildPopupViewModel`.
- **Validation**: Compile-time TypeScript type only; runtime payloads are internal extension messages.
- **States**: Server terminal non-ready states must omit `promoBlocks`.

## Contracts

No external OpenAPI file is required for this issue. Update the existing Valibot contract in `src/shared/server-analysis-contract.ts` so `rateLimitedResponseSchema` participates in the response union consumed by the background client, and update `src/shared/messages.ts` response status types if `rate_limited` is surfaced across the content/background runtime ack.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/shared/server-analysis-contract.ts` | Modify | Include `rate_limited` in the validated server response union and exported `ServerAnalysisResponse` type. |
| `src/shared/messages.ts` | Modify | Add `rate_limited` to server-analysis ack statuses if runtime handlers return it to content. |
| `src/background/server-analysis-client.ts` | Modify | Parse valid `429` rate-limit JSON as a typed response while continuing to reject invalid JSON, malformed success bodies, and non-rate-limit HTTP errors. |
| `src/background/messaging/server-analysis-runtime-messages.ts` | Modify | Map `rate_limited`, network failures, and invalid backend responses to popup state without sending promo blocks or triggering BYOK fallback. |
| `src/popup/PopupApp.tsx` | Modify if needed | Reuse existing server unavailable/error UI for retryable rate-limit copy; add no new visual pattern unless required by tests. |
| `tests/shared/server-analysis-contract.test.ts` | Modify | Cover `rate_limited` in the server response union and reject malformed retry metadata. |
| `tests/background/server-analysis-client.test.ts` | Modify | Cover valid 429 parsing, invalid 429 body rejection, invalid success body rejection, and network failure behavior. |
| `tests/backend/analysis-api.test.ts` | Modify | Cover local cold-start rate limit and assert no new job starts after denial. |
| `tests/background/messaging/server-analysis-runtime-messages.test.ts` | Modify | Cover request and refresh handling for `no_promo`, `unavailable`, `error`, `rate_limited`, network failure, and invalid backend response with no content delivery. |
| `tests/popup/popup-view-model.test.ts` | Modify if needed | Cover rate-limit/unavailable copy if runtime maps it to a distinct message. |
| `tests/content/youtube-watch-skip-integration.test.ts` | Modify | Add explicit server terminal non-ready no-skip regression over empty blocks. |

## Tasks

### [x] Task 1: Shared Rate-Limited Contract

**Files:**

- Modify: `src/shared/server-analysis-contract.ts`
- Test: `tests/shared/server-analysis-contract.test.ts`

- [x] **Step 1: Write the failing test**

```ts
it('parses rate-limited responses through the server response union', () => {
    const parsed = v.parse(serverAnalysisResponseSchema, {
        status: 'rate_limited',
        retryAfterSec: 60,
        error: {
            code: 'rate_limited',
            message: 'Local cold-analysis limit reached. Retry later.',
        },
    });

    expect(parsed.status).toBe('rate_limited');
});

it('rejects malformed rate-limit retry metadata', () => {
    expect(
        v.safeParse(serverAnalysisResponseSchema, {
            status: 'rate_limited',
            retryAfterSec: 0,
            error: {
                code: 'rate_limited',
                message: 'Retry later.',
            },
        }).success,
    ).toBe(false);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run tests/shared/server-analysis-contract.test.ts`
Expected: FAIL because `serverAnalysisResponseSchema` does not accept `rate_limited`.

- [x] **Step 3: Write minimal implementation**

Add `rateLimitedResponseSchema` to the `serverAnalysisResponseSchema` union:

```ts
export const serverAnalysisResponseSchema = v.union([
    processingResponseSchema,
    readyResponseSchema,
    noPromoResponseSchema,
    unavailableResponseSchema,
    terminalErrorResponseSchema,
    rateLimitedResponseSchema,
]);
```

- [x] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/vitest run tests/shared/server-analysis-contract.test.ts`
Expected: PASS.

**Verification**: `ServerAnalysisResponse` now includes `RateLimitedResponse`, and malformed retry metadata remains rejected at the Valibot boundary.

### [x] Task 2: Client 429 Parsing and Invalid Response Failures

**Files:**

- Modify: `src/background/server-analysis-client.ts`
- Test: `tests/background/server-analysis-client.test.ts`

- [x] **Step 1: Write the failing test**

Add tests that mock `fetch` and assert:

```ts
expect(
    await ServerAnalysisClient.requestAnalysis({
        videoId: 'dQw4w9WgXcQ',
        durationSec: 213,
        extensionVersion: '0.1.0',
    }),
).toEqual({
    status: 'rate_limited',
    retryAfterSec: 60,
    error: {
        code: 'rate_limited',
        message: 'Local cold-analysis limit reached. Retry later.',
    },
});
```

Also add tests where `fetch` returns HTTP `429` with `{ status: 'invalid_request' }`, and HTTP `200` with `{ status: 'ready', promoBlocks: [] }`; both should reject with the existing Valibot-derived error path rather than returning unsafe data.

- [x] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run tests/background/server-analysis-client.test.ts`
Expected: FAIL because `requestBackendJson` throws on every non-OK response before parsing rate-limit JSON.

- [x] **Step 3: Write minimal implementation**

Keep the existing timeout and JSON parsing. After reading JSON, parse `429` responses through `rateLimitedResponseSchema` or through the expanded `serverAnalysisResponseSchema`; keep throwing for all other non-OK responses:

```ts
if (res.status === 429) {
    return v.parse(serverAnalysisResponseSchema, json);
}
if (!res.ok) {
    throw new Error(`Server analysis failed with HTTP ${res.status}`);
}
return v.parse(serverAnalysisResponseSchema, json);
```

- [x] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/vitest run tests/background/server-analysis-client.test.ts`
Expected: PASS.

**Verification**: A valid backend rate-limit body is handled as structured state; malformed backend bodies still cannot enter runtime logic.

### [x] Task 3: Backend Rate-Limit Regression

**Files:**

- Modify: `tests/backend/analysis-api.test.ts`

- [x] **Step 1: Write the failing test**

Use three distinct uncached valid video IDs and deterministic `nowMs` values in the same fixed window. Assert the first two cold starts are accepted and the third returns `429` with `rate_limited`, and that `BackendAnalysisJobs.snapshotForTests().jobCount` remains `2`.

```ts
expect(third).toEqual({
    statusCode: 429,
    body: {
        status: 'rate_limited',
        retryAfterSec: 60,
        error: {
            code: 'rate_limited',
            message: 'Local cold-analysis limit reached. Retry later.',
        },
    },
});
expect(BackendAnalysisJobs.snapshotForTests().jobCount).toBe(2);
```

- [x] **Step 2: Run test to verify it fails or documents existing behavior**

Run: `./node_modules/.bin/vitest run tests/backend/analysis-api.test.ts`
Expected: PASS if existing backend behavior is already correct; otherwise FAIL showing where protection accounting is incomplete.

- [x] **Step 3: Write minimal implementation**

If the test fails, keep all changes inside `src/backend/analysis-api.ts` or `src/backend/api-protection.ts`: call `BackendApiProtection.evaluate({ costClass: ColdJobStart })` before `BackendAnalysisJobs.start`, return `BackendAnalysisApi.rateLimited(protection.retryAfterSec)`, and do not create a job when denied.

- [x] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/vitest run tests/backend/analysis-api.test.ts`
Expected: PASS.

**Verification**: Rate-limited requests are retryable and do not start extraction, transcription, or model work.

### [x] Task 4: Runtime Mapping for All Non-Ready Server States

**Files:**

- Modify: `src/shared/messages.ts`
- Modify: `src/background/messaging/server-analysis-runtime-messages.ts`
- Test: `tests/background/messaging/server-analysis-runtime-messages.test.ts`

- [x] **Step 1: Write the failing test**

Extend the existing non-delivery table to include request-path and refresh-path `rate_limited` using a valid `rate_limited` response that omits `videoId` and `algorithmVersion`, and add request-path cases for `no_promo`, `unavailable`, and `error` if they are only covered on refresh. Assertions:

```ts
expect(result).toEqual({ ok: true, status: 'rate_limited' });
expect(browserMocks.tabsSendMessage).not.toHaveBeenCalled();
expect(cacheMocks.saveReadyResponse).not.toHaveBeenCalled();
expect(detectionMocks.set).toHaveBeenCalledWith(42, {
    videoId: 'dQw4w9WgXcQ',
    status: 'unavailable',
    source: 'server',
    error: 'Local cold-analysis limit reached. Retry later.',
});
```

Also add an explicit regression assertion that the runtime mapper accepts this response shape without reading missing metadata first:

```ts
serverClientMocks.requestAnalysis.mockResolvedValue({
    status: 'rate_limited',
    retryAfterSec: 60,
    error: {
        code: 'rate_limited',
        message: 'Local cold-analysis limit reached. Retry later.',
    },
});

const result = await ServerAnalysisRuntimeMessages.handleRequest({
    tabId: 42,
    videoId: 'dQw4w9WgXcQ',
    durationSec: 213,
});

expect(result).toEqual({ ok: true, status: 'rate_limited' });
expect(detectionMocks.set).toHaveBeenCalledWith(42, {
    videoId: 'dQw4w9WgXcQ',
    status: 'unavailable',
    source: 'server',
    error: 'Local cold-analysis limit reached. Retry later.',
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `./node_modules/.bin/vitest run tests/background/messaging/server-analysis-runtime-messages.test.ts`
Expected: FAIL because `rate_limited` is not in `ServerAnalysisTerminalStatus`, `applyServerResponse` has no switch branch for it, and the current mapper reads `input.response.videoId` / `input.response.algorithmVersion` before narrowing away metadata-free response shapes.

- [x] **Step 3: Write minimal implementation**

Add `'rate_limited'` to `ServerAnalysisTerminalStatus` in `src/shared/messages.ts`. In `applyServerResponse`, handle `input.response.status === 'rate_limited'` before any guard that reads `input.response.videoId` or `input.response.algorithmVersion`; use the request input video ID for popup state, set a server `unavailable` popup state with the rate-limit message, and return `{ ok: true, status: 'rate_limited' }`. Only after that early return should the mapper compare `response.videoId` and `response.algorithmVersion` for metadata-bearing response shapes. If the implementation prefers a helper, define a local type guard such as `hasServerAnalysisMetadata(response)` and put all metadata reads behind that guard. Keep the rate-limit branch free of `ServerResultCacheStorage.saveReadyResponse` and `tabs.sendMessage`.

- [x] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/vitest run tests/background/messaging/server-analysis-runtime-messages.test.ts`
Expected: PASS.

**Verification**: Every valid non-ready backend state is visible in popup state and cannot deliver promo blocks to content. A valid `rate_limited` response without `videoId` or `algorithmVersion` is accepted and mapped before metadata guards run.

### [x] Task 5: Network and Invalid Backend Response No-Fallback Behavior

**Files:**

- Modify: `src/background/messaging/server-analysis-runtime-messages.ts` if needed
- Test: `tests/background/messaging/server-analysis-runtime-messages.test.ts`

- [x] **Step 1: Write the failing test**

Add tests where `ServerAnalysisClient.requestAnalysis` rejects with `new Error('Failed to fetch')` and where it rejects with a Valibot parse error from an invalid backend response. Assert:

```ts
expect(result).toEqual({ ok: false, error: 'Failed to fetch' });
expect(browserMocks.tabsSendMessage).not.toHaveBeenCalled();
expect(detectionMocks.set).toHaveBeenCalledWith(42, {
    videoId: 'dQw4w9WgXcQ',
    status: 'error',
    source: 'server',
    error: 'Failed to fetch',
});
```

Also assert no BYOK/caption runtime message is sent; in this test file, that is represented by `tabs.sendMessage` remaining unused.

- [x] **Step 2: Run test to verify it fails or documents existing behavior**

Run: `./node_modules/.bin/vitest run tests/background/messaging/server-analysis-runtime-messages.test.ts`
Expected: PASS if the current catch path is already correct; otherwise FAIL with the missing no-delivery/no-fallback assertion.

- [x] **Step 3: Write minimal implementation**

If needed, update the catch blocks in `handleRequest` and `handleRefreshStatus` to set `{ status: 'error', source: 'server', error }` and return `{ ok: false, error }` without calling `deliverDetectedBlocks`, local provider logic, or caption capture.

- [x] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/vitest run tests/background/messaging/server-analysis-runtime-messages.test.ts`
Expected: PASS.

**Verification**: Network failures and invalid backend responses stop server-mode skipping without automatic local fallback.

### [x] Task 6: Popup Server Failure Copy Regression

**Files:**

- Modify: `src/popup/PopupApp.tsx` if needed
- Test: `tests/popup/popup-view-model.test.ts`

- [x] **Step 1: Write the failing test**

Add or extend a popup view-model test using the exact runtime state produced for rate limiting:

```ts
const vm = buildPopupViewModel({
    ...baseArgs,
    detectionState: {
        videoId: 'dQw4w9WgXcQ',
        status: 'unavailable',
        source: 'server',
        error: 'Local cold-analysis limit reached. Retry later.',
    },
});

expect(vm.title).toBe('Server analysis unavailable');
expect(vm.statusHeadline).toBe('Local cold-analysis limit reached. Retry later.');
expect(vm.statusBody).toContain('server-detected skips');
expect(vm.statusBody).not.toContain('API key');
```

- [x] **Step 2: Run test to verify it fails or documents existing behavior**

Run: `./node_modules/.bin/vitest run tests/popup/popup-view-model.test.ts`
Expected: PASS if existing server unavailable copy already covers this state; otherwise FAIL.

- [x] **Step 3: Write minimal implementation**

If the test fails, adjust only the existing server `unavailable` branch in `buildPopupViewModel`; do not add hardcoded user-visible strings outside i18n-backed helpers unless fixing pre-existing tests requires a broader i18n follow-up.

- [x] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/vitest run tests/popup/popup-view-model.test.ts`
Expected: PASS.

**Verification**: The popup clearly explains that server analysis is unavailable/rate-limited and does not ask for provider setup.

### [x] Task 7: Content No-Skip Invariant for Server Terminal States

**Files:**

- Modify: `tests/content/youtube-watch-skip-integration.test.ts`

- [x] **Step 1: Write the failing test**

Add an explicit server non-ready invariant test over `no_promo`, `unavailable`, `error`, and `rate_limited` labels. The simulated blocks should always be an empty array because runtime must not send `PROMO_BLOCKS_DETECTED` for these states:

```ts
it.each(['no_promo', 'unavailable', 'error', 'rate_limited'] as const)(
    'server %s state leaves playback unaltered when no blocks are delivered',
    () => {
        const d = simulateTimeUpdate({
            prevTime: 34.5,
            currentTime: 35.2,
            duration: 120,
            isSeeking: false,
            firedStartKeys: new Set<number>(),
            blocks: [],
        });

        expect(d.action).toBe('none');
    },
);
```

- [x] **Step 2: Run test to verify it passes**

Run: `./node_modules/.bin/vitest run tests/content/youtube-watch-skip-integration.test.ts`
Expected: PASS; this is a regression assertion for the existing pure skip invariant.

- [x] **Step 3: Write minimal implementation**

No production implementation is expected for this task. If it fails, fix the pure skip logic so an empty block list cannot trigger a skip.

- [x] **Step 4: Run test to verify it passes**

Run: `./node_modules/.bin/vitest run tests/content/youtube-watch-skip-integration.test.ts`
Expected: PASS.

**Verification**: Content playback is unchanged whenever no valid server block list exists.

### [x] Task 8: Focused Verification

**Files:**

- No source changes expected

- [x] **Step 1: Run focused unit suite**

Run:

```bash
./node_modules/.bin/vitest run \
  tests/shared/server-analysis-contract.test.ts \
  tests/background/server-analysis-client.test.ts \
  tests/backend/analysis-api.test.ts \
  tests/background/messaging/server-analysis-runtime-messages.test.ts \
  tests/popup/popup-view-model.test.ts \
  tests/content/youtube-watch-skip-integration.test.ts
```

Expected: PASS.

- [x] **Step 2: Run focused lint/format checks**

Run:

```bash
./node_modules/.bin/oxfmt --check \
  src/shared/server-analysis-contract.ts \
  src/shared/messages.ts \
  src/background/server-analysis-client.ts \
  src/background/messaging/server-analysis-runtime-messages.ts \
  src/popup/PopupApp.tsx \
  tests/shared/server-analysis-contract.test.ts \
  tests/background/server-analysis-client.test.ts \
  tests/backend/analysis-api.test.ts \
  tests/background/messaging/server-analysis-runtime-messages.test.ts \
  tests/popup/popup-view-model.test.ts \
  tests/content/youtube-watch-skip-integration.test.ts
./node_modules/.bin/oxlint --jsdoc-plugin --react-plugin --vitest-plugin \
  src/shared/server-analysis-contract.ts \
  src/shared/messages.ts \
  src/background/server-analysis-client.ts \
  src/background/messaging/server-analysis-runtime-messages.ts \
  src/popup/PopupApp.tsx \
  tests/shared/server-analysis-contract.test.ts \
  tests/background/server-analysis-client.test.ts \
  tests/backend/analysis-api.test.ts \
  tests/background/messaging/server-analysis-runtime-messages.test.ts \
  tests/popup/popup-view-model.test.ts \
  tests/content/youtube-watch-skip-integration.test.ts
./node_modules/.bin/eslint \
  src/shared/server-analysis-contract.ts \
  src/shared/messages.ts \
  src/background/server-analysis-client.ts \
  src/background/messaging/server-analysis-runtime-messages.ts \
  src/popup/PopupApp.tsx \
  tests/shared/server-analysis-contract.test.ts \
  tests/background/server-analysis-client.test.ts \
  tests/backend/analysis-api.test.ts \
  tests/background/messaging/server-analysis-runtime-messages.test.ts \
  tests/popup/popup-view-model.test.ts \
  tests/content/youtube-watch-skip-integration.test.ts
```

Expected: PASS.

**Verification**: Contract, backend, runtime mapping, popup, and content no-skip regressions pass together without requiring broad suite execution.

## Self-Review

- **Acceptance criterion 1** is covered by Task 4 (`no_promo` maps to popup state with no `PROMO_BLOCKS_DETECTED`) and Task 7 (empty server terminal block list cannot skip).
- **Acceptance criterion 2** is covered by existing extraction unavailable contract plus Task 4 (`unavailable` maps stage-specific message and no content delivery).
- **Acceptance criterion 3** is covered by Task 2 (invalid backend bodies rejected), Task 4 (terminal `error` maps without blocks), and Task 5 (invalid backend responses become no-fallback server errors).
- **Acceptance criterion 4** is covered by Task 1/2/4 for `rate_limited` and Task 5 for network failure, both without BYOK fallback or server-detected skips.
- **Placeholder scan**: No unresolved placeholders remain.
- **Type consistency**: `rate_limited` is introduced first in the shared contract, then propagated to runtime ack types and handler tests.
- **Review findings addressed**: Review attempt 1 is resolved by Task 4 requiring the `rate_limited` branch to run before `applyServerResponse` reads `input.response.videoId` or `input.response.algorithmVersion`, or by requiring an equivalent metadata-bearing type guard before those reads. Task 4 tests now include a valid `rate_limited` response that omits both metadata fields, so the regression is covered directly.
