import * as v from 'valibot';

import {
    type ServerAnalysisFailureCode,
    youtubeVideoIdSchema,
} from '@topskip/common/server-analysis-contract';
import { CaptionTranscriptCanonicalizer } from '@topskip/common/captions/canonical-transcript';

const finiteNonNegativeNumberSchema = v.pipe(
    v.number(),
    v.check(
        (value) => Number.isFinite(value),
        'Timeline values must be finite.',
    ),
    v.minValue(0),
);

const finitePositiveIntegerSchema = v.pipe(
    v.number(),
    v.check(
        (value) => Number.isFinite(value),
        'Epoch milliseconds must be finite.',
    ),
    v.integer(),
    v.minValue(1),
);

/**
 * Stable attempt states stored for extraction diagnostics.
 */
export const SUBTITLE_EXTRACTION_ATTEMPT_STATUS = {
    Succeeded: 'succeeded',
    Failed: 'failed',
    TimedOut: 'timed_out',
} as const;

/**
 * Stable failure reasons avoid persisting untrusted provider or exception text.
 */
export const SUBTITLE_EXTRACTION_FAILURE_REASON = {
    FixtureNotFound: 'fixture_not_found',
    EmptyTranscript: 'empty_transcript',
    UnorderedSegments: 'unordered_segments',
    StrategyError: 'strategy_error',
    StrategyTimeout: 'strategy_timeout',
} as const;

const extractionAttemptStatusSchema = v.picklist([
    SUBTITLE_EXTRACTION_ATTEMPT_STATUS.Succeeded,
    SUBTITLE_EXTRACTION_ATTEMPT_STATUS.Failed,
    SUBTITLE_EXTRACTION_ATTEMPT_STATUS.TimedOut,
] as const);

const extractionFailureReasonSchema = v.picklist([
    SUBTITLE_EXTRACTION_FAILURE_REASON.FixtureNotFound,
    SUBTITLE_EXTRACTION_FAILURE_REASON.EmptyTranscript,
    SUBTITLE_EXTRACTION_FAILURE_REASON.UnorderedSegments,
    SUBTITLE_EXTRACTION_FAILURE_REASON.StrategyError,
    SUBTITLE_EXTRACTION_FAILURE_REASON.StrategyTimeout,
] as const);

const safeDiagnosticSchema = v.strictObject({
    code: v.pipe(v.string(), v.minLength(1)),
    detail: v.optional(v.pipe(v.string(), v.minLength(1))),
});

const timedTranscriptSegmentSchema = v.strictObject({
    startSec: finiteNonNegativeNumberSchema,
    durationSec: finiteNonNegativeNumberSchema,
    text: v.pipe(v.string(), v.trim(), v.minLength(1)),
});

const canonicalUploadTranscriptSegmentSchema = v.strictObject({
    startSec: finiteNonNegativeNumberSchema,
    durationSec: finiteNonNegativeNumberSchema,
    text: v.pipe(v.string(), v.minLength(1)),
});

const transcriptHashSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u));

const transcriptArtifactSharedEntries = {
    artifactId: v.pipe(v.string(), v.minLength(1)),
    videoId: youtubeVideoIdSchema,
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    strategy: v.pipe(v.string(), v.minLength(1)),
    videoDurationSec: v.optional(finiteNonNegativeNumberSchema),
    acquiredAtMs: finitePositiveIntegerSchema,
    segments: v.pipe(v.array(timedTranscriptSegmentSchema), v.minLength(1)),
    transcriptText: v.pipe(v.string(), v.trim(), v.minLength(1)),
};

const legacyTranscriptArtifactIdentityEntries = {
    languageCode: v.nullable(v.pipe(v.string(), v.minLength(1))),
    transcriptHash: v.optional(v.nullable(transcriptHashSchema)),
};

const localFixtureTranscriptArtifactSchema = v.strictObject({
    ...transcriptArtifactSharedEntries,
    sourceType: v.literal('local_fixture'),
    ...legacyTranscriptArtifactIdentityEntries,
});

const timedTextTranscriptArtifactSchema = v.strictObject({
    ...transcriptArtifactSharedEntries,
    sourceType: v.literal('youtube_timedtext'),
    ...legacyTranscriptArtifactIdentityEntries,
});

const ytDlpTranscriptArtifactSchema = v.strictObject({
    ...transcriptArtifactSharedEntries,
    sourceType: v.literal('youtube_yt_dlp'),
    ...legacyTranscriptArtifactIdentityEntries,
});

