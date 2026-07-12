import * as v from 'valibot';

import { LocalTranscriptFixtureStrategy } from '@/backend/extraction/local-transcript-fixtures';
import {
    YouTubeTimedTextStrategies,
    type YouTubeTimedTextFetcher,
} from '@/backend/extraction/youtube-timedtext-strategies';
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
} from '@/backend/extraction/subtitle-extraction-types';
import { SERVER_ANALYSIS_UNAVAILABLE_REASON } from '@/shared/server-analysis-contract';

const CAPTION_EXTRACTION_FAILED_MESSAGE =
    'Caption extraction failed for this video.';
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
            reason: SERVER_ANALYSIS_UNAVAILABLE_REASON.CaptionExtractionFailed,
            message: CAPTION_EXTRACTION_FAILED_MESSAGE,
            attempts,
        };
    }

    /**
     * Returns the production registry, adding deterministic fixtures only in tests.
     *
     * @param input - Optional test fetcher that keeps ordering coverage offline.
     * @returns Direct and automatic caption strategies, plus test fixtures when applicable.
     */
    static defaultStrategies(
        input: {
            fetchTranscript?: YouTubeTimedTextFetcher;
        } = {},
    ): readonly SubtitleExtractionStrategy[] {
        const strategies: SubtitleExtractionStrategy[] = [
            YouTubeTimedTextStrategies.direct(input.fetchTranscript),
            YouTubeTimedTextStrategies.automaticFallback(input.fetchTranscript),
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
