# Implementation Plan: Subtitle Extraction Pipeline with First Local Strategy

- **Created**: 2026-07-07
- **Status**: Approved
- **Issue**: `.sdd/.current/issues/6-AFK/issue.md`
- **PRD**: `.sdd/.current/prd.md`
- **Model**: GPT-5 Codex
- **User Input**: `ISSUE_ID=6-AFK`, `SPECS_DIR=.sdd/.current`, constraints: no additional constraints.

## Summary

Add a backend-owned subtitle extraction pipeline that runs when a local cold analysis job is created. The pipeline will define the reusable extraction strategy contract, execute a deterministic fixture-backed local strategy, validate that selected transcripts are non-empty and ordered, and store structured attempt diagnostics on the in-memory job record. Supported fixture videos continue to return `processing` because the LLM analysis worker is owned by the next issue; unsupported or invalid extraction results become a terminal `unavailable` response with no promo blocks, so the existing extension server-status path does not skip playback.

## Technical Context

- **Language/Version**: TypeScript 6.0.2 in strict ESM mode; Node.js `>=20`.
- **Primary Dependencies**: Valibot 1.3 for schemas and validated boundaries, Node `http` for the local backend, Vitest 4 for unit/integration tests, `tsx` for `pnpm run backend:dev`.
- **Storage**: No durable backend storage in this slice. Transcript artifacts and extraction attempts are stored in the existing process-local in-memory job record.
- **Testing**: Vitest tests under `tests/backend/**` and `tests/shared/server-analysis-contract.test.ts`; focused command is `pnpm run test tests/shared/server-analysis-contract.test.ts tests/backend/subtitle-extraction-pipeline.test.ts tests/backend/analysis-jobs.test.ts tests/backend/analysis-api.test.ts tests/backend/server.test.ts`.
- **Target Platform**: Local Node backend at `http://127.0.0.1:8787`, consumed by the Chrome MV3 extension background client.

## Research

### Current Backend Job Store

`src/backend/analysis-jobs.ts:47` defines the in-memory `AnalysisJobRecord` with only job identity, timestamps, a processing response, and an optional terminal response. `BackendAnalysisJobs.start` at `src/backend/analysis-jobs.ts:79` creates a processing response and stores the job, but it does not yet run any extraction stage or keep artifacts. This is the right integration point: request validation and rate limiting have already happened by the time `start` is called, and duplicate requests still return the existing record.

### Current Cold-Request API Flow

`src/backend/analysis-api.ts:68` validates raw requests, checks seeded ready cache fixtures at `src/backend/analysis-api.ts:101`, joins existing jobs at `src/backend/analysis-api.ts:113`, applies the cold-start rate-limit hook at `src/backend/analysis-api.ts:125`, then calls `BackendAnalysisJobs.start` at `src/backend/analysis-api.ts:136`. The extraction pipeline should run inside the job start path so cache hits and duplicate joins remain cheap and invalid requests still cannot start extraction.

### Unavailable Response Contract

`src/shared/server-analysis-contract.ts:137` currently restricts `UnavailableResponse.reason` to `fixture_unavailable`. Extraction failure needs a stage-specific reason, so the schema should add a named `caption_extraction_failed` reason while preserving the existing fixture completion reason. The extension already consumes `unavailable` terminal responses through the shared successful response union at `src/shared/server-analysis-contract.ts:173`.

### Existing Extension Non-Skipping Behavior

`src/background/messaging/server-analysis-runtime-messages.ts:115` maps backend `unavailable` responses into popup detection state and returns `{ ok: true, status: 'unavailable' }` without sending `PROMO_BLOCKS_DETECTED`. No content or popup code changes are needed for this issue because the new extraction failure path uses the same terminal status.

### Existing Caption Vocabulary

`src/shared/caption-types.ts:6` defines `CaptionSegment` as `{ startSec, durationSec, text }`. The backend transcript artifact should reuse this segment shape and add stricter backend validation for ordered, finite, non-empty segments before a transcript can be selected.

### Existing Tests to Extend

`tests/backend/analysis-jobs.test.ts:7` already verifies job creation, dedupe, fixture terminal completion, and unknown job reads. Add extraction-specific job assertions there rather than creating a second job store test surface. `tests/backend/analysis-api.test.ts:22` and `tests/backend/server.test.ts:156` already cover cold request and HTTP polling behavior; extend them so supported fixtures still produce `processing` while unsupported fixtures immediately produce terminal `unavailable`.

### Dependency Status

Issue `4-AFK` is `Validated`, so this plan can rely on the cold job lifecycle, job status route, fixture completion hook, terminal response union, content-owned polling, and background `unavailable` mapping. Issue `5-AFK` is also `Validated`, so invalid requests and rate-limited cold starts already happen before job creation.

