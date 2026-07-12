# Implementation Plan: Artifact Store for Success and Failure History

- **Created**: 2026-07-08
- **Status**: Approved
- **Issue**: `.sdd/.current/issues/8-AFK/issue.md`
- **PRD**: `.sdd/.current/prd.md`
- **Model**: GPT-5 Codex
- **User Input**: `ISSUE_ID=8-AFK`, `SPECS_DIR=.sdd/.current`, constraints: revise the plan to address review attempt 2 by preserving the invariant that cacheable ready artifact records require both `selectedTranscriptArtifact` and `analysisRun`; fixture override ready completions without `analysisRun` must not be persisted as cacheable ready artifacts, and Task 5/schema/tests plus Task 6 cache lookup must align with that decision.

## Summary

Add a backend-owned artifact repository and service that persists completed local analysis history in process-local storage for the MVP. The store will collect the pieces already produced by issues `6-AFK` and `7-AFK`: request/video metadata from `BackendAnalysisJobs`, extraction attempts, selected transcript artifacts, analysis run artifacts, terminal ready/no-promo/unavailable/error responses, retry/job metadata, timing metadata, and safe operational metadata. Cacheable `ready` artifact records have a strict invariant: they are valid only when both `selectedTranscriptArtifact` and `analysisRun` exist. Fixture override `ready` completions are still allowed as terminal job responses for local testing, but when no `analysisRun` exists they are not persisted as cacheable ready artifact records. The implementation stays in `src/backend/` and does not change the extension-facing API contract; `BackendAnalysisApi` can then use only validated worker-produced ready artifact history as a cache source before starting cold work.

## Technical Context

- **Language/Version**: TypeScript 6.0.2 in strict ESM mode; Node.js `>=20`.
- **Primary Dependencies**: Valibot 1.3 for schema validation, Node `http` for the local backend, Vitest 4 for backend tests, `tsx` for the local backend dev script.
- **Storage**: MVP process-local in-memory repository under `src/backend/`; repository/service interface keeps later file or database storage behind the same boundary.
- **Testing**: Vitest tests under `tests/backend/**`; focused command is `pnpm run test tests/backend/analysis-artifact-store.test.ts tests/backend/analysis-jobs.test.ts tests/backend/analysis-api.test.ts tests/backend/server.test.ts`.
- **Target Platform**: Local Node backend at `http://127.0.0.1:8787`, consumed by the Chrome MV3 extension background server-analysis client.

## Research

### Existing Job Lifecycle

`src/backend/analysis-jobs.ts` owns the process-local job record. `BackendAnalysisJobs.start` records video ID, algorithm version, optional duration, created timestamp, extraction attempts, selected transcript artifact, and later `BackendAnalysisJobs.getStatus` records the analysis run and terminal response. This issue should add persistence at the points where the terminal response is assigned: extraction failure in `runExtraction`, worker completion in `runAnalysis`, and non-ready fixture override completion in `completeFixture`. `completeFixture` can also produce a `ready` terminal response before `runAnalysis` has created `record.analysisRun`; that path must return the response without saving a cacheable ready artifact record unless a valid analysis run already exists.

### Existing Extraction Artifacts

`src/backend/extraction/subtitle-extraction-types.ts` already validates `TranscriptArtifact` and `SubtitleExtractionAttempt`. Attempts carry stable failure reasons and bounded diagnostics, while selected transcripts carry source type, language, segments, transcript text, and acquisition time. The artifact store should reuse these shapes instead of redefining extraction records.

### Existing Analysis Artifacts

`src/backend/analysis/promo-analysis-types.ts` defines `AnalysisRunArtifact`, including provider, raw model response, parsed result, normalized blocks, failure reason, and started/completed times. This already satisfies most success/failure analysis payload requirements. The new store should embed the validated run artifact when present and allow `null` only for non-ready records such as extraction failures or debug-safe fixture terminal states. `ready` records must reject `analysisRun: null`.

### Existing Response Contract

