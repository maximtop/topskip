import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import {
    SERVER_ANALYSIS_ERROR_CODE,
    SERVER_ANALYSIS_ALGORITHM_VERSION,
    SERVER_ANALYSIS_UNAVAILABLE_REASON,
    buildServerAnalysisRequest,
    isValidYouTubeVideoId,
    noPromoResponseSchema,
    processingResponseSchema,
    rateLimitedResponseSchema,
    readyResponseSchema,
    serverAnalysisResponseSchema,
    serverAnalysisRequestSchema,
    terminalErrorResponseSchema,
    unavailableResponseSchema,
    type RateLimitedResponse,
} from '@/shared/server-analysis-contract';

describe('server analysis contract', () => {
    it('accepts current-video metadata without captions', () => {
        const request = buildServerAnalysisRequest({
            videoId: 'dQw4w9WgXcQ',
            durationSec: 213,
            extensionVersion: '0.1.0',
        });

        expect(request).toEqual({
            videoId: 'dQw4w9WgXcQ',
            durationSec: 213,
            extensionVersion: '0.1.0',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            client: {
                source: 'chrome-extension',
                capabilities: ['processing-status'],
            },
        });
        expect(v.safeParse(serverAnalysisRequestSchema, request).success).toBe(
            true,
        );
        expect(JSON.stringify(request)).not.toContain('caption');
        expect(JSON.stringify(request)).not.toContain('transcript');
    });

    it('rejects malformed video ids', () => {
        expect(isValidYouTubeVideoId('dQw4w9WgXcQ')).toBe(true);
        expect(isValidYouTubeVideoId('short')).toBe(false);
        expect(
            v.safeParse(serverAnalysisRequestSchema, {
                videoId: 'short',
                extensionVersion: '0.1.0',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                client: {
                    source: 'chrome-extension',
                    capabilities: ['processing-status'],
                },
            }).success,
        ).toBe(false);
    });

    it('accepts the deterministic processing response shape', () => {
        const parsed = v.parse(processingResponseSchema, {
            status: 'processing',
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            jobId: 'local-dQw4w9WgXcQ-server-v1',
            pollAfterSec: 3,
        });

        expect(parsed.status).toBe('processing');
    });

    it('rejects duplicate capabilities to match OpenAPI uniqueItems', () => {
        const parsed = v.safeParse(serverAnalysisRequestSchema, {
            videoId: 'dQw4w9WgXcQ',
            extensionVersion: '0.1.0',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            client: {
                source: 'chrome-extension',
                capabilities: ['processing-status', 'processing-status'],
            },
        });

        expect(parsed.success).toBe(false);
    });

    it('rejects fractional poll intervals to match OpenAPI integer', () => {
        const parsed = v.safeParse(processingResponseSchema, {
            status: 'processing',
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            jobId: 'local-dQw4w9WgXcQ-server-v1',
            pollAfterSec: 1.5,
        });

        expect(parsed.success).toBe(false);
    });

    it('accepts a ready server cache response with local cache metadata', () => {
        const parsed = v.parse(readyResponseSchema, {
            status: 'ready',
            videoId: 'e2eFixture1',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            source: 'server_cache',
            sourceResultId: 'result-e2eFixture1-server-v1',
            freshness: { expiresAtMs: 4_102_444_800_000 },
            promoBlocks: [{ startSec: 4, endSec: 24, confidence: 'high' }],
        });

        expect(parsed.sourceResultId).toBe('result-e2eFixture1-server-v1');
        expect(parsed.freshness.expiresAtMs).toBe(4_102_444_800_000);
    });

    it('rejects ready responses without required cache metadata', () => {
        expect(
            v.safeParse(readyResponseSchema, {
                status: 'ready',
                videoId: 'e2eFixture1',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                source: 'server_cache',
                promoBlocks: [{ startSec: 4, endSec: 24 }],
            }).success,
        ).toBe(false);
    });

    it('rejects non-finite ready response freshness', () => {
        for (const expiresAtMs of [Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(
                v.safeParse(readyResponseSchema, {
                    status: 'ready',
                    videoId: 'e2eFixture1',
                    algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                    source: 'server_cache',
                    sourceResultId: 'result-e2eFixture1-server-v1',
                    freshness: { expiresAtMs },
                    promoBlocks: [{ startSec: 4, endSec: 24 }],
                }).success,
            ).toBe(false);
        }
    });

    it('parses processing and ready responses through one union schema', () => {
        expect(
            v.parse(serverAnalysisResponseSchema, {
                status: 'processing',
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                jobId: 'local-dQw4w9WgXcQ-server-v1',
                pollAfterSec: 3,
            }).status,
        ).toBe('processing');

        expect(
            v.parse(serverAnalysisResponseSchema, {
                status: 'ready',
                videoId: 'e2eFixture1',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                source: 'server_cache',
                sourceResultId: 'result-e2eFixture1-server-v1',
                freshness: { expiresAtMs: 4_102_444_800_000 },
                promoBlocks: [{ startSec: 4, endSec: 24 }],
            }).status,
        ).toBe('ready');
    });

    it('parses terminal job responses through the server response union', () => {
        expect(
            v.parse(noPromoResponseSchema, {
                status: 'no_promo',
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                sourceResultId: 'result-dQw4w9WgXcQ-server-v1',
                freshness: { expiresAtMs: 4_102_444_800_000 },
            }).status,
        ).toBe('no_promo');

        expect(
            v.parse(serverAnalysisResponseSchema, {
                status: 'no_promo',
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                sourceResultId: 'result-dQw4w9WgXcQ-server-v1',
                freshness: { expiresAtMs: 4_102_444_800_000 },
            }).status,
        ).toBe('no_promo');

        expect(
            v.parse(unavailableResponseSchema, {
                status: 'unavailable',
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                reason: 'fixture_unavailable',
                message: 'Fixture analysis is unavailable.',
            }).status,
        ).toBe('unavailable');

        expect(
            v.parse(serverAnalysisResponseSchema, {
                status: 'unavailable',
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                reason: 'fixture_unavailable',
                message: 'Fixture analysis is unavailable.',
            }).status,
        ).toBe('unavailable');

        const extractionUnavailable = v.parse(unavailableResponseSchema, {
            status: 'unavailable',
            videoId: 'unknownVid1',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            reason: SERVER_ANALYSIS_UNAVAILABLE_REASON.CaptionExtractionFailed,
            message: 'Caption extraction failed for this video.',
        });

        expect(extractionUnavailable.reason).toBe('caption_extraction_failed');

        expect(
            v.safeParse(unavailableResponseSchema, {
                status: 'unavailable',
                videoId: 'unknownVid1',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                reason: 'raw_provider_error',
                message: 'Caption extraction failed for this video.',
            }).success,
        ).toBe(false);

        expect(
            v.parse(terminalErrorResponseSchema, {
                status: 'error',
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                error: {
                    code: 'fixture_error',
                    message: 'Fixture job failed.',
                },
            }).status,
        ).toBe('error');

        expect(
            v.parse(serverAnalysisResponseSchema, {
                status: 'error',
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                error: {
                    code: 'fixture_error',
                    message: 'Fixture job failed.',
                },
            }).status,
        ).toBe('error');
    });

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

    it('rejects invalid ready promo blocks', () => {
        expect(
            v.safeParse(readyResponseSchema, {
                status: 'ready',
                videoId: 'e2eFixture1',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                source: 'server_cache',
                sourceResultId: 'result-e2eFixture1-server-v1',
                freshness: { expiresAtMs: 4_102_444_800_000 },
                promoBlocks: [{ startSec: 24, endSec: 4 }],
            }).success,
        ).toBe(false);
    });

    it('rejects non-finite ready promo block timeline values', () => {
        for (const promoBlocks of [
            [{ startSec: Number.POSITIVE_INFINITY, endSec: 24 }],
            [{ startSec: Number.NaN, endSec: 24 }],
            [{ startSec: 4, endSec: Number.POSITIVE_INFINITY }],
            [{ startSec: 4, endSec: Number.NaN }],
        ]) {
            expect(
                v.safeParse(readyResponseSchema, {
                    status: 'ready',
                    videoId: 'e2eFixture1',
                    algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                    source: 'server_cache',
                    sourceResultId: 'result-e2eFixture1-server-v1',
                    freshness: { expiresAtMs: 4_102_444_800_000 },
                    promoBlocks,
                }).success,
            ).toBe(false);
        }
    });

    it('parses retryable rate-limit responses separately from invalid requests', () => {
        const parsed: RateLimitedResponse = v.parse(rateLimitedResponseSchema, {
            status: 'rate_limited',
            retryAfterSec: 60,
            error: {
                code: 'rate_limited',
                message: 'Local cold-analysis limit reached. Retry later.',
            },
        });

        expect(parsed.retryAfterSec).toBe(60);
        expect(parsed.error.code).toBe('rate_limited');
    });

    it('rejects non-positive retry metadata', () => {
        expect(
            v.safeParse(rateLimitedResponseSchema, {
                status: 'rate_limited',
                retryAfterSec: 0,
                error: {
                    code: 'rate_limited',
                    message: 'Local cold-analysis limit reached. Retry later.',
                },
            }).success,
        ).toBe(false);
    });
});
