# Implementation Plan: LLM Analysis Worker and Block Normalization

- **Created**: 2026-07-08
- **Status**: Approved
- **Issue**: `.sdd/.current/issues/7-AFK/issue.md`
- **PRD**: `.sdd/.current/prd.md`
- **Model**: GPT-5 Codex
- **User Input**: `ISSUE_ID=7-AFK`, `SPECS_DIR=.sdd/.current`, constraints: revise the existing plan to address all findings in `.sdd/.current/issues/7-AFK/review.md`; keep analysis provider metadata/schema consistent with injectable backend adapters and validate open-ended blocks against their implied default-duration end.

## Summary

Add a backend-owned promo analysis worker that consumes the transcript artifact selected by issue `6-AFK`, gets a deterministic local model response through an injectable adapter, parses the raw JSON, normalizes promo blocks, records analysis artifacts on the in-memory job, and publishes terminal `ready`, `no_promo`, or `error` responses through the existing job status path. The first implementation stays local and deterministic: no live LLM calls, no new HTTP routes, and no durable storage. The initial cold request still returns `processing`; the first job-status read runs the analysis worker and returns the terminal response, allowing the extension's existing polling path to receive server-ready blocks. Provider metadata is adapter-owned and schema-validated as a bounded string, so injected test adapters such as `test_adapter` can be recorded without lying as `local_fixture_llm`. Open-ended blocks are validated against `startSec + DEFAULT_PROMO_BLOCK_DURATION_SEC` when video duration is known before any ready response can be delivered.

## Technical Context

- **Language/Version**: TypeScript 6.0.2 in strict ESM mode; Node.js `>=20`.
- **Primary Dependencies**: Valibot 1.3 for schema validation, Node `http` for the local backend, Vitest 4 for backend/unit tests, `tsx` for the local backend dev script.
- **Storage**: No durable backend storage in this slice. Raw model output, parsed model result, normalized blocks, and failure metadata are stored on the existing process-local `AnalysisJobRecord`.
- **Testing**: Vitest tests under `tests/backend/**`, `tests/shared/server-analysis-contract.test.ts`, and `tests/background/messaging/server-analysis-runtime-messages.test.ts`.
- **Target Platform**: Local Node backend at `http://127.0.0.1:8787`, consumed by the Chrome MV3 extension background server-analysis client.

## Research

### Current Backend Job Lifecycle

`src/backend/analysis-jobs.ts:25` defines job stages as `extracting`, `awaiting_analysis`, and `complete`. `BackendAnalysisJobs.start` at `src/backend/analysis-jobs.ts:111` creates and stores a processing job, then `runExtraction` at `src/backend/analysis-jobs.ts:265` selects a transcript or completes the job as `unavailable`. Supported transcript fixtures currently remain in `awaiting_analysis`, and `getStatus` at `src/backend/analysis-jobs.ts:183` only returns the unchanged processing response. This issue should fill that exact `awaiting_analysis` gap instead of changing request validation or extraction.

### Existing Response Contract

`src/shared/server-analysis-contract.ts:81` validates one promo block, `readyResponseSchema` at `src/shared/server-analysis-contract.ts:113` validates terminal ready responses, `noPromoResponseSchema` at `src/shared/server-analysis-contract.ts:126` validates no-promo responses, and `serverAnalysisResponseSchema` at `src/shared/server-analysis-contract.ts:186` is the response union consumed by the extension. `terminalErrorResponseSchema` at `src/shared/server-analysis-contract.ts:161` currently allows only `fixture_error`, so analysis-worker failures need named, stable error codes without weakening strict validation.

### Existing Extension Delivery Path

`ServerAnalysisRuntimeMessages.applyServerResponse` already handles every terminal response type. A `ready` response is saved to the local cache and delivered to the content script at `src/background/messaging/server-analysis-runtime-messages.ts:122`; `no_promo` updates popup state without sending blocks at `src/background/messaging/server-analysis-runtime-messages.ts:138`; `unavailable` and `error` states do not deliver blocks at `src/background/messaging/server-analysis-runtime-messages.ts:145` and `src/background/messaging/server-analysis-runtime-messages.ts:153`. No extension runtime behavior change is required if the backend returns the existing terminal shapes.

### Existing Parser and Normalizer Pattern

`src/background/openrouter/parse-llm-promo-response.ts` strips optional markdown fences, parses JSON through `llmPromoDetectionSchema`, and dedupes blocks with `sortAndDedupePromoBlocks`. The backend should not import that background-owned module because backend analysis belongs under `src/backend/`; however, it can reuse pure shared pieces: `src/shared/openrouter-llm-schema.ts`, `src/shared/promo-dedupe.ts`, and `src/shared/server-analysis-contract.ts`.

The content/UI path treats a promo block with no `endSec` as an approximate range ending at `startSec + DEFAULT_PROMO_BLOCK_DURATION_SEC` from `src/shared/promo-block.ts`. Backend normalization must apply the same implied end when `durationSec` is known, because delivering `{ startSec: 100 }` for a 120-second video would display/apply a 100-130 second block even though the ready response is supposed to stay inside the known duration.

### Current Fixture Transcript Inputs

`src/backend/extraction/local-transcript-fixtures.ts` exposes two deterministic YouTube-shaped video IDs. The primary fixture contains sponsor text at 4s and 18s, followed by main content at 32s. The secondary fixture contains a brief sponsor mention but is useful as a deterministic no-promo response in this slice. The local analysis adapter should key on `TranscriptArtifact.videoId`, not raw transcript text matching, so tests remain stable as fixture wording changes.

### Tests to Extend

