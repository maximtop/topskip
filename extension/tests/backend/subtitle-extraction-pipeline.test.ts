import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import {
    LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS,
    LocalTranscriptFixtureStrategy,
} from '@/backend/extraction/local-transcript-fixtures';
import { BackendSubtitleExtractionPipeline } from '@/backend/extraction/subtitle-extraction-pipeline';
import {
    SUBTITLE_EXTRACTION_FAILURE_REASON,
    subtitleExtractionAttemptSchema,
    transcriptArtifactSchema,
    type SubtitleExtractionStrategy,
} from '@/backend/extraction/subtitle-extraction-types';
import { SERVER_ANALYSIS_ALGORITHM_VERSION } from '@/shared/server-analysis-contract';

describe('Backend subtitle extraction pipeline', () => {
    it('validates selected transcript artifacts', () => {
        const parsed = v.parse(transcriptArtifactSchema, {
            artifactId:
                'transcript-dQw4w9WgXcQ-server-v1-local_transcript_fixture',
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
                artifactId:
                    'transcript-emptyCapt01-server-v1-local_transcript_fixture',
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
                    artifactId: 'transcript-emptyCapt01-server-v1-empty_hit',
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

    it('selects default local fixtures and records every configured fallback on a miss', async () => {
        const selected = await BackendSubtitleExtractionPipeline.extract({
            videoId: LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: 1_900_000_000_000,
        });
        const unavailable = await BackendSubtitleExtractionPipeline.extract({
            videoId: 'unknownVid1',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: 1_900_000_000_000,
        });

        expect(selected.status).toBe('selected');
        expect(unavailable).toMatchObject({
            status: 'unavailable',
            reason: 'caption_extraction_failed',
            message: 'Caption extraction failed for this video.',
        });
        expect(unavailable.attempts.map((attempt) => attempt.strategy)).toEqual(
            [
                'local_transcript_fixture',
                'youtube_timedtext_en',
                'youtube_timedtext_en_asr',
            ],
        );
    });

    it('uses the automatic YouTube caption fallback after direct captions miss', async () => {
        const requestedKinds: Array<string | null> = [];
        const result = await BackendSubtitleExtractionPipeline.extract({
            videoId: 'unknownVid1',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: 1_900_000_000_000,
            strategies: BackendSubtitleExtractionPipeline.defaultStrategies({
                fetchTranscript: (url) => {
                    requestedKinds.push(url.searchParams.get('kind'));
                    if (url.searchParams.get('kind') !== 'asr') {
                        return Promise.resolve({
                            ok: true,
                            text: () => Promise.resolve(''),
                        });
                    }
                    return Promise.resolve({
                        ok: true,
                        text: () =>
                            Promise.resolve(
                                '<transcript><text start="0" dur="2">Fallback captions</text></transcript>',
                            ),
                    });
                },
            }),
        });

        expect(result.status).toBe('selected');
        if (result.status !== 'selected') {
            throw new Error('Expected automatic-caption fallback selection.');
        }
        expect(requestedKinds).toEqual([null, 'asr']);
        expect(result.artifact).toMatchObject({
            strategy: 'youtube_timedtext_en_asr',
            sourceType: 'youtube_timedtext',
            transcriptText: 'Fallback captions',
        });
        expect(result.attempts).toEqual([
            expect.objectContaining({
                strategy: 'local_transcript_fixture',
                status: 'failed',
                diagnostics: { code: 'fixture_not_found' },
            }),
            expect.objectContaining({
                strategy: 'youtube_timedtext_en',
                status: 'failed',
                diagnostics: { code: 'caption_parse_failed' },
            }),
            expect.objectContaining({
                strategy: 'youtube_timedtext_en_asr',
                status: 'succeeded',
            }),
        ]);
    });
});
