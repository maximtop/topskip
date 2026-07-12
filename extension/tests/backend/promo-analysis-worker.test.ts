import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import { LocalPromoAnalysisFixtureAdapter } from '@/backend/analysis/local-analysis-fixtures';
import { normalizeBackendPromoBlocks } from '@/backend/analysis/promo-block-normalization';
import { BackendPromoAnalysisWorker } from '@/backend/analysis/promo-analysis-worker';
import {
    BACKEND_ANALYSIS_FAILURE_REASON,
    analysisRunArtifactSchema,
} from '@/backend/analysis/promo-analysis-types';
import { parseBackendPromoResponse } from '@/backend/analysis/promo-response-parser';
import { LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS } from '@/backend/extraction/local-transcript-fixtures';
import {
    transcriptArtifactSchema,
    type TranscriptArtifact,
} from '@/backend/extraction/subtitle-extraction-types';
import {
    SERVER_ANALYSIS_ALGORITHM_VERSION,
    SERVER_ANALYSIS_ERROR_CODE,
} from '@/shared/server-analysis-contract';

function makeTranscriptArtifact(input: {
    videoId: string;
}): TranscriptArtifact {
    return v.parse(transcriptArtifactSchema, {
        artifactId: [
            'transcript',
            input.videoId,
            SERVER_ANALYSIS_ALGORITHM_VERSION,
            'local_transcript_fixture',
        ].join('-'),
        videoId: input.videoId,
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        strategy: 'local_transcript_fixture',
        sourceType: 'local_fixture',
        languageCode: 'en',
        acquiredAtMs: 1_900_000_000_000,
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
        transcriptText:
            'Welcome back.\nThis video is sponsored by Example.\nUse the link below.\nNow back to the main topic.',
    });
}

describe('backend promo analysis worker', () => {
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
        {
            promoBlocks: [{ startSec: 130, endSec: 140 }],
            label: 'out-of-bounds start',
        },
        {
            promoBlocks: [{ startSec: 4, endSec: 130 }],
            label: 'out-of-bounds end',
        },
        {
            promoBlocks: [{ startSec: 100 }],
            label: 'open-ended implied end beyond duration',
        },
        {
            promoBlocks: [{ startSec: 0, endSec: 120 }],
            label: 'full-video degenerate',
        },
    ])('rejects unsafe blocks: $label', ({ promoBlocks }) => {
        expect(
            normalizeBackendPromoBlocks({
                promoBlocks: [...promoBlocks],
                durationSec: 120,
            }),
        ).toMatchObject({
            ok: false,
            failureReason: BACKEND_ANALYSIS_FAILURE_REASON.UnsafeModelBlocks,
        });
    });

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

    it('records raw output and returns ready normalized blocks', () => {
        const result = BackendPromoAnalysisWorker.analyze({
            transcriptArtifact: makeTranscriptArtifact({
                videoId: 'dQw4w9WgXcQ',
            }),
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
        expect(result.analysisRun.parsedResult).toMatchObject({
            hasPromo: true,
        });
    });

    it('records no-promo analysis without delivering blocks', () => {
        const result = BackendPromoAnalysisWorker.analyze({
            transcriptArtifact: makeTranscriptArtifact({
                videoId: 'M7lc1UVf-VE',
            }),
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
    ] as const)(
        'returns terminal error for unsafe output',
        ({ raw, expectedCode }) => {
            const result = BackendPromoAnalysisWorker.analyze({
                transcriptArtifact: makeTranscriptArtifact({
                    videoId: 'dQw4w9WgXcQ',
                }),
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
        },
    );
});