`tests/backend/analysis-jobs.test.ts:38` already asserts selected transcript artifacts are stored for supported cold jobs. `tests/backend/analysis-api.test.ts:115` and `tests/backend/server.test.ts:156` already cover cold jobs and status polling. `tests/background/messaging/server-analysis-runtime-messages.test.ts:300` already proves a ready status refresh reaches content via `PROMO_BLOCKS_DETECTED`. Add focused tests around worker parsing/normalization and adjust job/API/HTTP tests so the first status poll now returns the analysis result instead of remaining processing forever.

### Dependency Status

Issue `6-AFK` is `Validated`, so this plan can rely on `TranscriptArtifact`, extraction attempt diagnostics, selected transcript storage, the `caption_extraction_failed` unavailable reason, and the local fixture extraction strategy.

### Sub-Agent Availability

The explorer prompt exists at `/Users/maximtop/.codex/skills/oneshot-agent/agents/oneshot-explorer.agent.md`, but no sub-agent launch tool is available in this session. Repository exploration was performed locally with `rg`, `find`, `sed`, and targeted `nl -ba` reads.

## Entities

### Backend LLM Analysis Adapter

- **Fields**:
    - `providerId`: `string` - stable adapter-owned id such as `local_fixture_llm` or an injected test id such as `test_adapter`.
    - `analyze(input)`: function that receives a selected `TranscriptArtifact` and returns a raw model response string.
- **Relationships**: Default adapter for `BackendPromoAnalysisWorker`; tests can inject adapters that return invalid JSON, out-of-bounds blocks, degenerate blocks, or throw.
- **Validation**: Adapter output is untrusted until parsed and normalized. Adapter provider IDs are stored as bounded metadata and must be non-empty, but the artifact schema must not hard-code only the local fixture id because tests and future development adapters use the same worker boundary.
- **States**: produced raw response, threw provider error.

### Analysis Run Artifact

- **Fields**:
    - `runId`: `string` - deterministic local id such as `analysis-dQw4w9WgXcQ-server-v1-local_fixture_llm`.
    - `transcriptArtifactId`: `string` - selected transcript artifact id consumed by the run.
    - `videoId`: `string` - video id from the transcript artifact.
    - `algorithmVersion`: `string` - server algorithm/cache version from the job.
    - `provider`: `string` - adapter-owned provider id copied from `BackendLlmAnalysisAdapter.providerId`.
    - `startedAtMs`: `number` - deterministic analysis timestamp.
    - `completedAtMs`: `number` - deterministic analysis timestamp.
    - `rawModelResponse`: `string | null` - exact raw adapter output when one exists.
    - `parsedResult`: `{ hasPromo: false } | { hasPromo: true; promoBlocks: PromoBlock[] } | null`.
    - `normalizedPromoBlocks`: `PromoBlock[]` - sorted, non-overlapping blocks stored only for valid promo results.
    - `failureReason`: analysis failure reason or `null`.
- **Relationships**: Stored on `AnalysisJobRecord.analysisRun`; its terminal response is returned by `BackendAnalysisJobs.getStatus`.
- **Validation**: `provider` parses through the same bounded provider-id schema used by adapters, so `local_fixture_llm` and injected ids such as `test_adapter` are valid while empty/oversized ids fail. Raw exception messages, stack traces, cookies, API keys, and account tokens must not be stored. Invalid JSON stores the raw response but leaves `parsedResult` as `null`.
- **States**: `ready`, `no_promo`, or `failed`.

### Parsed Model Promo Result

- **Fields**:
    - `hasPromo`: `boolean`.
    - `promoBlocks`: `PromoBlock[]` when `hasPromo` is `true`.
    - `confidence`: optional confidence when `hasPromo` is `false`.
- **Relationships**: Parsed from `AnalysisRunArtifact.rawModelResponse`; normalized into `ReadyResponse.promoBlocks` or converted to `NoPromoResponse`.
- **Validation**: Must parse through the existing pure `llmPromoDetectionSchema`; malformed JSON and schema failures are model-response errors.
- **States**: valid promo response, valid no-promo response, invalid response.

### Normalized Promo Blocks

- **Fields**:
    - `startSec`: `number`.
    - `endSec`: `number | undefined`.
    - `confidence`: `'low' | 'medium' | 'high' | undefined`.
- **Relationships**: Produced by backend normalization and sent in `ReadyResponse.promoBlocks`; later saved by `ServerResultCacheStorage`.
- **Validation**: Blocks must have finite non-negative start times, finite end times greater than start when present, be sorted and non-overlapping after dedupe, and stay inside known duration when `durationSec` is available. If a block omits `endSec`, the validator computes `impliedEndSec = startSec + DEFAULT_PROMO_BLOCK_DURATION_SEC` and rejects it when the implied end exceeds the known duration. A known-duration block spanning the full video is rejected as degenerate rather than delivered.
- **States**: raw model block, normalized delivery block, rejected unsafe block.

### Analysis Job Record

- **Fields**:
    - Existing fields: `jobId`, `jobKey`, `videoId`, `algorithmVersion`, `pollAfterSec`, `createdAtMs`, `completedAtMs`, `stage`, `extractionAttempts`, `selectedTranscriptArtifact`, `processingResponse`, `terminalResponse`.
    - New fields: `durationSec`, `analysisRun`.
- **Relationships**: Created by `BackendAnalysisJobs.start`; extraction fills `selectedTranscriptArtifact`; the analysis worker fills `analysisRun` and `terminalResponse` on status polling.
- **Validation**: A job with no selected transcript cannot run analysis. Once a terminal response exists, duplicate starts and status reads return it without re-running the adapter.
- **States**: `extracting -> awaiting_analysis -> analyzing -> complete`, or `extracting -> complete` when extraction fails.

### Terminal Analysis Response

- **Fields**:
    - Ready: `status: 'ready'`, `source: 'server_cache'`, `sourceResultId`, `freshness`, and normalized `promoBlocks`.
    - No promo: `status: 'no_promo'`, `sourceResultId`, and `freshness`.
    - Error: `status: 'error'`, with `error.code` in a stable analysis error-code union.