`src/shared/server-analysis-contract.ts` already defines terminal response shapes for `ready`, `no_promo`, `unavailable`, and `error`, plus `ReadyResponse.freshness` metadata and `sourceResultId`. The artifact repository can use ready terminal records to answer cheap cache lookups without adding new API endpoints or changing response schemas.

### Existing Cache Flow

`src/backend/analysis-api.ts` first checks `BackendCacheFixtures.lookup`, then `BackendAnalysisJobs.findExisting`, then rate-limits cold starts. Add the artifact-store ready lookup between fixture cache and active-job join. That keeps persisted ready history cheap and preserves the rule that cold-start limits apply only when expensive work is about to begin.

### Secret Redaction Expectations

Issues `6-AFK` and `7-AFK` already avoid storing thrown error text, cookies, account tokens, API keys, or stack traces in extraction/analysis artifacts. Issue 8 still needs a store-level redaction guard for operational metadata because future callers may pass headers, URLs, or diagnostic strings. Redaction should be key-name and value-pattern based and should be validated by tests before any history record is stored.

### Dependency Status

Issue `6-AFK` is `Validated`, so this plan can rely on selected transcript artifacts, extraction attempts, and `caption_extraction_failed` terminal unavailable responses. Issue `7-AFK` is `Validated`, so this plan can rely on `AnalysisRunArtifact`, normalized blocks, raw model output, and terminal worker responses. The plan deliberately treats fixture override terminal responses as a debug/testing hook, not evidence that a model analysis run exists.

### Sub-Agent Availability

The explorer prompt exists at `/Users/maximtop/.codex/skills/oneshot-agent/agents/oneshot-explorer.agent.md`, but no sub-agent launch tool is available in this session. Repository exploration was performed locally with `rg`, `find`, `sed`, and targeted source reads.

## Entities

### Analysis Artifact Repository

- **Fields**:
    - `save(record)`: persists one completed history record.
    - `findLatestReady(input)`: returns the latest ready record for video ID and algorithm version.
    - `findHistory(input)`: returns all records for a video, sorted by completion time.
    - `resetForTests()`: clears process-local history.
- **Relationships**: Called by `BackendAnalysisJobs` after job completion; queried by `BackendAnalysisApi` before joining/starting jobs.
- **Validation**: Saves only validated `AnalysisArtifactRecord` values; returns readonly copies so callers cannot mutate store internals.
- **States**: empty, contains success records, contains failure records, contains multiple algorithm versions for the same video.

### Analysis Artifact Record

- **Fields**:
    - `recordId`: `string` - deterministic id including video ID, algorithm version, source result or job id, and completion time.
    - `video`: `{ videoId: string; durationSec?: number; algorithmVersion: string }`.
    - `job`: `{ jobId: string; createdAtMs: number; completedAtMs: number; retryCount: number; joinedRequestCount: number; finalStatus: string }`.
    - `extractionAttempts`: `SubtitleExtractionAttempt[]`.
    - `selectedTranscriptArtifact`: `TranscriptArtifact | null`.
    - `analysisRun`: `AnalysisRunArtifact | null`.
    - `terminalResponse`: `BackendAnalysisTerminalResponse`.
    - `operationalMetadata`: safe redacted metadata with prompt/model versions, timing/cost metadata, and optional diagnostics.
- **Relationships**: Combines existing job, extraction, analysis, and terminal response entities into one maintainers' history record.
- **Validation**: Ready records must include selected transcript, analysis run, raw model response, parsed result, normalized blocks, and terminal ready blocks. The schema/service rejects or skips any attempted ready artifact persistence when `analysisRun` or `selectedTranscriptArtifact` is missing. Extraction failures and non-ready fixture/debug completions may have no analysis run but must include attempts and a terminal reason/status.
- **States**: ready, no-promo, unavailable, error.

### Operational Metadata

- **Fields**:
    - `promptVersion`: `string`.
    - `modelVersion`: `string`.
    - `timing`: `{ queuedAtMs; startedAtMs; completedAtMs; totalLatencyMs }`.
    - `cost`: `{ estimatedUsd: number | null; inputTokens: number | null; outputTokens: number | null }`.
    - `diagnostics`: `Record<string, string | number | boolean | null>`.
