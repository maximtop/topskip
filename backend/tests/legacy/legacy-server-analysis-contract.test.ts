import * as v from 'valibot';
import { describe, expect, it } from 'vitest';

import {
    legacyServerAnalysisRequestSchema,
    legacyServerAnalysisResponseSchema,
} from '@topskip/backend/legacy/legacy-server-analysis-contract';

const videoId = 'dQw4w9WgXcQ';

describe('legacy server analysis contract', () => {
    it('accepts only the retained metadata request', () => {
        expect(
            v.parse(legacyServerAnalysisRequestSchema, {
                videoId,
                durationSec: 120,
                extensionVersion: '0.1.0',
                algorithmVersion: 'server-v4',
                client: {
                    source: 'chrome-extension',
                    capabilities: [
                        'processing-status',
                        'typed-server-errors-v1',
                    ],
                },
            }),
        ).toMatchObject({ videoId, durationSec: 120 });

        expect(
            v.safeParse(legacyServerAnalysisRequestSchema, {
                videoId,
                extensionVersion: '0.1.0',
                languageCode: 'en',
                segments: [{ startSec: 0, durationSec: 1, text: 'caption' }],
                client: { source: 'chrome-extension', capabilities: [] },
            }).success,
        ).toBe(false);
    });

    it('keeps processing metadata-only before extraction', () => {
        const processing = {
            status: 'processing',
            videoId,
            algorithmVersion: 'server-v4',
            jobId: 'job-1',
            pollAfterSec: 3,
        };

        expect(v.parse(legacyServerAnalysisResponseSchema, processing)).toEqual(
            processing,
        );
        expect(
            v.safeParse(legacyServerAnalysisResponseSchema, {
                ...processing,
                languageCode: 'en',
                transcriptHash: 'a'.repeat(64),
            }).success,
        ).toBe(false);
    });

    it.each([
        {
            status: 'ready',
            videoId,
            algorithmVersion: 'server-v4',
            source: 'server_cache',
            sourceResultId: 'result-1',
            freshness: { expiresAtMs: 4_102_444_800_000 },
            promoBlocks: [{ startSec: 10, endSec: 20, confidence: 'high' }],
        },
        {
            status: 'no_promo',
            videoId,
            algorithmVersion: 'server-v4',
            sourceResultId: 'result-2',
            freshness: { expiresAtMs: 4_102_444_800_000 },
        },
        {
            status: 'unavailable',
            videoId,
            algorithmVersion: 'server-v4',
            error: { code: 'captions_unavailable' },
        },
        {
            status: 'error',
            algorithmVersion: 'server-v4',
            error: { code: 'model_provider_error', supportId: 'support-1' },
        },
        {
            status: 'rate_limited',
            algorithmVersion: 'server-v4',
            error: { code: 'capacity_limited', retryAfterSec: 3 },
        },
    ])('accepts retained terminal response %#', (response) => {
        expect(v.parse(legacyServerAnalysisResponseSchema, response)).toEqual(
            response,
        );
    });

    it('rejects unknown legacy response fields', () => {
        expect(
            v.safeParse(legacyServerAnalysisResponseSchema, {
                status: 'error',
                algorithmVersion: 'server-v4',
                error: { code: 'internal_error', rawMessage: 'secret' },
            }).success,
        ).toBe(false);
    });
});