- **Relationships**: Built by `BackendPromoAnalysisWorker`; stored as `AnalysisJobRecord.terminalResponse`; consumed by the existing backend HTTP and extension polling paths.
- **Validation**: Ready responses parse through `readyResponseSchema`; no-promo through `noPromoResponseSchema`; model failure errors through the extended `terminalErrorResponseSchema`.
- **States**: terminal result for the job and for all duplicate cold requests for the same video/version.

## Contracts

No new API endpoints are required. The existing contracts keep these routes:

- `POST /v1/analysis` returns `202 processing` for a supported uncached cold request after transcript extraction succeeds.
- `GET /v1/analysis/jobs/{jobId}` runs pending local analysis for jobs in `awaiting_analysis` and returns `200 ready`, `200 no_promo`, or `200 error`.
- `POST /v1/analysis/jobs/{jobId}/fixture-result` remains available as a deterministic local override hook but is no longer needed for the default successful cold path.

The shared response contract change is limited to `TerminalErrorResponse.error.code`: preserve `fixture_error` and add stable model-analysis error codes such as `invalid_model_response`, `unsafe_model_blocks`, and `model_provider_error`. No `.sdd/.current/issues/7-AFK/contracts/` files are needed because this slice does not add an endpoint or request body.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/shared/server-analysis-contract.ts` | Modify | Add stable terminal error-code constants for model analysis failures while preserving `fixture_error`. |
| `tests/shared/server-analysis-contract.test.ts` | Modify | Verify new terminal error codes parse and unknown codes fail strict validation. |
| `src/backend/analysis/promo-analysis-types.ts` | Create | Define backend-only adapter, parsed result, analysis run artifact, and failure reason schemas/types. |
| `src/backend/analysis/promo-response-parser.ts` | Create | Strip optional markdown fences, parse raw model JSON through `llmPromoDetectionSchema`, and return typed parse results. |
| `src/backend/analysis/promo-block-normalization.ts` | Create | Validate, sort, dedupe, duration-check, and full-video-degenerate-check model promo blocks. |
| `src/backend/analysis/local-analysis-fixtures.ts` | Create | Provide the deterministic local LLM adapter for fixture transcripts. |
| `src/backend/analysis/promo-analysis-worker.ts` | Create | Orchestrate adapter call, raw-response storage, parsing, normalization, terminal response building, and analysis run artifact creation. |
| `tests/backend/promo-analysis-worker.test.ts` | Create | Cover raw response parsing, no-promo output, invalid JSON, out-of-bounds timestamps, open-ended duration overruns, full-video degenerate rejection, provider metadata, provider errors, and sorted normalized blocks. |
| `src/backend/analysis-jobs.ts` | Modify | Store duration and analysis artifacts, add an `analyzing` stage, run the analysis worker from `getStatus`, and return terminal worker responses. |
| `tests/backend/analysis-jobs.test.ts` | Modify | Verify polling transitions selected transcript jobs to ready/no-promo/error and that duplicate reads do not re-run analysis. |
| `src/backend/analysis-api.ts` | Modify | Pass request duration into job creation and expose deterministic status options for tests if needed. |
| `tests/backend/analysis-api.test.ts` | Modify | Verify status polling returns ready/no-promo worker results and unsafe worker failures remain terminal errors with no blocks. |
| `tests/backend/server.test.ts` | Modify | Verify the HTTP status endpoint returns worker-produced ready/no-promo/error responses without the fixture completion route. |
| `tests/background/messaging/server-analysis-runtime-messages.test.ts` | Modify | Keep the ready refresh delivery regression and add terminal model-error mapping coverage if the new error-code union affects fixtures. |

## Tasks

### [x] Task 1: Shared Terminal Error Codes

**Files:**

- Modify: `src/shared/server-analysis-contract.ts`
- Modify: `tests/shared/server-analysis-contract.test.ts`
- Modify: `src/backend/analysis-jobs.ts`

- [x] **Step 1: Write the failing test**

```ts
import {
    SERVER_ANALYSIS_ERROR_CODE,
    terminalErrorResponseSchema,
} from '@/shared/server-analysis-contract';

it.each([
    SERVER_ANALYSIS_ERROR_CODE.InvalidModelResponse,
    SERVER_ANALYSIS_ERROR_CODE.UnsafeModelBlocks,
    SERVER_ANALYSIS_ERROR_CODE.ModelProviderError,
] as const)('parses analysis terminal error code %s', (code) => {
    const parsed = v.parse(terminalErrorResponseSchema, {
        status: 'error',
        videoId: 'dQw4w9WgXcQ',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        error: {
            code,
            message: 'Model analysis failed.',
        },
    });

    expect(parsed.error.code).toBe(code);
});

