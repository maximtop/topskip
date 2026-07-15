import * as v from 'valibot';

import {
    SUBTITLE_EXTRACTION_FAILURE_REASON,
    transcriptArtifactSchema,
    type SubtitleExtractionStrategy,
} from '@topskip/backend/extraction/subtitle-extraction-types';

const LOCAL_TRANSCRIPT_FIXTURE_STRATEGY_NAME = 'local_transcript_fixture';
const TRANSCRIPT_ARTIFACT_ID_PREFIX = 'transcript';
const TRANSCRIPT_TEXT_SEPARATOR = '\n';

/**
 * Local video IDs keep cold-job tests deterministic without live YouTube access.
 */
export const LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS = {
    Primary: 'dQw4w9WgXcQ',
    Secondary: 'M7lc1UVf-VE',
} as const;

/**
 * Minimal fixture transcript shape before strategy output validation.
 */
type LocalTranscriptFixture = {
    languageCode: string;
    segments: Array<{
        startSec: number;
        durationSec: number;
        text: string;
    }>;
};

const LOCAL_TRANSCRIPT_FIXTURES = new Map<string, LocalTranscriptFixture>([
    [
        LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary,
        {
            languageCode: 'en',
            segments: [
                { startSec: 0, durationSec: 2, text: 'Welcome back.' },
                {
                    startSec: 4,
                    durationSec: 6,
                    text: 'This video is sponsored by Example.',
                },
                { startSec: 18, durationSec: 4, text: 'Use the link below.' },
                {
                    startSec: 32,
                    durationSec: 5,
                    text: 'Now back to the main topic.',
                },
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

/**
 * Fixture-backed extraction strategy for the local backend tracer bullet.
 */
export const LocalTranscriptFixtureStrategy: SubtitleExtractionStrategy = {
    name: LOCAL_TRANSCRIPT_FIXTURE_STRATEGY_NAME,
    extract: (input) => {
        const fixture = LOCAL_TRANSCRIPT_FIXTURES.get(input.videoId);
        if (fixture === undefined) {
            return {
                status: 'failed',
                failureReason:
                    SUBTITLE_EXTRACTION_FAILURE_REASON.FixtureNotFound,
                diagnostics: { code: 'fixture_not_found' },
            };
        }

        return {
            status: 'succeeded',
            artifact: v.parse(transcriptArtifactSchema, {
                artifactId: [
                    TRANSCRIPT_ARTIFACT_ID_PREFIX,
                    input.videoId,
                    input.algorithmVersion,
                    LOCAL_TRANSCRIPT_FIXTURE_STRATEGY_NAME,
                ].join('-'),
                videoId: input.videoId,
                algorithmVersion: input.algorithmVersion,
                strategy: LOCAL_TRANSCRIPT_FIXTURE_STRATEGY_NAME,
                sourceType: 'local_fixture',
                languageCode: fixture.languageCode,
                acquiredAtMs: input.nowMs,
                segments: fixture.segments,
                transcriptText: fixture.segments
                    .map((segment) => segment.text.trim())
                    .join(TRANSCRIPT_TEXT_SEPARATOR),
            }),
        };
    },
};
