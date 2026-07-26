import * as v from 'valibot';

import { LocalTranscriptFixtureStrategy } from '@topskip/backend/extraction/local-transcript-fixtures';
import {
    SUBTITLE_EXTRACTION_ATTEMPT_STATUS,
    SUBTITLE_EXTRACTION_FAILURE_REASON,
    subtitleExtractionAttemptSchema,
    transcriptArtifactSchema,
    type SubtitleExtractionAttempt,
    type SubtitleExtractionFailureReason,
    type SubtitleExtractionPipelineResult,
    type SubtitleExtractionStrategy,
    type TranscriptArtifact,
} from '@topskip/backend/extraction/subtitle-extraction-types';
import { YtDlpSubtitleStrategy } from '@topskip/backend/extraction/yt-dlp-subtitle-strategy';
import { SERVER_ANALYSIS_UNAVAILABLE_REASON } from '@topskip/common/server-analysis-contract';

const SELECTED_DIAGNOSTIC_CODE = 'selected';

/**
 * Internal result for one strategy attempt after pipeline validation.
 */
type StrategyRunResult =
    | {
          status: 'selected';
          artifact: TranscriptArtifact;
          attempt: SubtitleExtractionAttempt;
      }
    | { status: 'failed'; attempt: SubtitleExtractionAttempt };

/**
 * Owns backend subtitle extraction orchestration; static API only.
 */
export class BackendSubtitleExtractionPipeline {
    /**
     * Runs configured strategies until one produces a valid transcript artifact.
     *
     * @param input - Video/version key, deterministic clock, and optional strategy list.
     * @returns Selected transcript artifact or terminal unavailable diagnostics.
     */
    static async extract(input: {
        videoId: string;
        algorithmVersion: string;
        nowMs: number;
        strategies?: readonly SubtitleExtractionStrategy[];
    }): Promise<SubtitleExtractionPipelineResult> {
        const strategies =
            input.strategies ??
            BackendSubtitleExtractionPipeline.defaultStrategies();
        const attempts: SubtitleExtractionAttempt[] = [];

        for (const strategy of strategies) {
            const result = await BackendSubtitleExtractionPipeline.runStrategy(
                strategy,
                input,
            );
            attempts.push(result.attempt);
            if (result.status === 'selected') {
                return {
                    status: 'selected',
                    artifact: result.artifact,
                    attempts,
                };
            }
        }

        return {
            status: 'unavailable',
            code: BackendSubtitleExtractionPipeline.mapUnavailableCode(
                attempts,
            ),
            attempts,
        };
    }

    /**
     * Returns the production registry, adding deterministic fixtures only in tests.
     *
     * @returns yt-dlp plus deterministic fixtures when tests need offline jobs.
     */
    static defaultStrategies(): readonly SubtitleExtractionStrategy[] {
        const strategies: SubtitleExtractionStrategy[] = [
            YtDlpSubtitleStrategy.create(),
        ];
        if (process.env.NODE_ENV === 'test') {
            strategies.unshift(LocalTranscriptFixtureStrategy);
        }
        return strategies;
    }

    /**
     * Normalizes strategy output into safe attempt diagnostics.
     *
     * @param strategy - Extraction strategy to execute.
     * @param input - Video/version key and deterministic clock.
     * @returns Validated attempt data, plus selected artifact when available.
     */
    private static async runStrategy(
        strategy: SubtitleExtractionStrategy,
        input: {
            videoId: string;
            algorithmVersion: string;
            nowMs: number;
        },
    ): Promise<StrategyRunResult> {
        try {
            const result = await strategy.extract(input);
            if (result.status === 'failed') {
                return {
                    status: 'failed',
                    attempt: BackendSubtitleExtractionPipeline.failedAttempt({
                        strategy: strategy.name,
                        nowMs: input.nowMs,
                        failureReason: result.failureReason,
                        diagnosticCode: result.diagnostics.code,
                    }),
                };
            }

            if (result.status === 'timed_out') {
                return {
                    status: 'failed',
                    attempt: BackendSubtitleExtractionPipeline.timedOutAttempt(
                        strategy.name,
                        input.nowMs,
                    ),
                };
            }

            return BackendSubtitleExtractionPipeline.selectArtifact(
                strategy.name,
                input.nowMs,
                result.artifact,
            );
        } catch {
            return {
                status: 'failed',
                attempt: BackendSubtitleExtractionPipeline.failedAttempt({
                    strategy: strategy.name,
                    nowMs: input.nowMs,
                    failureReason:
                        SUBTITLE_EXTRACTION_FAILURE_REASON.StrategyError,
                    diagnosticCode:
                        SUBTITLE_EXTRACTION_FAILURE_REASON.StrategyError,
                }),
            };
        }
    }