### Sub-Agent Availability

The explorer prompt exists at `/Users/maximtop/.codex/skills/oneshot-agent/agents/oneshot-explorer.agent.md`, but no sub-agent launch tool is available in this session. Repository exploration was performed locally with `rg`, `find`, `sed`, and targeted `nl -ba` reads.

## Entities

### Subtitle Extraction Strategy

- **Fields**:
    - `name`: `string` - stable strategy id such as `local_transcript_fixture`.
    - `extract(input)`: function that receives `videoId` and returns a strategy result.
- **Relationships**: Registered in the pipeline's default strategy list; test code can inject additional deterministic strategies to prove ordering, timeout, and error mapping without adding production strategies.
- **Validation**: Strategy output is not trusted until the pipeline validates the resulting transcript artifact. Strategy names must be non-empty and safe to store in diagnostics.
- **States**: available to run, succeeded, failed, timed out, or threw an exception that is mapped to a safe failed attempt.

### Extraction Attempt

- **Fields**:
    - `strategy`: `string` - strategy id that produced the attempt.
    - `status`: `'succeeded' | 'failed' | 'timed_out'`.
    - `startedAtMs`: `number` - deterministic timestamp supplied by the job.
    - `completedAtMs`: `number` - deterministic timestamp supplied by the job.
    - `failureReason`: `'fixture_not_found' | 'empty_transcript' | 'unordered_segments' | 'strategy_error' | 'strategy_timeout' | undefined`.
    - `diagnostics`: `{ code: string; detail?: string }` - bounded, safe metadata only.
- **Relationships**: Stored on `AnalysisJobRecord.extractionAttempts`; every configured strategy gets an attempt entry until a transcript is selected or all strategies fail.
- **Validation**: Diagnostics must not include raw cookies, account tokens, extension secrets, API keys, thrown error messages, stack traces, or full URLs. Error mapping uses stable codes instead of untrusted exception text.
- **States**: `failed`, `timed_out`, or `succeeded`.

### Transcript Artifact

- **Fields**:
    - `artifactId`: `string` - stable local id such as `transcript-dQw4w9WgXcQ-server-v1-local_transcript_fixture`.
    - `videoId`: `string` - canonical YouTube-shaped id from the validated request.
    - `algorithmVersion`: `string` - server algorithm/cache version for the job.
    - `strategy`: `string` - strategy id that selected the artifact.
    - `sourceType`: `'local_fixture'`.
    - `languageCode`: `string | null` - fixture language when known.
    - `segments`: `CaptionSegment[]` - ordered timed transcript cues.
    - `transcriptText`: `string` - joined non-empty cue text for the later analysis worker.
    - `acquiredAtMs`: `number` - timestamp from the job start.
- **Relationships**: Produced by the subtitle extraction pipeline; stored as `AnalysisJobRecord.selectedTranscriptArtifact`; consumed by issue `7-AFK`.
- **Validation**: The artifact must have at least one segment; every segment must have finite `startSec` and `durationSec`, non-negative start and duration, and non-empty trimmed text; segment starts must be ordered; `transcriptText.trim()` must be non-empty.
- **States**: candidate, selected, or rejected before storage.

### Analysis Job Record

- **Fields**:
    - Existing fields: `jobId`, `jobKey`, `videoId`, `algorithmVersion`, `pollAfterSec`, `createdAtMs`, `completedAtMs`, `processingResponse`, `terminalResponse`.
    - New fields: `stage`, `extractionAttempts`, `selectedTranscriptArtifact`.
- **Relationships**: Created by `BackendAnalysisJobs.start`; inspected by tests through a new diagnostics helper; returned through existing status reads as either `processing` or a terminal response.
- **Validation**: Supported fixtures leave the job in `stage: 'awaiting_analysis'` with a selected transcript and a processing response. Failed extraction sets `stage: 'complete'`, `completedAtMs`, and a terminal `unavailable` response with no promo blocks.
- **States**: `extracting -> awaiting_analysis` for successful extraction, or `extracting -> complete` for extraction failure. Existing fixture completion can still move `awaiting_analysis -> complete`.

### Extraction Unavailable Response

- **Fields**:
    - `status`: `'unavailable'`.
    - `videoId`: `string`.
    - `algorithmVersion`: `string`.
    - `reason`: `'caption_extraction_failed'`.
    - `message`: `string`.