- **Relationships**: Stored inside `AnalysisArtifactRecord`; derived from deterministic local defaults in this slice.
- **Validation**: No metadata key or value may persist secrets, cookies, extension-local API keys, bearer tokens, YouTube account tokens, or raw authorization headers.
- **States**: default local fixture metadata now, richer provider/cost metadata later.

### Artifact Cache Lookup

- **Fields**:
    - Input: `videoId`, `algorithmVersion`.
    - Output: `ReadyResponse | null`.
- **Relationships**: Reads latest ready artifact history and returns the stored terminal ready response through `BackendAnalysisApi`.
- **Validation**: Only validated `status: 'ready'` records are eligible, and such records can only exist when they carry `selectedTranscriptArtifact` plus `analysisRun`. `no_promo`, `unavailable`, `error`, and skipped fixture-ready completions remain non-cache behavior and never masquerade as cache hits.
- **States**: miss, ready hit, stale/future invalidated by algorithm-version mismatch.

## Contracts

No new HTTP or extension API endpoints are required. Existing routes keep these behaviors:

- `POST /v1/analysis` returns a ready response from artifact history when a completed ready record exists for the same video ID and algorithm version.
- `POST /v1/analysis` still starts or joins jobs when artifact history has no ready record.
- `GET /v1/analysis/jobs/{jobId}` persists terminal artifact history when analysis completes.

No `.sdd/.current/issues/8-AFK/contracts/` files are needed because the slice adds a backend repository boundary, not a public API.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/backend/analysis-artifact-store.ts` | Create | Defines artifact record schemas/types, redaction helpers, in-memory repository, and ready-cache lookup. |
| `tests/backend/analysis-artifact-store.test.ts` | Create | Verifies success history, failure history, versioned reanalysis, redaction, defensive copies, and ready lookup behavior. |
| `src/backend/analysis-jobs.ts` | Modify | Tracks joined request count/retry metadata, persists terminal artifact records on extraction failure, worker analysis completion, and non-ready fixture completion; skips fixture `ready` persistence when no analysis run exists. |
| `tests/backend/analysis-jobs.test.ts` | Modify | Verifies job completion writes artifact history for worker ready, no-promo/error, extraction-unavailable, and debug-safe non-ready fixture outcomes; verifies fixture `ready` without analysis run is not stored as a cacheable ready artifact. |
| `src/backend/analysis-api.ts` | Modify | Checks artifact-store ready history before active job join/cold start and records cheap cache lookup behavior. |
| `tests/backend/analysis-api.test.ts` | Modify | Verifies completed ready artifacts satisfy later analysis requests without creating jobs or spending cold-start quota. |
| `tests/backend/server.test.ts` | Modify | Verifies HTTP requests can receive a ready result from artifact history after one completed analysis. |

## Tasks

### [x] Task 1: Artifact Record Schema and Redaction

**Files:**

- Create: `src/backend/analysis-artifact-store.ts`
- Create: `tests/backend/analysis-artifact-store.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import {
    AnalysisArtifactStore,
    analysisArtifactRecordSchema,
} from '@/backend/analysis-artifact-store';
import { SERVER_ANALYSIS_ALGORITHM_VERSION } from '@/shared/server-analysis-contract';

it('redacts secret-like operational metadata before storage', () => {
    const record = AnalysisArtifactStore.buildRecordForTests({
        videoId: 'dQw4w9WgXcQ',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        terminalStatus: 'unavailable',
        operationalMetadata: {
            diagnostics: {
                authorization: 'Bearer sk-secret',
                cookie: 'SID=youtube-account-token',
                safeCode: 'caption_extraction_failed',
            },
        },
    });

    const serialized = JSON.stringify(v.parse(analysisArtifactRecordSchema, record));
    expect(serialized).not.toContain('sk-secret');
    expect(serialized).not.toContain('youtube-account-token');
    expect(serialized).toContain('[REDACTED]');
    expect(serialized).toContain('caption_extraction_failed');
});

