import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import {
    SERVER_ANALYSIS_ALGORITHM_VERSION,
    SERVER_ANALYSIS_API_VERSION,
    SERVER_ANALYSIS_CAPABILITY_TYPED_ERRORS,
    SERVER_ANALYSIS_MAX_REQUEST_BODY_BYTES,
    buildServerAnalysisRequest,
    installationRegistrationResponseEmissionSchema,
    installationRegistrationResponseSchema,
    isValidYouTubeVideoId,
    processingResponseSchema,
    readyResponseSchema,
    serverAnalysisResponseEmissionSchema,
    serverAnalysisResponseSchema,
    serverConfigResponseEmissionSchema,
    serverConfigResponseSchema,
    serverAnalysisRequestSchema,
} from '@topskip/common/server-analysis-contract';

const VIDEO_ID = 'dQw4w9WgXcQ';
const HASH = 'a'.repeat(64);

const identity = {
    videoId: VIDEO_ID,
    languageCode: 'en',
    transcriptHash: HASH,
    algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
};

describe('server analysis contract', () => {
    it('builds a normalized timed-caption upload without client identity fields', () => {
        const request = buildServerAnalysisRequest({
            videoId: VIDEO_ID,
            durationSec: 0,
            extensionVersion: '0.1.0',
            languageCode: ' EN ',
            segments: [
                {
                    startSec: -0,
                    durationSec: 2,
                    text: ' e\u0301\r\n caption ',
                },
            ],
        });

        expect(request).toEqual({
            videoId: VIDEO_ID,
            durationSec: 0,
            extensionVersion: '0.1.0',
            languageCode: 'en',
            segments: [{ startSec: 0, durationSec: 2, text: 'é\n caption' }],
            client: {
                source: 'chrome-extension',
                capabilities: ['processing-status', 'typed-server-errors-v1'],
            },
        });
        expect(request).not.toHaveProperty('algorithmVersion');
        expect(request).not.toHaveProperty('transcriptHash');
    });

    it('accepts bounded raw language spelling for independent server normalization', () => {
        expect(
            v.parse(serverAnalysisRequestSchema, {
                videoId: VIDEO_ID,
                extensionVersion: '1.2.3',
                languageCode: ' EN-us ',
                segments: [{ startSec: 0, durationSec: 1, text: 'caption' }],
                client: {
                    source: 'chrome-extension',
                    capabilities: [
                        SERVER_ANALYSIS_CAPABILITY_TYPED_ERRORS,
                        'future-capability-v2',
                    ],
                },
            }).languageCode,
        ).toBe(' EN-us ');
    });

    it.each([
        {},
        { languageCode: 'en' },
        { segments: [{ startSec: 0, durationSec: 1, text: 'caption' }] },
    ])('rejects metadata-only request variant %#', (captionFields) => {
        expect(
            v.safeParse(serverAnalysisRequestSchema, {
                videoId: VIDEO_ID,
                extensionVersion: '1.2.3',
                client: { source: 'chrome-extension', capabilities: [] },
                ...captionFields,
            }).success,
        ).toBe(false);
    });

    it.each([
        { algorithmVersion: 'server-v4' },
        { transcriptHash: HASH },
        { unknown: true },
        {
            client: {
                source: 'chrome-extension',
                capabilities: [],
                extra: true,
            },
        },
        {
            segments: [
                {
                    startSec: 0,
                    durationSec: 1,
                    text: 'caption',
                    extra: true,
                },
            ],
        },
    ])('rejects forbidden or unknown request fields %#', (extra) => {
        const base = {
            videoId: VIDEO_ID,
            extensionVersion: '1.2.3',
            languageCode: 'en',
            segments: [{ startSec: 0, durationSec: 1, text: 'caption' }],
            client: { source: 'chrome-extension', capabilities: [] },
        };
        expect(
            v.safeParse(serverAnalysisRequestSchema, { ...base, ...extra })
                .success,
        ).toBe(false);
    });

    it.each([0, 18_000])('accepts duration boundary %s', (durationSec) => {
        expect(
            v.safeParse(serverAnalysisRequestSchema, {
                videoId: VIDEO_ID,
                durationSec,
                extensionVersion: '1.2.3',
                languageCode: 'en',
                segments: [{ startSec: 0, durationSec: 1, text: 'caption' }],
                client: { source: 'chrome-extension', capabilities: [] },
            }).success,
        ).toBe(true);
    });

    it.each([-1, 18_000.001, Number.NaN, Number.POSITIVE_INFINITY])(
        'rejects duration %s',
        (durationSec) => {
            expect(
                v.safeParse(serverAnalysisRequestSchema, {
                    videoId: VIDEO_ID,
                    durationSec,
                    extensionVersion: '1.2.3',
                    languageCode: 'en',
                    segments: [
                        { startSec: 0, durationSec: 1, text: 'caption' },
                    ],
                    client: { source: 'chrome-extension', capabilities: [] },
                }).success,
            ).toBe(false);
        },
    );

    it('uses server-v6 and the 8 MiB public body limit', () => {
        expect(SERVER_ANALYSIS_ALGORITHM_VERSION).toBe('server-v6');
        expect(SERVER_ANALYSIS_API_VERSION).toBe(1);
        expect(SERVER_ANALYSIS_MAX_REQUEST_BODY_BYTES).toBe(8 * 1024 * 1024);
    });

    it.each([
        '1',
        '1.2',
        '1.2.3.4',
        '1.2.3-beta',
        '1.2.3+build',
        '1.2.65536',
        '123456789012345678901234567890123',
    ])('rejects unsupported extension version %s', (extensionVersion) => {
        expect(
            v.safeParse(serverAnalysisRequestSchema, {
                videoId: VIDEO_ID,
                extensionVersion,
                languageCode: 'en',
                segments: [{ startSec: 0, durationSec: 1, text: 'caption' }],
                client: { source: 'chrome-extension', capabilities: [] },
            }).success,
        ).toBe(false);
    });

    it('bounds and deduplicates forward-compatible capabilities', () => {
        const base = {
            videoId: VIDEO_ID,
            extensionVersion: '1.2.3',
            languageCode: 'en',
            segments: [{ startSec: 0, durationSec: 1, text: 'caption' }],
        };
        expect(
            v.safeParse(serverAnalysisRequestSchema, {
                ...base,
                client: {
                    source: 'chrome-extension',
                    capabilities: Array.from(
                        { length: 17 },
                        (_, index) => `cap-${index}`,
                    ),
                },
            }).success,
        ).toBe(false);
        expect(
            v.safeParse(serverAnalysisRequestSchema, {
                ...base,
                client: {
                    source: 'chrome-extension',
                    capabilities: ['future', 'future'],
                },
            }).success,
        ).toBe(false);
    });

    it('requires complete authoritative identity in processing and terminal responses', () => {
        const processing = {
            status: 'processing',
            ...identity,
            jobId: 'job-1',
            pollAfterSec: 3,
        };
        expect(v.parse(processingResponseSchema, processing)).toEqual(
            processing,
        );
        for (const missing of [
            'videoId',
            'languageCode',
            'transcriptHash',
            'algorithmVersion',
        ] as const) {
            const incomplete: Record<string, unknown> = { ...processing };
            delete incomplete[missing];
            expect(
                v.safeParse(processingResponseSchema, incomplete).success,
            ).toBe(false);
        }

        expect(
            v.parse(readyResponseSchema, {
                status: 'ready',
                ...identity,
                source: 'server_cache',
                sourceResultId: 'result-1',
                freshness: { expiresAtMs: 4_102_444_800_000 },
                promoBlocks: [{ startSec: 4, endSec: 24 }],
            }).status,
        ).toBe('ready');
    });

    it('keeps pre-identity failures separate', () => {
        const parsed = v.parse(serverAnalysisResponseEmissionSchema, {
            status: 'error',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            error: { code: 'token_expired' },
        });
        expect(parsed.status).toBe('error');
        expect(
            v.safeParse(serverAnalysisResponseEmissionSchema, {
                status: 'processing',
                videoId: VIDEO_ID,
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                jobId: 'job-1',
                pollAfterSec: 3,
            }).success,
        ).toBe(false);
    });

    it('accepts future bounded server algorithms without compile-time equality', () => {
        const response = v.parse(serverAnalysisResponseSchema, {
            status: 'no_promo',
            ...identity,
            algorithmVersion: 'server-future-opaque',
            sourceResultId: 'result-1',
            freshness: { expiresAtMs: 4_102_444_800_000 },
        });
        expect(response.algorithmVersion).toBe('server-future-opaque');
        expect(
            v.safeParse(serverAnalysisResponseSchema, {
                status: 'no_promo',
                ...identity,
                algorithmVersion: 'x'.repeat(65),
                sourceResultId: 'result-1',
                freshness: { expiresAtMs: 4_102_444_800_000 },
            }).success,
        ).toBe(false);
    });

    it('keeps backend emission strict while clients tolerate additive fields', () => {
        const response = {
            status: 'ready',
            ...identity,
            source: 'server_cache',
            sourceResultId: 'result-1',
            freshness: {
                expiresAtMs: 4_102_444_800_000,
                futureFreshnessField: true,
            },
            promoBlocks: [{ startSec: 4, endSec: 24, futureBlockField: true }],
            futureResponseField: true,
        };

        expect(
            v.safeParse(serverAnalysisResponseEmissionSchema, response).success,
        ).toBe(false);
        const parsed = v.parse(serverAnalysisResponseSchema, response);
        expect(parsed).not.toHaveProperty('futureResponseField');
        if (parsed.status !== 'ready') {
            throw new Error('Expected ready response.');
        }
        expect(parsed.freshness).not.toHaveProperty('futureFreshnessField');
        expect(parsed.promoBlocks[0]).not.toHaveProperty('futureBlockField');
        expect(
            v.safeParse(serverAnalysisResponseSchema, {
                ...response,
                promoBlocks: [{ startSec: 'invalid' }],
            }).success,
        ).toBe(false);
    });

    it.each([
        'video_unavailable',
        'captions_unavailable',
        'subtitle_response_too_large',
        'caption_extraction_failed',
        'invalid_server_response',
    ])('rejects local or legacy-only public upload code %s', (code) => {
        expect(
            v.safeParse(serverAnalysisResponseEmissionSchema, {
                status: 'error',
                ...identity,
                error: { code },
            }).success,
        ).toBe(false);
    });

    it.each([
        {
            status: 'unavailable',
            code: 'internal_error',
        },
        {
            status: 'unavailable',
            code: 'rate_limited',
        },
        {
            status: 'unavailable',
            code: 'budget_exhausted',
        },
        {
            status: 'error',
            code: 'video_too_long',
        },
        {
            status: 'error',
            code: 'too_many_caption_segments',
        },
        {
            status: 'error',
            code: 'capacity_limited',
        },
        {
            status: 'rate_limited',
            code: 'internal_error',
            retryAfterSec: 3,
        },
        {
            status: 'rate_limited',
            code: 'video_too_long',
            retryAfterSec: 3,
        },
    ])(
        'rejects cross-category $status/$code response combinations',
        ({ status, code, retryAfterSec }) => {
            const response = {
                status,
                ...identity,
                error: {
                    code,
                    ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
                },
            };

            expect(
                v.safeParse(serverAnalysisResponseEmissionSchema, response)
                    .success,
            ).toBe(false);
        },
    );

    it('keeps canonical limit rejection pre-identity without weakening terminal errors', () => {
        const preIdentityLimit = {
            status: 'error',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            error: { code: 'video_too_long' },
        };
        expect(
            v.safeParse(serverAnalysisResponseEmissionSchema, preIdentityLimit)
                .success,
        ).toBe(true);
        expect(
            v.safeParse(serverAnalysisResponseEmissionSchema, {
                ...preIdentityLimit,
                ...identity,
            }).success,
        ).toBe(false);
        expect(
            v.safeParse(serverAnalysisResponseSchema, {
                ...preIdentityLimit,
                futureResponseField: true,
                error: {
                    ...preIdentityLimit.error,
                    futureErrorField: true,
                },
            }).success,
        ).toBe(true);
    });

    it.each([
        {
            status: 'unavailable',
            error: { code: 'video_too_long' },
        },
        {
            status: 'error',
            error: { code: 'model_provider_error' },
        },
        {
            status: 'error',
            error: { code: 'budget_exhausted' },
        },
        {
            status: 'rate_limited',
            error: { code: 'rate_limited', retryAfterSec: 3 },
        },
        {
            status: 'rate_limited',
            error: { code: 'capacity_limited', retryAfterSec: 3 },
        },
    ])('accepts the valid $status/$error.code envelope', (response) => {
        const identifiedResponse = { ...response, ...identity };
        expect(
            v.safeParse(
                serverAnalysisResponseEmissionSchema,
                identifiedResponse,
            ).success,
        ).toBe(true);
        expect(
            v.safeParse(serverAnalysisResponseSchema, {
                ...identifiedResponse,
                futureResponseField: true,
                error: {
                    ...response.error,
                    futureErrorField: true,
                },
            }).success,
        ).toBe(true);
    });

    it('restricts rate-limit codes and retry metadata', () => {
        expect(
            v.parse(serverAnalysisResponseEmissionSchema, {
                status: 'rate_limited',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                error: { code: 'capacity_limited', retryAfterSec: 3 },
            }).status,
        ).toBe('rate_limited');
        for (const error of [
            { code: 'budget_exhausted', retryAfterSec: 3 },
            { code: 'rate_limited' },
            { code: 'rate_limited', retryAfterSec: 0 },
        ]) {
            expect(
                v.safeParse(serverAnalysisResponseEmissionSchema, {
                    status: 'rate_limited',
                    algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                    error,
                }).success,
            ).toBe(false);
        }
    });

    it('validates strict emission and tolerant client bootstrap responses', () => {
        const registration = {
            status: 'registered',
            token: 'a'.repeat(43),
            expiresAtMs: 4_102_444_800_000,
            future: true,
        };
        expect(
            v.safeParse(
                installationRegistrationResponseEmissionSchema,
                registration,
            ).success,
        ).toBe(false);
        expect(
            v.parse(installationRegistrationResponseSchema, registration),
        ).not.toHaveProperty('future');

        const config = {
            apiVersion: SERVER_ANALYSIS_API_VERSION,
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            supportedCapabilities: [
                'processing-status',
                'typed-server-errors-v1',
            ],
            minimumExtensionVersion: '1.2.3',
            supportIssueBaseUrl:
                'https://github.com/maximtop/topskip/issues/new',
            future: true,
        };
        expect(
            v.safeParse(serverConfigResponseEmissionSchema, config).success,
        ).toBe(false);
        expect(v.parse(serverConfigResponseSchema, config)).not.toHaveProperty(
            'future',
        );
    });

    it.each([
        'http://github.com/maximtop/topskip/issues/new',
        'https://user@github.com/maximtop/topskip/issues/new',
        'https://github.com:444/maximtop/topskip/issues/new',
        'https://github.com/maximtop/topskip/other/issues/new',
        'https://github.com/maximtop/topskip/issues/new?template=bug',
        'https://example.com/maximtop/topskip/issues/new',
    ])('rejects unsafe support issue URL %s', (supportIssueBaseUrl) => {
        expect(
            v.safeParse(serverConfigResponseSchema, {
                apiVersion: SERVER_ANALYSIS_API_VERSION,
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                supportedCapabilities: [],
                supportIssueBaseUrl,
            }).success,
        ).toBe(false);
    });

    it('validates video ids', () => {
        expect(isValidYouTubeVideoId(VIDEO_ID)).toBe(true);
        expect(isValidYouTubeVideoId('short')).toBe(false);
    });
});
