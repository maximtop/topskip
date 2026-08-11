import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import {
    LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS,
    LocalTranscriptFixtureStrategy,
} from '@topskip/backend/extraction/local-transcript-fixtures';
import { BackendSubtitleExtractionPipeline } from '@topskip/backend/extraction/subtitle-extraction-pipeline';
import {
    SUBTITLE_EXTRACTION_FAILURE_REASON,
    subtitleExtractionAttemptSchema,
    transcriptArtifactSchema,
    type SubtitleExtractionStrategy,
} from '@topskip/backend/extraction/subtitle-extraction-types';
import { SERVER_ANALYSIS_ALGORITHM_VERSION } from '@topskip/common/server-analysis-contract';

describe('Backend subtitle extraction pipeline', () => {
    it('validates selected transcript artifacts', () => {
        const parsed = v.parse(transcriptArtifactSchema, {
            artifactId:
                'transcript-dQw4w9WgXcQ-server-v4-local_transcript_fixture',
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            strategy: 'local_transcript_fixture',
            sourceType: 'local_fixture',
            languageCode: 'en',
            videoDurationSec: 18_000,
            acquiredAtMs: 1_900_000_000_000,
            segments: [
                { startSec: 0, durationSec: 2, text: 'Intro' },
                { startSec: 4, durationSec: 3, text: 'Sponsor begins' },
            ],
            transcriptText: 'Intro\nSponsor begins',
        });

        expect(parsed.segments).toHaveLength(2);
        expect(parsed.videoDurationSec).toBe(18_000);
    });

    it('keeps old timedtext artifacts readable and accepts yt-dlp artifacts', () => {
        for (const sourceType of ['youtube_timedtext', 'youtube_yt_dlp']) {
            expect(
                v.safeParse(transcriptArtifactSchema, {
                    artifactId: `transcript-${sourceType}`,
                    videoId: 'dQw4w9WgXcQ',
                    algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                    strategy: sourceType,
                    sourceType,
                    languageCode: 'en',
                    acquiredAtMs: 1_900_000_000_000,
                    segments: [{ startSec: 0, durationSec: 2, text: 'Intro' }],
                    transcriptText: 'Intro',
                }).success,
            ).toBe(true);
        }
    });

    it('rejects empty transcript artifacts before analysis can consume them', () => {
        expect(
            v.safeParse(transcriptArtifactSchema, {
                artifactId:
                    'transcript-emptyCapt01-server-v4-local_transcript_fixture',
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

    it('returns a fixture transcript for supported local videos', async () => {
        const result = await LocalTranscriptFixtureStrategy.extract({
            videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: 1_900_000_000_000,
        });

        expect(result.status).toBe('succeeded');
        if (result.status !== 'succeeded') {
            throw new Error('Expected local fixture transcript.');
        }
        expect(result.artifact.strategy).toBe('local_transcript_fixture');
        expect(
            result.artifact.segments.map((segment) => segment.startSec),
        ).toEqual([0, 4, 18, 32]);
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

    it('records multiple attempts and selects the first valid transcript', async () => {
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
                    artifactId: 'transcript-dQw4w9WgXcQ-server-v4-fixture_hit',
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

        const result = await BackendSubtitleExtractionPipeline.extract({
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

    it('maps timeout and thrown strategy errors to safe diagnostics', async () => {
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

        const result = await BackendSubtitleExtractionPipeline.extract({
            videoId: 'unknownVid1',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: 1_900_000_000_000,
            strategies: [timeout, throwing],
        });

        expect(result.status).toBe('unavailable');
        if (result.status !== 'unavailable') {
            throw new Error('Expected unavailable extraction result.');
        }
        expect(result.code).toBe('caption_extraction_failed');
        expect(result.attempts.map((attempt) => attempt.failureReason)).toEqual(
            [
                SUBTITLE_EXTRACTION_FAILURE_REASON.StrategyTimeout,
                SUBTITLE_EXTRACTION_FAILURE_REASON.StrategyError,
            ],
        );
        expect(JSON.stringify(result)).not.toContain('secret-token');
    });

    it('records empty selected artifacts as failed attempts', async () => {
        const empty: SubtitleExtractionStrategy = {
            name: 'empty_hit',
            extract: () => ({
                status: 'succeeded',
                artifact: {
                    artifactId: 'transcript-emptyCapt01-server-v4-empty_hit',
                    videoId: 'emptyCapt01',
                    algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                    strategy: 'empty_hit',
                    sourceType: 'local_fixture',
                    languageCode: 'en',
                    acquiredAtMs: 1_900_000_000_000,
                    segments: [],
                    transcriptText: '',
                },
            }),
        };

        const result = await BackendSubtitleExtractionPipeline.extract({
            videoId: 'emptyCapt01',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: 1_900_000_000_000,
            strategies: [empty],
        });

        expect(result.status).toBe('unavailable');
        expect(result.attempts[0]).toMatchObject({
            strategy: 'empty_hit',
            status: 'failed',
            failureReason: SUBTITLE_EXTRACTION_FAILURE_REASON.EmptyTranscript,
        });
    });

    it('selects a default local fixture without contacting the production extractor', async () => {
        const selected = await BackendSubtitleExtractionPipeline.extract({
            videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: 1_900_000_000_000,
        });

        expect(selected.status).toBe('selected');
        expect(selected.attempts.map((attempt) => attempt.strategy)).toEqual([
            'local_transcript_fixture',
        ]);
    });

    it('registers test fixtures before the sole production extractor', () => {
        expect(
            BackendSubtitleExtractionPipeline.defaultStrategies().map(
                (strategy) => strategy.name,
            ),
        ).toEqual(['local_transcript_fixture', 'yt_dlp_subtitles']);
    });

    it('registers yt-dlp as the only production extractor', () => {
        const previous = process.env.NODE_ENV;
        process.env.NODE_ENV = 'production';
        try {
            expect(
                BackendSubtitleExtractionPipeline.defaultStrategies().map(
                    (strategy) => strategy.name,
                ),
            ).toEqual(['yt_dlp_subtitles']);
        } finally {
            if (previous === undefined) {
                delete process.env.NODE_ENV;
            } else {
                process.env.NODE_ENV = previous;
            }
        }
    });
});