- **Relationships**: Built by `BackendAnalysisJobs` when every configured extraction strategy fails; consumed by existing background server analysis mapping.
- **Validation**: Must parse through `unavailableResponseSchema`; must not include transcript text, secret values, raw exception text, or promo blocks.
- **States**: Terminal response for the current job and future duplicate cold requests for the same video/version.

## Contracts

N/A - no new API endpoints are required. The existing `POST /v1/analysis` and `GET /v1/analysis/jobs/{jobId}` response union gains a broader `UnavailableResponse.reason` value through `src/shared/server-analysis-contract.ts`. No `.sdd/.current/issues/6-AFK/contracts/` files are needed for this issue.

## File Structure

| File | Action | Responsibility |
| --- | --- | --- |
| `src/shared/server-analysis-contract.ts` | Modify | Adds named unavailable reason constants and allows `caption_extraction_failed` while preserving `fixture_unavailable`. |
| `tests/shared/server-analysis-contract.test.ts` | Modify | Verifies extraction unavailable responses parse and invalid unavailable reasons fail. |
| `src/backend/extraction/subtitle-extraction-types.ts` | Create | Defines internal extraction strategy, attempt, result, and transcript artifact schemas/types. |
| `src/backend/extraction/local-transcript-fixtures.ts` | Create | Provides deterministic local transcript fixtures and the first fixture-backed extraction strategy. |
| `src/backend/extraction/subtitle-extraction-pipeline.ts` | Create | Runs strategies in order, validates transcript artifacts, maps failure/timeout/error outcomes, and emits safe attempt diagnostics. |
| `tests/backend/subtitle-extraction-pipeline.test.ts` | Create | Covers successful fixture selection, multiple attempt records, unavailable captions, timeout/error mapping, redaction-safe diagnostics, and empty transcript rejection. |
| `src/backend/analysis-jobs.ts` | Modify | Runs extraction during cold job creation, stores attempts/artifact, exposes diagnostics for tests, and completes failed extraction as unavailable. |
| `tests/backend/analysis-jobs.test.ts` | Modify | Verifies successful extraction artifacts on supported jobs, terminal unavailable jobs on unsupported videos, duplicate terminal reuse, and fixture completion after extraction success. |
| `src/backend/analysis-api.ts` | Modify | Updates comments and relies on the new job start result so extraction failures return the existing terminal response shape. |
| `tests/backend/analysis-api.test.ts` | Modify | Verifies supported fixtures still return `202 processing`, unsupported fixtures return `200 unavailable`, and rate-limited requests do not run extraction. |
| `tests/backend/server.test.ts` | Modify | Verifies HTTP cold requests for unsupported fixtures return terminal `unavailable` and supported fixture jobs still poll and complete through the existing fixture hook. |

## Tasks

### [x] Task 1: Shared Unavailable Reason Contract

**Files:**

- Modify: `src/shared/server-analysis-contract.ts`
- Modify: `tests/shared/server-analysis-contract.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import {
    SERVER_ANALYSIS_UNAVAILABLE_REASON,
    unavailableResponseSchema,
} from '@/shared/server-analysis-contract';

it('parses extraction unavailable responses', () => {
    const parsed = v.parse(unavailableResponseSchema, {
        status: 'unavailable',
        videoId: 'unknownVid1',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        reason: SERVER_ANALYSIS_UNAVAILABLE_REASON.CaptionExtractionFailed,
        message: 'Caption extraction failed for this video.',
    });

    expect(parsed.reason).toBe('caption_extraction_failed');
});

it('rejects unknown unavailable reasons', () => {
    expect(
        v.safeParse(unavailableResponseSchema, {
            status: 'unavailable',
            videoId: 'unknownVid1',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            reason: 'raw_provider_error',
            message: 'Caption extraction failed for this video.',
        }).success,
    ).toBe(false);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/shared/server-analysis-contract.test.ts`

Expected: FAIL with missing export `SERVER_ANALYSIS_UNAVAILABLE_REASON` or rejection of `caption_extraction_failed`.

- [x] **Step 3: Write minimal implementation**

Add named reason constants next to the terminal response schemas and use them in `unavailableResponseSchema`:

```ts
export const SERVER_ANALYSIS_UNAVAILABLE_REASON = {
    FixtureUnavailable: 'fixture_unavailable',
    CaptionExtractionFailed: 'caption_extraction_failed',
} as const;

const unavailableReasonSchema = v.picklist([
    SERVER_ANALYSIS_UNAVAILABLE_REASON.FixtureUnavailable,
    SERVER_ANALYSIS_UNAVAILABLE_REASON.CaptionExtractionFailed,
] as const);

export const unavailableResponseSchema = v.strictObject({
    status: v.literal('unavailable'),
    videoId: youtubeVideoIdSchema,
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    reason: unavailableReasonSchema,
    message: v.pipe(v.string(), v.minLength(1)),
});
```