const extensionCaptionUploadArtifactSchema = v.pipe(
    v.strictObject({
        ...transcriptArtifactSharedEntries,
        sourceType: v.literal('extension_caption_upload'),
        languageCode: v.pipe(v.string(), v.minLength(1)),
        transcriptHash: transcriptHashSchema,
        segments: v.pipe(
            v.array(canonicalUploadTranscriptSegmentSchema),
            v.minLength(1),
        ),
        transcriptText: v.pipe(v.string(), v.minLength(1)),
    }),
    v.check((artifact) => {
        const canonical = CaptionTranscriptCanonicalizer.canonicalize({
            languageCode: artifact.languageCode,
            segments: artifact.segments,
        });
        if (!canonical.ok) {
            return false;
        }
        return (
            canonical.transcript.languageCode === artifact.languageCode &&
            canonical.transcript.canonicalJson ===
                JSON.stringify(
                    artifact.segments.map((segment) => [
                        segment.startSec,
                        segment.durationSec,
                        segment.text,
                    ]),
                ) &&
            artifact.transcriptText ===
                artifact.segments.map((segment) => segment.text).join(' ')
        );
    }, 'Uploaded transcript artifacts must already be canonical.'),
);

/**
 * Validates selected transcripts before any later model-analysis worker can use them.
 */
export const transcriptArtifactSchema = v.pipe(
    v.variant('sourceType', [
        localFixtureTranscriptArtifactSchema,
        timedTextTranscriptArtifactSchema,
        ytDlpTranscriptArtifactSchema,
        extensionCaptionUploadArtifactSchema,
    ]),
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

/**
 * Validates the bounded extraction diagnostics retained on a local job.
 */
export const subtitleExtractionAttemptSchema = v.strictObject({
    strategy: v.pipe(v.string(), v.minLength(1)),
    status: extractionAttemptStatusSchema,
    startedAtMs: finitePositiveIntegerSchema,
    completedAtMs: finitePositiveIntegerSchema,
    failureReason: v.optional(extractionFailureReasonSchema),
    diagnostics: safeDiagnosticSchema,
});

/**
 * Safe diagnostic metadata recorded for an extraction attempt.
 */
export type SubtitleExtractionDiagnostic = v.InferOutput<
    typeof safeDiagnosticSchema
>;

/**
 * Bounded extraction failure reason used by attempts and strategy misses.
 */
export type SubtitleExtractionFailureReason = v.InferOutput<
    typeof extractionFailureReasonSchema
>;

/**
 * Internal transcript artifact retained for the later backend analysis worker.
 */
export type TranscriptArtifact = v.InferOutput<typeof transcriptArtifactSchema>;

/**
 * Structured extraction attempt persisted on the in-memory job record.
 */
export type SubtitleExtractionAttempt = v.InferOutput<
    typeof subtitleExtractionAttemptSchema
>;

/**
 * Shared input every deterministic extraction strategy receives.
 */
export type SubtitleExtractionStrategyInput = {
    videoId: string;
    algorithmVersion: string;
    nowMs: number;
};

/**
 * Strategy output is validated by the pipeline before a transcript is selected.
 */
export type SubtitleExtractionStrategyResult =
    | { status: 'succeeded'; artifact: TranscriptArtifact }
    | {
          status: 'failed';
          failureReason: SubtitleExtractionFailureReason;
          diagnostics: SubtitleExtractionDiagnostic;
      }
    | {
          status: 'timed_out';
          failureReason: typeof SUBTITLE_EXTRACTION_FAILURE_REASON.StrategyTimeout;
          diagnostics: SubtitleExtractionDiagnostic;
      };

/**
 * Strategy contract used by the backend-owned extraction pipeline.
 */
export type SubtitleExtractionStrategy = {
    name: string;
    extract: (
        input: SubtitleExtractionStrategyInput,
    ) =>
        | SubtitleExtractionStrategyResult
        | Promise<SubtitleExtractionStrategyResult>;
};

/**
 * Pipeline output either selects one transcript or records a terminal unavailable state.
 */
export type SubtitleExtractionPipelineResult =
    | {
          status: 'selected';
          artifact: TranscriptArtifact;
          attempts: SubtitleExtractionAttempt[];
      }
    | {
          status: 'unavailable';
          code: ServerAnalysisFailureCode;
          attempts: SubtitleExtractionAttempt[];
      };