    /**
     * Validates candidate transcripts before marking an attempt as successful.
     *
     * @param strategy - Strategy id stored on the attempt.
     * @param nowMs - Deterministic attempt timestamp.
     * @param artifact - Candidate artifact returned by the strategy.
     * @returns Selected artifact or a failed attempt with a stable reason.
     */
    private static selectArtifact(
        strategy: string,
        nowMs: number,
        artifact: TranscriptArtifact,
    ): StrategyRunResult {
        const failureReason =
            BackendSubtitleExtractionPipeline.findArtifactFailureReason(
                artifact,
            );
        if (failureReason !== null) {
            return {
                status: 'failed',
                attempt: BackendSubtitleExtractionPipeline.failedAttempt({
                    strategy,
                    nowMs,
                    failureReason,
                    diagnosticCode: failureReason,
                }),
            };
        }

        const parsed = v.safeParse(transcriptArtifactSchema, artifact);
        if (!parsed.success) {
            return {
                status: 'failed',
                attempt: BackendSubtitleExtractionPipeline.failedAttempt({
                    strategy,
                    nowMs,
                    failureReason:
                        SUBTITLE_EXTRACTION_FAILURE_REASON.StrategyError,
                    diagnosticCode:
                        SUBTITLE_EXTRACTION_FAILURE_REASON.StrategyError,
                }),
            };
        }

        return {
            status: 'selected',
            artifact: parsed.output,
            attempt: v.parse(subtitleExtractionAttemptSchema, {
                strategy,
                status: SUBTITLE_EXTRACTION_ATTEMPT_STATUS.Succeeded,
                startedAtMs: nowMs,
                completedAtMs: nowMs,
                diagnostics: { code: SELECTED_DIAGNOSTIC_CODE },
            }),
        };
    }

    /**
     * Finds user-safe validation failures without reading untrusted error text.
     *
     * @param artifact - Candidate artifact returned by a strategy.
     * @returns Stable failure reason, or `null` when basic invariants pass.
     */
    private static findArtifactFailureReason(
        artifact: TranscriptArtifact,
    ): SubtitleExtractionFailureReason | null {
        if (
            artifact.segments.length === 0 ||
            artifact.transcriptText.trim().length === 0
        ) {
            return SUBTITLE_EXTRACTION_FAILURE_REASON.EmptyTranscript;
        }

        const unordered = artifact.segments.some((segment, index, segments) => {
            const previous = segments[index - 1];
            return (
                previous !== undefined && segment.startSec < previous.startSec
            );
        });
        if (unordered) {
            return SUBTITLE_EXTRACTION_FAILURE_REASON.UnorderedSegments;
        }

        return null;
    }

    /**
     * Converts extractor diagnostics into the public allow-listed unavailable vocabulary.
     *
     * @param attempts - Safe attempt history from all configured strategies.
     * @returns Public failure code without raw process details.
     */
    private static mapUnavailableCode(
        attempts: readonly SubtitleExtractionAttempt[],
    ):
        | 'video_unavailable'
        | 'captions_unavailable'
        | 'video_too_long'
        | 'too_many_caption_segments'
        | 'transcript_too_large'
        | 'subtitle_response_too_large'
        | 'caption_extraction_failed' {
        const codes = new Set(
            attempts.map((attempt) => attempt.diagnostics.code),
        );
        const knownCodes = [
            SERVER_ANALYSIS_UNAVAILABLE_REASON.VideoTooLong,
            SERVER_ANALYSIS_UNAVAILABLE_REASON.TooManyCaptionSegments,
            SERVER_ANALYSIS_UNAVAILABLE_REASON.TranscriptTooLarge,
            SERVER_ANALYSIS_UNAVAILABLE_REASON.SubtitleResponseTooLarge,
            SERVER_ANALYSIS_UNAVAILABLE_REASON.CaptionsUnavailable,
            SERVER_ANALYSIS_UNAVAILABLE_REASON.VideoUnavailable,
        ] as const;
        return (
            knownCodes.find((code) => codes.has(code)) ??
            SERVER_ANALYSIS_UNAVAILABLE_REASON.CaptionExtractionFailed
        );
    }

    /**
     * Builds a failed attempt with only stable diagnostic codes.
     *
     * @param input - Strategy name, timestamp, and safe failure code.
     * @returns Validated extraction attempt.
     */
    private static failedAttempt(input: {
        strategy: string;
        nowMs: number;
        failureReason: SubtitleExtractionFailureReason;
        diagnosticCode: string;
    }): SubtitleExtractionAttempt {
        return v.parse(subtitleExtractionAttemptSchema, {
            strategy: input.strategy,
            status: SUBTITLE_EXTRACTION_ATTEMPT_STATUS.Failed,
            startedAtMs: input.nowMs,
            completedAtMs: input.nowMs,
            failureReason: input.failureReason,
            diagnostics: { code: input.diagnosticCode },
        });
    }

    /**
     * Preserves timeout status separately from ordinary failed strategies.
     *
     * @param strategy - Strategy id stored on the attempt.
     * @param nowMs - Deterministic attempt timestamp.
     * @returns Validated timeout attempt.
     */
    private static timedOutAttempt(
        strategy: string,
        nowMs: number,
    ): SubtitleExtractionAttempt {
        return v.parse(subtitleExtractionAttemptSchema, {
            strategy,
            status: SUBTITLE_EXTRACTION_ATTEMPT_STATUS.TimedOut,
            startedAtMs: nowMs,
            completedAtMs: nowMs,
            failureReason: SUBTITLE_EXTRACTION_FAILURE_REASON.StrategyTimeout,
            diagnostics: {
                code: SUBTITLE_EXTRACTION_FAILURE_REASON.StrategyTimeout,
            },
        });
    }
}