Update the existing fixture unavailable response builder to use `SERVER_ANALYSIS_UNAVAILABLE_REASON.FixtureUnavailable` instead of repeating the string.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/shared/server-analysis-contract.test.ts`

Expected: PASS.

**Verification**: The server response union accepts the stage-specific extraction unavailable reason without weakening strict response validation.

### [x] Task 2: Backend Extraction Entity Types

**Files:**

- Create: `src/backend/extraction/subtitle-extraction-types.ts`
- Create: `tests/backend/subtitle-extraction-pipeline.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import {
    subtitleExtractionAttemptSchema,
    transcriptArtifactSchema,
} from '@/backend/extraction/subtitle-extraction-types';
import { SERVER_ANALYSIS_ALGORITHM_VERSION } from '@/shared/server-analysis-contract';

it('validates selected transcript artifacts', () => {
    const parsed = v.parse(transcriptArtifactSchema, {
        artifactId: 'transcript-dQw4w9WgXcQ-server-v1-local_transcript_fixture',
        videoId: 'dQw4w9WgXcQ',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        strategy: 'local_transcript_fixture',
        sourceType: 'local_fixture',
        languageCode: 'en',
        acquiredAtMs: 1_900_000_000_000,
        segments: [
            { startSec: 0, durationSec: 2, text: 'Intro' },
            { startSec: 4, durationSec: 3, text: 'Sponsor begins' },
        ],
        transcriptText: 'Intro\nSponsor begins',
    });

    expect(parsed.segments).toHaveLength(2);
});

it('rejects empty transcript artifacts before analysis can consume them', () => {
    expect(
        v.safeParse(transcriptArtifactSchema, {
            artifactId: 'transcript-emptyCapt01-server-v1-local_transcript_fixture',
            videoId: 'emptyCapt01',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            strategy: 'local_transcript_fixture',
            sourceType: 'local_fixture',
            languageCode: 'en',
            acquiredAtMs: 1_900_000_000_000,
            segments: [],
            transcriptText: '',
        }).success,
    ).toBe(false);
});