it('rejects ready artifact records without transcript and analysis artifacts', () => {
    const record = AnalysisArtifactStore.buildRecordForTests({
        videoId: 'dQw4w9WgXcQ',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        terminalStatus: 'ready',
        selectedTranscriptArtifact: null,
        analysisRun: null,
    });

    expect(() => v.parse(analysisArtifactRecordSchema, record)).toThrow();
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/backend/analysis-artifact-store.test.ts`

Expected: FAIL with missing module `@/backend/analysis-artifact-store`.

- [x] **Step 3: Write minimal implementation**

Create `analysis-artifact-store.ts` with:

```ts
export const analysisOperationalMetadataSchema = v.strictObject({
    promptVersion: v.pipe(v.string(), v.minLength(1)),
    modelVersion: v.pipe(v.string(), v.minLength(1)),
    timing: v.strictObject({
        queuedAtMs: finiteEpochMsSchema,
        startedAtMs: finiteEpochMsSchema,
        completedAtMs: finiteEpochMsSchema,
        totalLatencyMs: v.pipe(v.number(), v.minValue(0)),
    }),
    cost: v.strictObject({
        estimatedUsd: v.nullable(v.number()),
        inputTokens: v.nullable(v.number()),
        outputTokens: v.nullable(v.number()),
    }),
    diagnostics: v.record(v.string(), safeOperationalValueSchema),
});
```

Add `AnalysisArtifactStore.redactOperationalMetadata` that replaces secret-like keys or values with `[REDACTED]`. Cover keys containing `authorization`, `cookie`, `token`, `secret`, `apiKey`, and values matching `Bearer `, `sk-`, `SID=`, or `SAPISID=`. Define `analysisArtifactRecordSchema` as a Valibot schema with a cross-field `v.check`: when `terminalResponse.status === 'ready'`, `selectedTranscriptArtifact` and `analysisRun` must both be non-null, `analysisRun.rawModelResponse` and `analysisRun.parsedResult` must be non-null, `analysisRun.normalizedPromoBlocks` must equal the ready `terminalResponse.promoBlocks`, and the analysis/transcript video and algorithm fields must match the record video.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/backend/analysis-artifact-store.test.ts`

Expected: PASS.

**Verification**: Store-owned metadata validation prevents future callers from persisting obvious secrets even if upstream artifacts remain safe, and cacheable ready records cannot be represented without the worker-produced transcript and analysis artifacts.

### [x] Task 2: In-Memory Repository Interface

**Files:**

- Modify: `src/backend/analysis-artifact-store.ts`
- Modify: `tests/backend/analysis-artifact-store.test.ts`

- [x] **Step 1: Write the failing test**

```ts
it('keeps versioned history without overwriting earlier algorithm versions', () => {
    AnalysisArtifactStore.resetForTests();

    const first = AnalysisArtifactStore.buildRecordForTests({
        videoId: 'dQw4w9WgXcQ',
        algorithmVersion: 'server-v1',
        terminalStatus: 'ready',
        completedAtMs: 1_900_000_001_000,
    });
    const second = AnalysisArtifactStore.buildRecordForTests({
        videoId: 'dQw4w9WgXcQ',
        algorithmVersion: 'server-v2',
        terminalStatus: 'ready',
        completedAtMs: 1_900_000_002_000,
    });

    AnalysisArtifactStore.save(first);
    AnalysisArtifactStore.save(second);

    expect(
        AnalysisArtifactStore.findHistory({ videoId: 'dQw4w9WgXcQ' }),
    ).toHaveLength(2);
    expect(
        AnalysisArtifactStore.findLatestReady({
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: 'server-v1',
        })?.terminalResponse.algorithmVersion,
    ).toBe('server-v1');
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/backend/analysis-artifact-store.test.ts`

Expected: FAIL because `save`, `findHistory`, and `findLatestReady` are not implemented.

- [x] **Step 3: Write minimal implementation**

Implement `AnalysisArtifactStore` as a static API class with:

```ts
private static readonly recordsById = new Map<string, AnalysisArtifactRecord>();

static save(record: AnalysisArtifactRecord): AnalysisArtifactRecord {
    const parsed = v.parse(analysisArtifactRecordSchema, {
        ...record,
        operationalMetadata: AnalysisArtifactStore.redactOperationalMetadata(
            record.operationalMetadata,
        ),
    });
    AnalysisArtifactStore.recordsById.set(parsed.recordId, structuredClone(parsed));
    return structuredClone(parsed);
}
```

Add `findHistory`, `findLatestReady`, `snapshotForTests`, and `resetForTests`; sort history by `job.completedAtMs` ascending and filter ready lookup by exact algorithm version. Keep `AnalysisArtifactStore.buildRecordForTests({ terminalStatus: 'ready' })` valid by default by creating matching fixture `selectedTranscriptArtifact` and `analysisRun` values; tests that need invalid ready records must override those fields to `null` explicitly.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/backend/analysis-artifact-store.test.ts`

Expected: PASS.

**Verification**: The repository exposes a stable storage boundary and preserves multiple algorithm versions for the same video.

### [x] Task 3: Persist Extraction Failure History

**Files:**

- Modify: `src/backend/analysis-jobs.ts`
- Modify: `tests/backend/analysis-jobs.test.ts`
- Modify: `tests/backend/analysis-artifact-store.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import { AnalysisArtifactStore } from '@/backend/analysis-artifact-store';

it('persists extraction failure history with attempts and terminal status', () => {
    BackendAnalysisJobs.resetForTests();
    AnalysisArtifactStore.resetForTests();

    BackendAnalysisJobs.start({
        videoId: 'unknownVid1',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        nowMs: 1_900_000_000_000,
    });

    const history = AnalysisArtifactStore.findHistory({ videoId: 'unknownVid1' });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
        terminalResponse: {
            status: 'unavailable',
            reason: SERVER_ANALYSIS_UNAVAILABLE_REASON.CaptionExtractionFailed,
        },
        selectedTranscriptArtifact: null,
        analysisRun: null,
    });
    expect(history[0].extractionAttempts[0]).toMatchObject({
        failureReason: 'fixture_not_found',
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/backend/analysis-jobs.test.ts tests/backend/analysis-artifact-store.test.ts`

Expected: FAIL because `BackendAnalysisJobs.runExtraction` does not save artifact history.

- [x] **Step 3: Write minimal implementation**

Import `AnalysisArtifactStore` in `analysis-jobs.ts`. Add `joinedRequestCount` and `retryCount` to `AnalysisJobRecord`, initialized to `0`. Increment `joinedRequestCount` when `start` returns an existing job. After extraction failure assigns `record.terminalResponse`, call a private `persistArtifactRecord(record, nowMs)` that builds and saves:

```ts
AnalysisArtifactStore.save({
    recordId: AnalysisArtifactStore.buildRecordId(record, nowMs),
    video: { videoId: record.videoId, durationSec: record.durationSec, algorithmVersion: record.algorithmVersion },
    job: { jobId: record.jobId, createdAtMs: record.createdAtMs, completedAtMs: nowMs, retryCount: record.retryCount, joinedRequestCount: record.joinedRequestCount, finalStatus: record.terminalResponse.status },
    extractionAttempts: record.extractionAttempts,
    selectedTranscriptArtifact: record.selectedTranscriptArtifact,
    analysisRun: record.analysisRun,
    terminalResponse: record.terminalResponse,
    operationalMetadata: AnalysisArtifactStore.buildDefaultOperationalMetadata(record, nowMs),
});
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/backend/analysis-jobs.test.ts tests/backend/analysis-artifact-store.test.ts`

Expected: PASS.

**Verification**: A failed extraction now creates inspectable history with attempts, failure reason, retry metadata, and final user-facing status.

### [x] Task 4: Persist Ready, No-Promo, and Error Analysis History

**Files:**

- Modify: `src/backend/analysis-jobs.ts`
- Modify: `tests/backend/analysis-jobs.test.ts`
- Modify: `tests/backend/analysis-artifact-store.test.ts`

- [x] **Step 1: Write the failing test**

```ts
it('persists successful analysis artifacts with transcript and model output', () => {
    BackendAnalysisJobs.resetForTests();
    AnalysisArtifactStore.resetForTests();

    const processing = BackendAnalysisJobs.start({
        videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        durationSec: 120,
        nowMs: 1_900_000_000_000,
    });
    if (processing.status !== 'processing') {
        throw new Error('Expected processing response.');
    }

    BackendAnalysisJobs.getStatus(processing.jobId, {
        nowMs: 1_900_000_001_000,
    });

    const [record] = AnalysisArtifactStore.findHistory({
        videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
    });
    expect(record.terminalResponse.status).toBe('ready');
    expect(record.selectedTranscriptArtifact?.transcriptText).toContain('sponsored');
    expect(record.analysisRun?.rawModelResponse).toContain('promoBlocks');
    expect(record.analysisRun?.parsedResult).toMatchObject({ hasPromo: true });
    expect(record.analysisRun?.normalizedPromoBlocks).toEqual(
        record.terminalResponse.status === 'ready'
            ? record.terminalResponse.promoBlocks
            : [],
    );
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/backend/analysis-jobs.test.ts tests/backend/analysis-artifact-store.test.ts`

Expected: FAIL because analysis completion does not save history.

- [x] **Step 3: Write minimal implementation**

Call the same `persistArtifactRecord(record, nowMs)` at the end of `runAnalysis` after `record.analysisRun`, `record.terminalResponse`, `record.completedAtMs`, and `record.stage` are set. Add tests for secondary fixture no-promo and injected/fixture error paths to ensure terminal failures with `analysisRun.failureReason` are stored without raw exception text.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/backend/analysis-jobs.test.ts tests/backend/analysis-artifact-store.test.ts`

Expected: PASS.

**Verification**: Successful and model-terminal analyses preserve video metadata, selected transcript, raw/parsed output, normalized blocks, prompt/model versions, timing/cost metadata, and final status.

### [x] Task 5: Persist Only Debug-Safe Fixture Completion Overrides

**Files:**

- Modify: `src/backend/analysis-jobs.ts`
- Modify: `tests/backend/analysis-jobs.test.ts`

- [x] **Step 1: Write the failing test**

```ts
it('persists non-ready fixture override completion history', () => {
    BackendAnalysisJobs.resetForTests();
    AnalysisArtifactStore.resetForTests();

    const processing = BackendAnalysisJobs.start({
        videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        nowMs: 1_900_000_000_000,
    });
    if (processing.status !== 'processing') {
        throw new Error('Expected processing response.');
    }

    BackendAnalysisJobs.completeFixture({
        jobId: processing.jobId,
        status: 'error',
        nowMs: 1_900_000_001_000,
    });

    const [record] = AnalysisArtifactStore.findHistory({
        videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
    });
    expect(record.terminalResponse.status).toBe('error');
    expect(record.selectedTranscriptArtifact).not.toBeNull();
    expect(record.analysisRun).toBeNull();
});

it('does not persist ready fixture overrides before analysis artifacts exist', () => {
    BackendAnalysisJobs.resetForTests();
    AnalysisArtifactStore.resetForTests();

    const processing = BackendAnalysisJobs.start({
        videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        nowMs: 1_900_000_000_000,
    });
    if (processing.status !== 'processing') {
        throw new Error('Expected processing response.');
    }

    const ready = BackendAnalysisJobs.completeFixture({
        jobId: processing.jobId,
        status: 'ready',
        nowMs: 1_900_000_001_000,
    });

    expect(ready?.status).toBe('ready');
    expect(
        AnalysisArtifactStore.findHistory({
            videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
        }),
    ).toEqual([]);
    expect(
        AnalysisArtifactStore.findLatestReady({
            videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        }),
    ).toBeNull();
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/backend/analysis-jobs.test.ts`

Expected: FAIL because `completeFixture` does not save non-ready fixture history and does not yet explicitly skip ready fixture persistence.

- [x] **Step 3: Write minimal implementation**

After `completeFixture` assigns `record.terminalResponse`, `record.completedAtMs`, and `record.stage`, call a private `persistArtifactRecordIfValid(record, input.nowMs, { source: 'fixture_override' })`. That helper must:

- Return immediately when `record.terminalResponse === null`.
- When `record.terminalResponse.status === 'ready'`, save only if `record.selectedTranscriptArtifact !== null` and `record.analysisRun !== null`; otherwise skip persistence and add a short code comment explaining that fixture ready completions are terminal test responses, not cacheable analysis artifacts.
- Save non-ready fixture completions (`no_promo`, `unavailable`, `error`) as debug-safe history records when they pass `analysisArtifactRecordSchema`, with `analysisRun: null` allowed by the schema for those statuses.
- Let schema validation fail loudly for any attempted ready record missing the required transcript or analysis run, so invalid cacheable records cannot enter `AnalysisArtifactStore`.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/backend/analysis-jobs.test.ts`

Expected: PASS.

**Verification**: Manual local non-ready fixture completions remain inspectable, while fixture `ready` completions without `analysisRun` are not stored and cannot be served later as artifact-cache hits.

### [x] Task 6: Serve Ready Cache Hits from Artifact History

**Files:**

- Modify: `src/backend/analysis-api.ts`
- Modify: `tests/backend/analysis-api.test.ts`
- Modify: `tests/backend/server.test.ts`

- [x] **Step 1: Write the failing test**

```ts
it('uses stored ready artifacts as cache hits before starting cold work', () => {
    BackendAnalysisJobs.resetForTests();
    AnalysisArtifactStore.resetForTests();
    BackendApiProtection.resetForTests();

    const processing = BackendAnalysisApi.handleAnalysisRequest(
        buildServerAnalysisRequest({
            videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
            durationSec: 120,
            extensionVersion: 'test',
        }),
        { nowMs: 1_900_000_000_000 },
    );
    expect(processing.statusCode).toBe(202);
    if (processing.body.status !== 'processing') {
        throw new Error('Expected processing response.');
    }
    BackendAnalysisJobs.getStatus(processing.body.jobId, {
        nowMs: 1_900_000_001_000,
    });
    BackendAnalysisJobs.resetForTests();

    const cached = BackendAnalysisApi.handleAnalysisRequest(
        buildServerAnalysisRequest({
            videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
            durationSec: 120,
            extensionVersion: 'test',
        }),
        { nowMs: 1_900_000_002_000 },
    );

    expect(cached).toMatchObject({
        statusCode: 200,
        body: { status: 'ready', source: 'server_cache' },
    });
    expect(BackendAnalysisJobs.snapshotForTests().jobCount).toBe(0);
});

it('does not treat fixture ready completions without analysis runs as artifact cache hits', () => {
    BackendAnalysisJobs.resetForTests();
    AnalysisArtifactStore.resetForTests();
    BackendApiProtection.resetForTests();

    const first = BackendAnalysisApi.handleAnalysisRequest(
        buildServerAnalysisRequest({
            videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
            durationSec: 120,
            extensionVersion: 'test',
        }),
        { nowMs: 1_900_000_000_000 },
    );
    if (first.body.status !== 'processing') {
        throw new Error('Expected processing response.');
    }

    BackendAnalysisJobs.completeFixture({
        jobId: first.body.jobId,
        status: 'ready',
        nowMs: 1_900_000_001_000,
    });
    BackendAnalysisJobs.resetForTests();

    const second = BackendAnalysisApi.handleAnalysisRequest(
        buildServerAnalysisRequest({
            videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
            durationSec: 120,
            extensionVersion: 'test',
        }),
        { nowMs: 1_900_000_002_000 },
    );

    expect(second.statusCode).toBe(202);
    expect(second.body.status).toBe('processing');
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/backend/analysis-api.test.ts tests/backend/server.test.ts`

Expected: FAIL because `BackendAnalysisApi` does not query artifact history.

- [x] **Step 3: Write minimal implementation**

In `BackendAnalysisApi.handleAnalysisRequest(raw, options)`, keep the existing `const nowMs = options.nowMs ?? Date.now();` local, parse the incoming `raw` body exactly as the current API does, and after request validation plus fixture cache lookup call:

```ts
const artifactReady = AnalysisArtifactStore.findLatestReady({
    videoId: parsed.output.videoId,
    algorithmVersion: parsed.output.algorithmVersion,
});
if (artifactReady !== null) {
    BackendApiProtection.evaluate({
        costClass: BACKEND_REQUEST_COST_CLASS.CacheLookup,
        nowMs,
    });
    return { statusCode: 200, body: artifactReady.terminalResponse };
}
```

Keep non-ready artifacts as history only. Do not start a job or spend cold-start quota for a validated ready artifact hit. Because Task 5 skips fixture `ready` persistence without an `analysisRun`, the API-level fixture-ready test must prove that path is a miss and starts a new processing job after the in-memory job table is reset.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/backend/analysis-api.test.ts tests/backend/server.test.ts`

Expected: PASS.

**Verification**: Stored worker-produced ready results become reusable server cache hits, while failures and fixture-ready terminal responses without analysis artifacts remain non-cache behavior.

### [x] Task 7: Full Focused Verification

**Files:**

- Modify: `tests/backend/analysis-artifact-store.test.ts`
- Modify: `tests/backend/analysis-jobs.test.ts`
- Modify: `tests/backend/analysis-api.test.ts`
- Modify: `tests/backend/server.test.ts`

- [x] **Step 1: Run the focused suite**

Run: `pnpm run test tests/backend/analysis-artifact-store.test.ts tests/backend/analysis-jobs.test.ts tests/backend/analysis-api.test.ts tests/backend/server.test.ts`

Expected: PASS.

- [x] **Step 2: Run type and lint checks**

Run: `pnpm run lint:types`

Expected: PASS.

Run: `pnpm run lint`

Expected: PASS.

- [x] **Step 3: Manual smoke check**

Run a local successful analysis and a local extraction failure through the backend dev server, then inspect `AnalysisArtifactStore.findHistory` in tests or a temporary debug script. Confirm that success records include transcript text, raw model response, parsed/normalized blocks, versions, and timing/cost metadata, and that failure records include attempts, stable failure reasons, retry metadata, and terminal user status without secrets.

**Verification**: Automated and manual checks cover every acceptance criterion for issue `8-AFK`.

## Self-Review

- **Acceptance criterion 1** is covered by Tasks 1, 2, and 4: success records include video metadata, transcript source/text, prompt/model versions, raw model response, parsed blocks, normalized blocks, and timing/cost metadata, and ready records require selected transcript plus analysis run artifacts.
- **Acceptance criterion 2** is covered by Tasks 3 and 4: failed extraction and model-terminal records include attempts, failure reasons, provider/model errors through stable codes, retry metadata, and final user-facing status.
- **Acceptance criterion 3** is covered by Task 2: `findHistory` preserves multiple algorithm versions for the same video instead of overwriting.
- **Acceptance criterion 4** is covered by Task 1 and reinforced in Tasks 3-5: redaction prevents secret-like keys and values from being persisted in operational metadata, and fixture-ready responses without analysis artifacts are skipped rather than stored as misleading cacheable history.
- Placeholder scan: no unresolved placeholders remain.
- Type consistency: the plan consistently uses `AnalysisArtifactRecord`, `AnalysisRunArtifact`, `TranscriptArtifact`, `SubtitleExtractionAttempt`, `BackendAnalysisTerminalResponse`, `ReadyResponse`, and existing server-analysis contract names.
- Review finding addressed: Task 1 defines the ready-record validation invariant, Task 5 explicitly skips fixture `ready` persistence when `analysisRun` is missing while still allowing debug-safe non-ready fixture history, and Task 6 limits cache lookup to validated ready artifact records with an API test proving fixture-ready-without-analysis is a miss. Task 6 also calls `BackendAnalysisApi.handleAnalysisRequest(raw, { nowMs })`, reads `processing.body` and `cached.body`, and returns `{ statusCode: 200, body: artifactReady.terminalResponse }` from the implementation snippet.