it('rejects unknown analysis terminal error codes', () => {
    expect(
        v.safeParse(terminalErrorResponseSchema, {
            status: 'error',
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            error: {
                code: 'raw_provider_error',
                message: 'Model analysis failed.',
            },
        }).success,
    ).toBe(false);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/shared/server-analysis-contract.test.ts`

Expected: FAIL with missing export `SERVER_ANALYSIS_ERROR_CODE`.

- [x] **Step 3: Write minimal implementation**

Add a named code constant and use it in `terminalErrorResponseSchema`:

```ts
export const SERVER_ANALYSIS_ERROR_CODE = {
    FixtureError: 'fixture_error',
    InvalidModelResponse: 'invalid_model_response',
    UnsafeModelBlocks: 'unsafe_model_blocks',
    ModelProviderError: 'model_provider_error',
} as const;

const terminalErrorCodeSchema = v.picklist([
    SERVER_ANALYSIS_ERROR_CODE.FixtureError,
    SERVER_ANALYSIS_ERROR_CODE.InvalidModelResponse,
    SERVER_ANALYSIS_ERROR_CODE.UnsafeModelBlocks,
    SERVER_ANALYSIS_ERROR_CODE.ModelProviderError,
] as const);

export const terminalErrorResponseSchema = v.strictObject({
    status: v.literal('error'),
    videoId: youtubeVideoIdSchema,
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    error: v.strictObject({
        code: terminalErrorCodeSchema,
        message: v.pipe(v.string(), v.minLength(1)),
    }),
});
```

Update `BackendAnalysisJobs.buildFixtureTerminalResponse` at `src/backend/analysis-jobs.ts:364` to use `SERVER_ANALYSIS_ERROR_CODE.FixtureError` instead of the repeated string.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/shared/server-analysis-contract.test.ts`

Expected: PASS.

**Verification**: The API contract remains strict and now has explicit model-analysis terminal error states.

### [x] Task 2: Backend Analysis Entity Types

**Files:**

- Create: `src/backend/analysis/promo-analysis-types.ts`
- Create: `tests/backend/promo-analysis-worker.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import * as v from 'valibot';

import {
    BACKEND_ANALYSIS_FAILURE_REASON,
    analysisRunArtifactSchema,
} from '@/backend/analysis/promo-analysis-types';

it('validates an analysis run artifact with raw and parsed model output', () => {
    const parsed = v.parse(analysisRunArtifactSchema, {
        runId: 'analysis-dQw4w9WgXcQ-server-v1-local_fixture_llm',
        transcriptArtifactId:
            'transcript-dQw4w9WgXcQ-server-v1-local_transcript_fixture',
        videoId: 'dQw4w9WgXcQ',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        provider: 'local_fixture_llm',
        startedAtMs: 1_900_000_001_000,
        completedAtMs: 1_900_000_001_000,
        rawModelResponse:
            '{"hasPromo":true,"promoBlocks":[{"startSec":4,"endSec":24}]}',
        parsedResult: {
            hasPromo: true,
            promoBlocks: [{ startSec: 4, endSec: 24, confidence: 'high' }],
        },
        normalizedPromoBlocks: [
            { startSec: 4, endSec: 24, confidence: 'high' },
        ],
        failureReason: null,
    });

    expect(parsed.rawModelResponse).toContain('hasPromo');
});

it('allows invalid model responses to retain raw output without parsed blocks', () => {
    const parsed = v.parse(analysisRunArtifactSchema, {
        runId: 'analysis-dQw4w9WgXcQ-server-v1-local_fixture_llm',
        transcriptArtifactId:
            'transcript-dQw4w9WgXcQ-server-v1-local_transcript_fixture',
        videoId: 'dQw4w9WgXcQ',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        provider: 'local_fixture_llm',
        startedAtMs: 1_900_000_001_000,
        completedAtMs: 1_900_000_001_000,
        rawModelResponse: 'not json',
        parsedResult: null,
        normalizedPromoBlocks: [],
        failureReason: BACKEND_ANALYSIS_FAILURE_REASON.InvalidModelResponse,
    });

    expect(parsed.parsedResult).toBeNull();
});

it('accepts provider metadata from an injected adapter', () => {
    const parsed = v.parse(analysisRunArtifactSchema, {
        runId: 'analysis-dQw4w9WgXcQ-server-v1-test_adapter',
        transcriptArtifactId:
            'transcript-dQw4w9WgXcQ-server-v1-local_transcript_fixture',
        videoId: 'dQw4w9WgXcQ',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        provider: 'test_adapter',
        startedAtMs: 1_900_000_001_000,
        completedAtMs: 1_900_000_001_000,
        rawModelResponse: 'not json',
        parsedResult: null,
        normalizedPromoBlocks: [],
        failureReason: BACKEND_ANALYSIS_FAILURE_REASON.InvalidModelResponse,
    });

    expect(parsed.provider).toBe('test_adapter');
});

it('rejects invalid provider metadata before storing an analysis run', () => {
    expect(
        v.safeParse(analysisRunArtifactSchema, {
            runId: 'analysis-dQw4w9WgXcQ-server-v1-empty-provider',
            transcriptArtifactId:
                'transcript-dQw4w9WgXcQ-server-v1-local_transcript_fixture',
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            provider: '',
            startedAtMs: 1_900_000_001_000,
            completedAtMs: 1_900_000_001_000,
            rawModelResponse: 'not json',
            parsedResult: null,
            normalizedPromoBlocks: [],
            failureReason:
                BACKEND_ANALYSIS_FAILURE_REASON.InvalidModelResponse,
        }).success,
    ).toBe(false);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/backend/promo-analysis-worker.test.ts`

Expected: FAIL with missing module `@/backend/analysis/promo-analysis-types`.

- [x] **Step 3: Write minimal implementation**

Create backend-only Valibot schemas and types:

```ts
export const BACKEND_ANALYSIS_PROVIDER_ID_MAX_LENGTH = 80;

export const BACKEND_ANALYSIS_PROVIDER_ID = {
    LocalFixture: 'local_fixture_llm',
} as const;

export const backendAnalysisProviderIdSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(BACKEND_ANALYSIS_PROVIDER_ID_MAX_LENGTH),
);

export const BACKEND_ANALYSIS_FAILURE_REASON = {
    InvalidModelResponse: 'invalid_model_response',
    UnsafeModelBlocks: 'unsafe_model_blocks',
    ModelProviderError: 'model_provider_error',
} as const;

export const analysisRunArtifactSchema = v.strictObject({
    runId: v.pipe(v.string(), v.minLength(1)),
    transcriptArtifactId: v.pipe(v.string(), v.minLength(1)),
    videoId: youtubeVideoIdSchema,
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    provider: backendAnalysisProviderIdSchema,
    startedAtMs: finiteEpochMsSchema,
    completedAtMs: finiteEpochMsSchema,
    rawModelResponse: v.nullable(v.pipe(v.string(), v.minLength(1))),
    parsedResult: v.nullable(parsedModelPromoResultSchema),
    normalizedPromoBlocks: v.array(promoBlockSchema),
    failureReason: v.nullable(backendAnalysisFailureReasonSchema),
});
```

Also export `BackendLlmAnalysisAdapter`, `AnalysisRunArtifact`, `ParsedModelPromoResult`, and `BackendAnalysisFailureReason` types. Define `BackendLlmAnalysisAdapter` with `providerId: string` and `analyze(input): string`; validate `providerId` with `backendAnalysisProviderIdSchema` inside the worker before creating the run artifact. Keep this module under `src/backend/analysis/` because the adapter interface is backend-owned and not a cross-bundle message contract.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/backend/promo-analysis-worker.test.ts`

Expected: PASS for the new schema tests.

**Verification**: Worker artifacts can retain raw model output, adapter-owned provider metadata, and bounded failure metadata without exposing backend-only types through `src/shared/`. The schema accepts the local fixture adapter and injected test adapters consistently.

### [x] Task 3: Parser and Promo Block Normalization

**Files:**

- Create: `src/backend/analysis/promo-response-parser.ts`
- Create: `src/backend/analysis/promo-block-normalization.ts`
- Modify: `tests/backend/promo-analysis-worker.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import { parseBackendPromoResponse } from '@/backend/analysis/promo-response-parser';
import { normalizeBackendPromoBlocks } from '@/backend/analysis/promo-block-normalization';

it('parses fenced promo JSON and no-promo JSON', () => {
    expect(
        parseBackendPromoResponse(
            '```json\n{"hasPromo":true,"promoBlocks":[{"startSec":18,"endSec":24}]}\n```',
        ),
    ).toEqual({
        ok: true,
        parsedResult: {
            hasPromo: true,
            promoBlocks: [{ startSec: 18, endSec: 24 }],
        },
    });

    expect(parseBackendPromoResponse('{"hasPromo":false}')).toEqual({
        ok: true,
        parsedResult: { hasPromo: false },
    });
});

it('rejects invalid JSON before normalization', () => {
    expect(parseBackendPromoResponse('not json')).toEqual({
        ok: false,
        failureReason: BACKEND_ANALYSIS_FAILURE_REASON.InvalidModelResponse,
    });
});

it('sorts and merges valid blocks inside known duration', () => {
    const normalized = normalizeBackendPromoBlocks({
        promoBlocks: [
            { startSec: 18, endSec: 24, confidence: 'medium' },
            { startSec: 4, endSec: 10, confidence: 'high' },
            { startSec: 9, endSec: 20, confidence: 'low' },
        ],
        durationSec: 120,
    });

    expect(normalized).toEqual({
        ok: true,
        promoBlocks: [{ startSec: 4, endSec: 24, confidence: 'high' }],
    });
});

it.each([
    [[{ startSec: 130, endSec: 140 }], 'out-of-bounds start'],
    [[{ startSec: 4, endSec: 130 }], 'out-of-bounds end'],
    [[{ startSec: 100 }], 'open-ended implied end beyond duration'],
    [[{ startSec: 0, endSec: 120 }], 'full-video degenerate'],
] as const)('rejects unsafe blocks: %s', (promoBlocks) => {
    expect(
        normalizeBackendPromoBlocks({
            promoBlocks,
            durationSec: 120,
        }),
    ).toMatchObject({
        ok: false,
        failureReason: BACKEND_ANALYSIS_FAILURE_REASON.UnsafeModelBlocks,
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/backend/promo-analysis-worker.test.ts`

Expected: FAIL with missing parser and normalizer modules.

- [x] **Step 3: Write minimal implementation**

Create a backend parser that strips optional fences, parses JSON as `unknown`, validates with `llmPromoDetectionSchema`, and maps parse/schema failures to `InvalidModelResponse`. Create a normalizer that:

- Parses each raw block through `promoBlockSchema`.
- Imports `DEFAULT_PROMO_BLOCK_DURATION_SEC` from `src/shared/promo-block.ts`.
- Rejects non-finite, negative, reversed, out-of-known-duration, and full-video blocks before delivery.
- For blocks without `endSec`, computes `impliedEndSec = startSec + DEFAULT_PROMO_BLOCK_DURATION_SEC` when `durationSec` is known and rejects the block if `impliedEndSec > durationSec`.
- Calls `sortAndDedupePromoBlocks` for deterministic sorted/non-overlapping output.
- Re-checks merged blocks against the same duration, implied-open-ended duration, and full-video rules.
- Returns `UnsafeModelBlocks` on unsafe block failures.

Use named constants such as `MIN_TIMELINE_SEC`, `FULL_VIDEO_BLOCK_START_SEC`, and `OPEN_ENDED_BLOCK_IMPLIED_DURATION_SEC` instead of repeated semantic literals; define `OPEN_ENDED_BLOCK_IMPLIED_DURATION_SEC` from `DEFAULT_PROMO_BLOCK_DURATION_SEC` so backend delivery matches content-side block interpretation.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/backend/promo-analysis-worker.test.ts`

Expected: PASS for parser and normalizer cases.

**Verification**: The backend rejects unsafe model timings, including open-ended blocks whose implied default-duration end exceeds the known video duration, and only emits sorted, non-overlapping blocks.

### [x] Task 4: Deterministic Local Analysis Adapter

**Files:**

- Create: `src/backend/analysis/local-analysis-fixtures.ts`
- Modify: `tests/backend/promo-analysis-worker.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import { LocalPromoAnalysisFixtureAdapter } from '@/backend/analysis/local-analysis-fixtures';
import { LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS } from '@/backend/extraction/local-transcript-fixtures';

it('returns deterministic raw promo JSON for the primary transcript fixture', () => {
    const artifact = makeTranscriptArtifact({
        videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
    });

    expect(
        LocalPromoAnalysisFixtureAdapter.analyze({
            transcriptArtifact: artifact,
        }),
    ).toBe(
        '{"hasPromo":true,"promoBlocks":[{"startSec":4,"endSec":24,"confidence":"high"},{"startSec":35,"endSec":45,"confidence":"medium"}]}',
    );
});

it('returns deterministic raw no-promo JSON for the secondary transcript fixture', () => {
    const artifact = makeTranscriptArtifact({
        videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Secondary,
    });

    expect(
        LocalPromoAnalysisFixtureAdapter.analyze({
            transcriptArtifact: artifact,
        }),
    ).toBe('{"hasPromo":false,"confidence":"medium"}');
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/backend/promo-analysis-worker.test.ts`

Expected: FAIL with missing module `@/backend/analysis/local-analysis-fixtures`.

- [x] **Step 3: Write minimal implementation**

Create `LocalPromoAnalysisFixtureAdapter` with `providerId: BACKEND_ANALYSIS_PROVIDER_ID.LocalFixture`. Return exact JSON strings keyed by `transcriptArtifact.videoId`:

- `LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary` -> two promo blocks at `4-24` and `35-45`.
- `LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Secondary` -> `hasPromo: false`.
- Any other selected transcript -> `hasPromo: false` so future extraction fixtures have a safe default until a fixture-specific expected output is added.

The adapter must not call network APIs, read environment variables, or inspect browser globals.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/backend/promo-analysis-worker.test.ts`

Expected: PASS for deterministic fixture adapter tests.

**Verification**: Local analysis is deterministic, offline, and keyed to selected transcript metadata.

### [x] Task 5: Promo Analysis Worker

**Files:**

- Create: `src/backend/analysis/promo-analysis-worker.ts`
- Modify: `tests/backend/promo-analysis-worker.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import { BackendPromoAnalysisWorker } from '@/backend/analysis/promo-analysis-worker';

it('records raw output and returns ready normalized blocks', () => {
    const result = BackendPromoAnalysisWorker.analyze({
        transcriptArtifact: makeTranscriptArtifact({ videoId: 'dQw4w9WgXcQ' }),
        durationSec: 120,
        nowMs: 1_900_000_001_000,
    });

    expect(result.terminalResponse).toMatchObject({
        status: 'ready',
        videoId: 'dQw4w9WgXcQ',
        source: 'server_cache',
        sourceResultId: 'result-dQw4w9WgXcQ-server-v1',
        promoBlocks: [
            { startSec: 4, endSec: 24, confidence: 'high' },
            { startSec: 35, endSec: 45, confidence: 'medium' },
        ],
    });
    expect(result.analysisRun.rawModelResponse).toContain('promoBlocks');
    expect(result.analysisRun.parsedResult).toMatchObject({ hasPromo: true });
});

it('records no-promo analysis without delivering blocks', () => {
    const result = BackendPromoAnalysisWorker.analyze({
        transcriptArtifact: makeTranscriptArtifact({ videoId: 'M7lc1UVf-VE' }),
        durationSec: 120,
        nowMs: 1_900_000_001_000,
    });

    expect(result.terminalResponse).toMatchObject({
        status: 'no_promo',
        videoId: 'M7lc1UVf-VE',
        sourceResultId: 'result-M7lc1UVf-VE-server-v1',
    });
    expect(result.analysisRun.normalizedPromoBlocks).toEqual([]);
});

it.each([
    {
        raw: 'not json',
        expectedCode: SERVER_ANALYSIS_ERROR_CODE.InvalidModelResponse,
    },
    {
        raw: '{"hasPromo":true,"promoBlocks":[{"startSec":0,"endSec":120}]}',
        expectedCode: SERVER_ANALYSIS_ERROR_CODE.UnsafeModelBlocks,
    },
    {
        raw: '{"hasPromo":true,"promoBlocks":[{"startSec":100}]}',
        expectedCode: SERVER_ANALYSIS_ERROR_CODE.UnsafeModelBlocks,
    },
] as const)('returns terminal error for unsafe output', ({ raw, expectedCode }) => {
    const result = BackendPromoAnalysisWorker.analyze({
        transcriptArtifact: makeTranscriptArtifact({ videoId: 'dQw4w9WgXcQ' }),
        durationSec: 120,
        nowMs: 1_900_000_001_000,
        adapter: {
            providerId: 'test_adapter',
            analyze: () => raw,
        },
    });

    expect(result.terminalResponse).toMatchObject({
        status: 'error',
        error: { code: expectedCode },
    });
    expect(result.analysisRun.provider).toBe('test_adapter');
    expect(result.terminalResponse).not.toHaveProperty('promoBlocks');
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/backend/promo-analysis-worker.test.ts`

Expected: FAIL with missing module `@/backend/analysis/promo-analysis-worker`.

- [x] **Step 3: Write minimal implementation**

Implement `BackendPromoAnalysisWorker.analyze` as a static-only class method:

1. Validate `adapter.providerId` with `backendAnalysisProviderIdSchema`; if it fails, return a `ModelProviderError` terminal response and store an analysis run with a safe fallback provider id such as `invalid_provider_metadata` only if the schema can validate that fallback.
2. Build an `AnalysisRunArtifact` skeleton with deterministic `runId`, `transcriptArtifactId`, `videoId`, `algorithmVersion`, `provider: adapter.providerId`, timestamps, and `rawModelResponse: null`.
3. Call the adapter inside `try/catch`.
4. Store raw output exactly when the adapter returns a string.
5. Parse raw output with `parseBackendPromoResponse`.
6. Return `NoPromoResponse` when `parsedResult.hasPromo` is `false`.
7. Normalize promo blocks when `hasPromo` is `true`; this includes rejecting open-ended blocks whose `startSec + DEFAULT_PROMO_BLOCK_DURATION_SEC` exceeds known `durationSec`.
8. Return `ReadyResponse` only when normalized blocks parse through `readyResponseSchema`.
9. Return `TerminalErrorResponse` with `SERVER_ANALYSIS_ERROR_CODE.InvalidModelResponse`, `UnsafeModelBlocks`, or `ModelProviderError` for failures.

Use the same freshness value as current local fixtures, `4_102_444_800_000`, but extract it into a named backend analysis constant such as `LOCAL_ANALYSIS_RESULT_EXPIRES_AT_MS` in the worker module.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/backend/promo-analysis-worker.test.ts`

Expected: PASS.

**Verification**: Worker results always include an analysis artifact and exactly one terminal response; unsafe outputs never include blocks. The artifact provider is copied from the adapter used for that run, including injected test adapters, rather than hard-coded to the local fixture provider.

### [x] Task 6: Integrate Worker with Job Status

**Files:**

- Modify: `src/backend/analysis-jobs.ts`
- Modify: `tests/backend/analysis-jobs.test.ts`

- [x] **Step 1: Write the failing test**

```ts
it('runs analysis on first status poll for a selected transcript job', () => {
    BackendAnalysisJobs.resetForTests();

    const processing = BackendAnalysisJobs.start({
        videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        durationSec: 120,
        nowMs: 1_900_000_000_000,
    });
    if (processing.status !== 'processing') {
        throw new Error('Expected processing response.');
    }

    const ready = BackendAnalysisJobs.getStatus(processing.jobId, {
        nowMs: 1_900_000_001_000,
    });

    expect(ready).toMatchObject({
        status: 'ready',
        videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
        promoBlocks: [
            { startSec: 4, endSec: 24, confidence: 'high' },
            { startSec: 35, endSec: 45, confidence: 'medium' },
        ],
    });
    const diagnostics = BackendAnalysisJobs.getDiagnosticsForTests(
        processing.jobId,
    );
    expect(diagnostics?.stage).toBe('complete');
    expect(diagnostics?.analysisRun?.rawModelResponse).toContain('promoBlocks');
});

it('does not re-run analysis after a terminal response exists', () => {
    BackendAnalysisJobs.resetForTests();

    const processing = BackendAnalysisJobs.start({
        videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        durationSec: 120,
        nowMs: 1_900_000_000_000,
    });
    if (processing.status !== 'processing') {
        throw new Error('Expected processing response.');
    }

    const first = BackendAnalysisJobs.getStatus(processing.jobId, {
        nowMs: 1_900_000_001_000,
    });
    const second = BackendAnalysisJobs.getStatus(processing.jobId, {
        nowMs: 1_900_000_999_000,
    });

    expect(second).toEqual(first);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/backend/analysis-jobs.test.ts`

Expected: FAIL because `getStatus` still returns the processing response and diagnostics do not expose `analysisRun`.

- [x] **Step 3: Write minimal implementation**

Update `src/backend/analysis-jobs.ts`:

- Add `Analyzing: 'analyzing'` to `ANALYSIS_JOB_STAGE`.
- Add `durationSec: number | undefined` and `analysisRun: AnalysisRunArtifact | null` to `AnalysisJobRecord`.
- Add optional `durationSec` to `BackendAnalysisJobs.start` input and persist it.
- Extend `AnalysisJobDiagnostics` with `analysisRun`.
- Change `getStatus(jobId, options = {})` so a record in `awaiting_analysis` with a selected transcript calls a new private `runAnalysis(record, nowMs)` method.
- `runAnalysis` sets stage to `analyzing`, calls `BackendPromoAnalysisWorker.analyze`, stores `analysisRun`, `terminalResponse`, and `completedAtMs`, sets stage to `complete`, and returns the terminal response.
- If a terminal response already exists, return it without calling the worker.

Keep `completeFixture` behavior intact for jobs that have not already reached a terminal response.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/backend/analysis-jobs.test.ts`

Expected: PASS.

**Verification**: Polling a processing job now advances the backend lifecycle to a terminal analysis result exactly once.

### [x] Task 7: API and HTTP Status Delivery

**Files:**

- Modify: `src/backend/analysis-api.ts`
- Modify: `tests/backend/analysis-api.test.ts`
- Modify: `tests/backend/server.test.ts`

- [x] **Step 1: Write the failing test**

```ts
it('returns ready blocks when polling a worker-backed cold job', () => {
    const initial = BackendAnalysisApi.handleAnalysisRequest({
        videoId: 'dQw4w9WgXcQ',
        durationSec: 120,
        extensionVersion: '0.1.0',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        client: {
            source: 'chrome-extension',
            capabilities: ['processing-status'],
        },
    });

    expect(initial.statusCode).toBe(202);
    if (initial.body.status !== 'processing') {
        throw new Error('Expected processing response.');
    }

    const status = BackendAnalysisApi.handleJobStatusRequest(
        initial.body.jobId,
        { nowMs: 1_900_000_001_000 },
    );

    expect(status).toEqual({
        statusCode: 200,
        body: {
            status: 'ready',
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            source: 'server_cache',
            sourceResultId: 'result-dQw4w9WgXcQ-server-v1',
            freshness: { expiresAtMs: 4_102_444_800_000 },
            promoBlocks: [
                { startSec: 4, endSec: 24, confidence: 'high' },
                { startSec: 35, endSec: 45, confidence: 'medium' },
            ],
        },
    });
});
```

Add an HTTP test that posts the same request to `/v1/analysis`, then performs `GET /v1/analysis/jobs/{jobId}` and expects HTTP `200` with the same ready body. Add a secondary-fixture test that expects `no_promo`.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/backend/analysis-api.test.ts tests/backend/server.test.ts`

Expected: FAIL because API status reads still return `202 processing`.

- [x] **Step 3: Write minimal implementation**

Update `BackendAnalysisApi.handleAnalysisRequest` to pass `parsed.output.durationSec` into `BackendAnalysisJobs.start`. Add an optional `{ nowMs?: number }` parameter to `handleJobStatusRequest` and pass it into `BackendAnalysisJobs.getStatus` so tests can assert deterministic timestamps while HTTP keeps using `Date.now()`.

Update backend tests that currently expect status to remain processing:

- The initial `POST /v1/analysis` response remains `202 processing`.
- The status read now returns terminal ready/no-promo/error.
- Duplicate cold requests after terminal analysis return the terminal response through `findExisting`.
- Extraction failure for `unknownVid1` remains `unavailable` and does not run analysis.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/backend/analysis-api.test.ts tests/backend/server.test.ts`

Expected: PASS.

**Verification**: The public local backend path now turns a selected transcript into a pollable terminal result.

### [x] Task 8: Extension Polling Path Regression

**Files:**

- Modify: `tests/background/messaging/server-analysis-runtime-messages.test.ts`

- [x] **Step 1: Write the failing or confirming test**

```ts
it('maps worker model errors from status refresh without delivering blocks', async () => {
    clientMocks.requestJobStatus.mockResolvedValueOnce({
        status: 'error',
        videoId: 'dQw4w9WgXcQ',
        algorithmVersion: 'server-v1',
        error: {
            code: 'unsafe_model_blocks',
            message: 'Model returned unsafe promo blocks.',
        },
    });

    const result = await ServerAnalysisRuntimeMessages.handleRefreshStatus(
        {
            videoId: 'dQw4w9WgXcQ',
            jobId: 'local-dQw4w9WgXcQ-server-v1',
        },
        { tab: { id: 42 } } as never,
    );

    expect(result).toEqual({ ok: true, status: 'error' });
    expect(browserMocks.tabsSendMessage).not.toHaveBeenCalled();
    expect(detectionMocks.set).toHaveBeenCalledWith(42, {
        videoId: 'dQw4w9WgXcQ',
        status: 'error',
        source: 'server',
        error: 'Model returned unsafe promo blocks.',
    });
});
```

- [x] **Step 2: Run test to verify it fails or confirms existing behavior**

Run: `pnpm run test tests/background/messaging/server-analysis-runtime-messages.test.ts`

Expected: PASS if the runtime message handler is already independent of error-code literals; otherwise FAIL with the type/fixture mismatch that must be updated.

- [x] **Step 3: Write minimal implementation**

No production code should be needed unless the test reveals a literal union mismatch. If TypeScript rejects the new code, update only test fixtures or shared response types so `TerminalErrorResponse.error.code` accepts the new stable codes while runtime mapping continues to use `error.message`.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/background/messaging/server-analysis-runtime-messages.test.ts`

Expected: PASS.

**Verification**: Worker-produced terminal errors never deliver promo blocks, while worker-produced ready responses continue through the existing status-refresh delivery path.

### [x] Task 9: Focused Final Verification

**Files:**

- No source file changes beyond prior tasks.

- [x] **Step 1: Run focused backend and runtime tests**

Run:

```bash
pnpm run test \
  tests/shared/server-analysis-contract.test.ts \
  tests/backend/promo-analysis-worker.test.ts \
  tests/backend/analysis-jobs.test.ts \
  tests/backend/analysis-api.test.ts \
  tests/backend/server.test.ts \
  tests/background/messaging/server-analysis-runtime-messages.test.ts
```

Expected: PASS.

- [x] **Step 2: Run type checking for changed contracts**

Run: `pnpm run lint:types`

Expected: PASS.

- [x] **Step 3: Run full lint when time allows before PR handoff**

Run: `pnpm run lint`

Expected: PASS.

**Verification**: The analysis worker, server response contract, HTTP status path, and extension polling path agree at both runtime-test and TypeScript levels.

## Self-Review Notes

- Acceptance criterion 1 is covered by Tasks 2, 5, and 6: analysis run artifacts store `rawModelResponse`, `parsedResult`, and job diagnostics expose the run.
- Acceptance criterion 2 is covered by Tasks 3, 5, and 7: normalization sorts, dedupes, validates explicit duration bounds, rejects open-ended blocks whose implied default-duration end exceeds known duration, and `ReadyResponse` contains normalized blocks.
- Acceptance criterion 3 is covered by Tasks 1, 3, 5, and 8: no-promo returns `no_promo`; invalid JSON, explicit out-of-bounds timestamps, open-ended duration overruns, full-video blocks, and provider errors return terminal `error` responses without `promoBlocks`.
- Acceptance criterion 4 is covered by Tasks 6, 7, and 8: `GET /v1/analysis/jobs/{jobId}` returns worker-produced ready blocks and the existing extension refresh handler delivers them through `PROMO_BLOCKS_DETECTED`.
- Review finding 1 is resolved by the Backend LLM Analysis Adapter and Analysis Run Artifact entity sections plus Tasks 2, 4, and 5: provider metadata is `providerId` owned by `BackendLlmAnalysisAdapter`, `analysisRunArtifactSchema.provider` uses `backendAnalysisProviderIdSchema` instead of a local-fixture literal, and worker tests assert injected `test_adapter` is stored on the run artifact.
- Review finding 2 is resolved by the Normalized Promo Blocks entity section plus Tasks 3 and 5: normalization imports `DEFAULT_PROMO_BLOCK_DURATION_SEC`, checks implied ends for blocks without `endSec`, and worker tests include an unsafe open-ended model output before delivery.
- No new API endpoint, durable database, production LLM provider, user-facing UI, or browser runtime fallback is included in this issue.