it('validates bounded extraction attempts', () => {
    const parsed = v.parse(subtitleExtractionAttemptSchema, {
        strategy: 'local_transcript_fixture',
        status: 'failed',
        startedAtMs: 1_900_000_000_000,
        completedAtMs: 1_900_000_000_000,
        failureReason: 'fixture_not_found',
        diagnostics: { code: 'fixture_not_found' },
    });

    expect(parsed.diagnostics).toEqual({ code: 'fixture_not_found' });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/backend/subtitle-extraction-pipeline.test.ts`

Expected: FAIL with missing module `@/backend/extraction/subtitle-extraction-types`.

- [x] **Step 3: Write minimal implementation**

Create backend-local schemas and types. Keep them out of `src/shared/` because they are not a cross-bundle runtime message contract.

```ts
const finiteNonNegativeNumberSchema = v.pipe(
    v.number(),
    v.check(Number.isFinite, 'Timeline values must be finite.'),
    v.minValue(0),
);

const finitePositiveIntegerSchema = v.pipe(
    v.number(),
    v.check(Number.isFinite, 'Epoch milliseconds must be finite.'),
    v.integer(),
    v.minValue(1),
);

export const SUBTITLE_EXTRACTION_ATTEMPT_STATUS = {
    Succeeded: 'succeeded',
    Failed: 'failed',
    TimedOut: 'timed_out',
} as const;

export const SUBTITLE_EXTRACTION_FAILURE_REASON = {
    FixtureNotFound: 'fixture_not_found',
    EmptyTranscript: 'empty_transcript',
    UnorderedSegments: 'unordered_segments',
    StrategyError: 'strategy_error',
    StrategyTimeout: 'strategy_timeout',
} as const;

const safeDiagnosticSchema = v.strictObject({
    code: v.pipe(v.string(), v.minLength(1)),
    detail: v.optional(v.pipe(v.string(), v.minLength(1))),
});

const timedTranscriptSegmentSchema = v.strictObject({
    startSec: finiteNonNegativeNumberSchema,
    durationSec: finiteNonNegativeNumberSchema,
    text: v.pipe(v.string(), v.trim(), v.minLength(1)),
});

export const transcriptArtifactSchema = v.pipe(
    v.strictObject({
        artifactId: v.pipe(v.string(), v.minLength(1)),
        videoId: youtubeVideoIdSchema,
        algorithmVersion: v.pipe(v.string(), v.minLength(1)),
        strategy: v.pipe(v.string(), v.minLength(1)),
        sourceType: v.literal('local_fixture'),
        languageCode: v.nullable(v.pipe(v.string(), v.minLength(1))),
        acquiredAtMs: finitePositiveIntegerSchema,
        segments: v.pipe(v.array(timedTranscriptSegmentSchema), v.minLength(1)),
        transcriptText: v.pipe(v.string(), v.trim(), v.minLength(1)),
    }),
    v.check(
        (artifact) =>
            artifact.segments.every((segment, index, segments) => {
                const previous = segments[index - 1];
                return (
                    previous === undefined ||
                    segment.startSec >= previous.startSec
                );
            }),
        'Transcript segments must be ordered.',
    ),
);
```

Also export `SubtitleExtractionStrategy`, `SubtitleExtractionStrategyResult`, `TranscriptArtifact`, `SubtitleExtractionAttempt`, and `SubtitleExtractionPipelineResult` inferred or composed from these schemas.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/backend/subtitle-extraction-pipeline.test.ts`

Expected: PASS for the entity validation tests.

**Verification**: Backend extraction has strict internal types that reject empty or unordered transcripts before issue `7-AFK` can consume them.

### [x] Task 3: Deterministic Local Transcript Strategy

**Files:**

- Create: `src/backend/extraction/local-transcript-fixtures.ts`
- Modify: `tests/backend/subtitle-extraction-pipeline.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import {
    LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS,
    LocalTranscriptFixtureStrategy,
} from '@/backend/extraction/local-transcript-fixtures';

it('returns a fixture transcript for supported local videos', () => {
    const result = LocalTranscriptFixtureStrategy.extract({
        videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        nowMs: 1_900_000_000_000,
    });

    expect(result.status).toBe('succeeded');
    if (result.status !== 'succeeded') {
        throw new Error('Expected local fixture transcript.');
    }
    expect(result.artifact.strategy).toBe('local_transcript_fixture');
    expect(result.artifact.segments.map((segment) => segment.startSec)).toEqual([
        0, 4, 18, 32,
    ]);
});

it('returns a structured miss for unsupported local videos', () => {
    expect(
        LocalTranscriptFixtureStrategy.extract({
            videoId: 'unknownVid1',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: 1_900_000_000_000,
        }),
    ).toEqual({
        status: 'failed',
        failureReason: 'fixture_not_found',
        diagnostics: { code: 'fixture_not_found' },
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/backend/subtitle-extraction-pipeline.test.ts`

Expected: FAIL with missing module `@/backend/extraction/local-transcript-fixtures`.

- [x] **Step 3: Write minimal implementation**

Create fixture data for the existing cold-job IDs used in backend tests so current rate-limit tests can still create two processing jobs before the third request is limited.

```ts
export const LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS = {
    Primary: 'dQw4w9WgXcQ',
    Secondary: 'M7lc1UVf-VE',
} as const;

const LOCAL_TRANSCRIPT_FIXTURES = new Map<string, LocalTranscriptFixture>([
    [
        LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
        {
            languageCode: 'en',
            segments: [
                { startSec: 0, durationSec: 2, text: 'Welcome back.' },
                { startSec: 4, durationSec: 6, text: 'This video is sponsored by Example.' },
                { startSec: 18, durationSec: 4, text: 'Use the link below.' },
                { startSec: 32, durationSec: 5, text: 'Now back to the main topic.' },
            ],
        },
    ],
    [
        LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Secondary,
        {
            languageCode: 'en',
            segments: [
                { startSec: 0, durationSec: 3, text: 'Opening context.' },
                { startSec: 8, durationSec: 4, text: 'Brief sponsor mention.' },
                { startSec: 20, durationSec: 5, text: 'Main content resumes.' },
            ],
        },
    ],
]);
```

`LocalTranscriptFixtureStrategy.extract` should build `artifactId` from `videoId`, `algorithmVersion`, and `local_transcript_fixture`, join trimmed segment text with `\n`, and return `{ status: 'failed', failureReason: 'fixture_not_found', diagnostics: { code: 'fixture_not_found' } }` when no fixture exists.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/backend/subtitle-extraction-pipeline.test.ts`

Expected: PASS for the local strategy tests.

**Verification**: The first local strategy produces deterministic timed transcript artifacts for known videos and a structured miss for unknown videos.

### [x] Task 4: Subtitle Extraction Pipeline Runner

**Files:**

- Create: `src/backend/extraction/subtitle-extraction-pipeline.ts`
- Modify: `tests/backend/subtitle-extraction-pipeline.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import { BackendSubtitleExtractionPipeline } from '@/backend/extraction/subtitle-extraction-pipeline';
import {
    SUBTITLE_EXTRACTION_FAILURE_REASON,
    type SubtitleExtractionStrategy,
} from '@/backend/extraction/subtitle-extraction-types';

it('records multiple attempts and selects the first valid transcript', () => {
    const first: SubtitleExtractionStrategy = {
        name: 'fixture_miss',
        extract: () => ({
            status: 'failed',
            failureReason: 'fixture_not_found',
            diagnostics: { code: 'fixture_not_found' },
        }),
    };
    const second: SubtitleExtractionStrategy = {
        name: 'fixture_hit',
        extract: () => ({
            status: 'succeeded',
            artifact: {
                artifactId: 'transcript-dQw4w9WgXcQ-server-v1-fixture_hit',
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                strategy: 'fixture_hit',
                sourceType: 'local_fixture',
                languageCode: 'en',
                acquiredAtMs: 1_900_000_000_000,
                segments: [{ startSec: 0, durationSec: 2, text: 'hello' }],
                transcriptText: 'hello',
            },
        }),
    };

    const result = BackendSubtitleExtractionPipeline.extract({
        videoId: 'dQw4w9WgXcQ',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        nowMs: 1_900_000_000_000,
        strategies: [first, second],
    });

    expect(result.status).toBe('selected');
    expect(result.attempts.map((attempt) => attempt.strategy)).toEqual([
        'fixture_miss',
        'fixture_hit',
    ]);
});

it('maps timeout and thrown strategy errors to safe diagnostics', () => {
    const timeout: SubtitleExtractionStrategy = {
        name: 'timeout_strategy',
        extract: () => ({
            status: 'timed_out',
            failureReason: 'strategy_timeout',
            diagnostics: { code: 'strategy_timeout' },
        }),
    };
    const throwing: SubtitleExtractionStrategy = {
        name: 'throwing_strategy',
        extract: () => {
            throw new Error('cookie=secret-token should not be stored');
        },
    };

    const result = BackendSubtitleExtractionPipeline.extract({
        videoId: 'unknownVid1',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        nowMs: 1_900_000_000_000,
        strategies: [timeout, throwing],
    });

    expect(result.status).toBe('unavailable');
    expect(result.attempts.map((attempt) => attempt.failureReason)).toEqual([
        SUBTITLE_EXTRACTION_FAILURE_REASON.StrategyTimeout,
        SUBTITLE_EXTRACTION_FAILURE_REASON.StrategyError,
    ]);
    expect(JSON.stringify(result)).not.toContain('secret-token');
});
```

Add companion tests that an empty `succeeded` artifact is recorded as `empty_transcript` and that the default pipeline returns `selected` for `LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary` and `unavailable` for `unknownVid1`.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/backend/subtitle-extraction-pipeline.test.ts`

Expected: FAIL with missing module `@/backend/extraction/subtitle-extraction-pipeline`.

- [x] **Step 3: Write minimal implementation**

Create `BackendSubtitleExtractionPipeline` as a static API class with a default strategy registry containing only `LocalTranscriptFixtureStrategy`.

```ts
export class BackendSubtitleExtractionPipeline {
    static extract(input: {
        videoId: string;
        algorithmVersion: string;
        nowMs: number;
        strategies?: readonly SubtitleExtractionStrategy[];
    }): SubtitleExtractionPipelineResult {
        const strategies =
            input.strategies ?? [LocalTranscriptFixtureStrategy];
        const attempts: SubtitleExtractionAttempt[] = [];

        for (const strategy of strategies) {
            const attempt = BackendSubtitleExtractionPipeline.runStrategy(
                strategy,
                input,
            );
            attempts.push(attempt.attempt);
            if (attempt.status === 'selected') {
                return {
                    status: 'selected',
                    artifact: attempt.artifact,
                    attempts,
                };
            }
        }

        return {
            status: 'unavailable',
            reason: SERVER_ANALYSIS_UNAVAILABLE_REASON.CaptionExtractionFailed,
            message: 'Caption extraction failed for this video.',
            attempts,
        };
    }
}
```

`runStrategy` catches exceptions, does not store raw exception messages, parses selected artifacts with `transcriptArtifactSchema`, records invalid selected artifacts as `failed` with `empty_transcript` or `unordered_segments`, and records returned `timed_out` results as `status: 'timed_out'`.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/backend/subtitle-extraction-pipeline.test.ts`

Expected: PASS.

**Verification**: The pipeline runs strategies in order, keeps deterministic attempt history, rejects unusable transcripts, and stores only safe diagnostic codes.

### [x] Task 5: Job Store Extraction Integration

**Files:**

- Modify: `src/backend/analysis-jobs.ts`
- Modify: `tests/backend/analysis-jobs.test.ts`

- [x] **Step 1: Write the failing test**

```ts
import { LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS } from '@/backend/extraction/local-transcript-fixtures';
import { SERVER_ANALYSIS_UNAVAILABLE_REASON } from '@/shared/server-analysis-contract';

it('stores selected transcript artifacts on supported cold jobs', () => {
    BackendAnalysisJobs.resetForTests();

    const response = BackendAnalysisJobs.start({
        videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        nowMs: 1_900_000_000_000,
    });

    expect(response.status).toBe('processing');
    if (response.status !== 'processing') {
        throw new Error('Expected processing response.');
    }
    const diagnostics = BackendAnalysisJobs.getDiagnosticsForTests(
        response.jobId,
    );
    expect(diagnostics?.stage).toBe('awaiting_analysis');
    expect(diagnostics?.selectedTranscriptArtifact?.segments).toHaveLength(4);
    expect(diagnostics?.extractionAttempts).toEqual([
        expect.objectContaining({
            strategy: 'local_transcript_fixture',
            status: 'succeeded',
        }),
    ]);
});

it('stores terminal unavailable when extraction cannot select a transcript', () => {
    BackendAnalysisJobs.resetForTests();

    const response = BackendAnalysisJobs.start({
        videoId: 'unknownVid1',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        nowMs: 1_900_000_000_000,
    });

    expect(response).toMatchObject({
        status: 'unavailable',
        videoId: 'unknownVid1',
        reason: SERVER_ANALYSIS_UNAVAILABLE_REASON.CaptionExtractionFailed,
    });
    const diagnostics = BackendAnalysisJobs.getDiagnosticsForTests(
        'local-unknownVid1-server-v1',
    );
    expect(diagnostics?.stage).toBe('complete');
    expect(diagnostics?.selectedTranscriptArtifact).toBeNull();
    expect(diagnostics?.extractionAttempts[0]).toMatchObject({
        strategy: 'local_transcript_fixture',
        status: 'failed',
        failureReason: 'fixture_not_found',
    });
});
```

Update the existing duplicate terminal test to use `unknownVid1` for the extraction-failure terminal path, and keep the fixture completion tests on a supported fixture video.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/backend/analysis-jobs.test.ts`

Expected: FAIL with missing `getDiagnosticsForTests` and no extraction artifact fields on jobs.

- [x] **Step 3: Write minimal implementation**

Extend `AnalysisJobRecord` and run extraction exactly once during new job creation:

```ts
type AnalysisJobStage = 'extracting' | 'awaiting_analysis' | 'complete';

type AnalysisJobRecord = {
    jobId: string;
    jobKey: string;
    videoId: string;
    algorithmVersion: string;
    pollAfterSec: number;
    createdAtMs: number;
    completedAtMs: number | null;
    stage: AnalysisJobStage;
    extractionAttempts: SubtitleExtractionAttempt[];
    selectedTranscriptArtifact: TranscriptArtifact | null;
    processingResponse: ProcessingResponse;
    terminalResponse: BackendAnalysisTerminalResponse | null;
};
```

After the record is created, call `BackendSubtitleExtractionPipeline.extract({ videoId, algorithmVersion, nowMs })`. For `selected`, store attempts and artifact and set `stage` to `awaiting_analysis`; return the existing processing response. For `unavailable`, store attempts, set `selectedTranscriptArtifact` to `null`, set `completedAtMs`, set `stage` to `complete`, build an `unavailableResponseSchema` terminal response with `caption_extraction_failed`, and return that terminal response.

Add:

```ts
static getDiagnosticsForTests(jobId: string): AnalysisJobDiagnostics | null {
    const record = BackendAnalysisJobs.jobsById.get(jobId);
    if (record === undefined) {
        return null;
    }
    return {
        stage: record.stage,
        extractionAttempts: record.extractionAttempts,
        selectedTranscriptArtifact: record.selectedTranscriptArtifact,
        completedAtMs: record.completedAtMs,
        terminalStatus: record.terminalResponse?.status ?? null,
    };
}
```

Keep `completeFixture` idempotent: if extraction already produced terminal unavailable, it returns the existing terminal response and does not overwrite extraction diagnostics.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/backend/analysis-jobs.test.ts`

Expected: PASS.

**Verification**: Cold jobs now record extraction artifacts and attempts, while extraction failures complete as non-skipping unavailable jobs.

### [x] Task 6: API and HTTP Behavior

**Files:**

- Modify: `src/backend/analysis-api.ts`
- Modify: `tests/backend/analysis-api.test.ts`
- Modify: `tests/backend/server.test.ts`

- [x] **Step 1: Write the failing test**

```ts
it('returns terminal unavailable when extraction cannot select a transcript', () => {
    const response = BackendAnalysisApi.handleAnalysisRequest({
        videoId: 'unknownVid1',
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
            status: 'unavailable',
            videoId: 'unknownVid1',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            reason: 'caption_extraction_failed',
            message: 'Caption extraction failed for this video.',
        },
    });
    expect(BackendAnalysisJobs.snapshotForTests().jobCount).toBe(1);
});

it('does not run extraction for rate-limited cold starts', () => {
    const requestFor = (videoId: string) => ({
        videoId,
        extensionVersion: '0.1.0',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        client: {
            source: 'chrome-extension',
            capabilities: ['processing-status'],
        },
    });

    BackendAnalysisApi.handleAnalysisRequest(requestFor('dQw4w9WgXcQ'), {
        nowMs: 1_900_000_000_000,
    });
    BackendAnalysisApi.handleAnalysisRequest(requestFor('M7lc1UVf-VE'), {
        nowMs: 1_900_000_001_000,
    });
    const limited = BackendAnalysisApi.handleAnalysisRequest(
        requestFor('unknownVid1'),
        { nowMs: 1_900_000_002_000 },
    );

    expect(limited.statusCode).toBe(429);
    expect(
        BackendAnalysisJobs.getDiagnosticsForTests(
            'local-unknownVid1-server-v1',
        ),
    ).toBeNull();
});
```

Add an HTTP test in `tests/backend/server.test.ts`:

```ts
it('returns unavailable over HTTP when local extraction has no transcript', async () => {
    const server = BackendHttpServer.create();
    servers.push(server);
    await listenOnEphemeralPort(server);
    const baseUrl = localServerUrl(server);

    const response = await postJson(`${baseUrl}/v1/analysis`, {
        videoId: 'unknownVid1',
        extensionVersion: '0.1.0',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        client: {
            source: 'chrome-extension',
            capabilities: ['processing-status'],
        },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
        status: 'unavailable',
        videoId: 'unknownVid1',
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        reason: 'caption_extraction_failed',
        message: 'Caption extraction failed for this video.',
    });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm run test tests/backend/analysis-api.test.ts tests/backend/server.test.ts`

Expected: FAIL because unsupported cold jobs currently return `202 processing` until fixture completion.

- [x] **Step 3: Write minimal implementation**

No new route is needed. Update `BackendAnalysisApi.handleAnalysisRequest` JSDoc at `src/backend/analysis-api.ts:60` so it no longer says cold requests return processing without starting subtitle extraction. The actual behavior flows through `BackendAnalysisJobs.start`: supported fixtures return processing, unsupported fixtures return terminal unavailable, and `jobResponseResult` at `src/backend/analysis-api.ts:209` already maps terminal responses to HTTP `200`.

Keep the existing rate-limit ordering unchanged: `BackendApiProtection.evaluate({ costClass: ColdJobStart })` must still run before `BackendAnalysisJobs.start`, so denied cold starts cannot create extraction diagnostics.

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm run test tests/backend/analysis-api.test.ts tests/backend/server.test.ts`

Expected: PASS.

**Verification**: API and HTTP callers see a deterministic unavailable state for unsupported local videos and no extraction work starts after rate limiting denies a cold request.

### [x] Task 7: Focused Verification

**Files:**

- Verify: `src/shared/server-analysis-contract.ts`
- Verify: `src/backend/extraction/subtitle-extraction-types.ts`
- Verify: `src/backend/extraction/local-transcript-fixtures.ts`
- Verify: `src/backend/extraction/subtitle-extraction-pipeline.ts`
- Verify: `src/backend/analysis-jobs.ts`
- Verify: `src/backend/analysis-api.ts`
- Verify: backend and shared tests touched by this issue

- [x] **Step 1: Run the focused behavior suite**

Run: `pnpm run test tests/shared/server-analysis-contract.test.ts tests/backend/subtitle-extraction-pipeline.test.ts tests/backend/analysis-jobs.test.ts tests/backend/analysis-api.test.ts tests/backend/server.test.ts`

Expected: PASS.

- [x] **Step 2: Run the typecheck**

Run: `pnpm run lint:types`

Expected: PASS.

- [x] **Step 3: Run markdown formatting checks for the issue artifacts**

Run: `pnpm run lint:md`

Expected: PASS. `.sdd` is excluded from the repository markdownlint script, so failures here should come only from repository docs outside this issue.

**Verification**: The extraction slice is covered by focused tests, strict TypeScript accepts the new types, and the plan artifacts do not require additional contract files.
