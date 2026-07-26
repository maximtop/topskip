import * as v from 'valibot';

import {
    extensionVersionSchema,
    promoBlockSchema,
    serverAnalysisCapabilitySchema,
    serverAnalysisFailureCodeSchema,
    youtubeVideoIdSchema,
} from '@topskip/common/server-analysis-contract';

const MAX_CAPABILITY_COUNT = 16;
const MAX_OPAQUE_ID_LENGTH = 160;
const MAX_SUPPORT_ID_LENGTH = 80;

const legacyCapabilitiesSchema = v.pipe(
    v.array(serverAnalysisCapabilitySchema),
    v.maxLength(MAX_CAPABILITY_COUNT),
    v.check(
        (capabilities) => new Set(capabilities).size === capabilities.length,
        'Capabilities must be unique.',
    ),
);

const legacyAlgorithmVersionSchema = v.pipe(v.string(), v.minLength(1));

const legacyFreshnessSchema = v.strictObject({
    expiresAtMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

const legacyFailureSchema = v.strictObject({
    code: serverAnalysisFailureCodeSchema,
    supportId: v.optional(
        v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_SUPPORT_ID_LENGTH)),
    ),
    retryAfterSec: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

/**
 * Preserves the operator-only metadata request without weakening public upload schemas.
 */
export const legacyServerAnalysisRequestSchema = v.strictObject({
    videoId: youtubeVideoIdSchema,
    durationSec: v.optional(v.pipe(v.number(), v.minValue(0.001))),
    extensionVersion: extensionVersionSchema,
    algorithmVersion: v.optional(legacyAlgorithmVersionSchema),
    client: v.strictObject({
        source: v.literal('chrome-extension'),
        capabilities: legacyCapabilitiesSchema,
    }),
});

export const legacyProcessingResponseSchema = v.strictObject({
    status: v.literal('processing'),
    videoId: youtubeVideoIdSchema,
    algorithmVersion: legacyAlgorithmVersionSchema,
    jobId: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(MAX_OPAQUE_ID_LENGTH),
    ),
    pollAfterSec: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

export const legacyReadyResponseSchema = v.strictObject({
    status: v.literal('ready'),
    videoId: youtubeVideoIdSchema,
    algorithmVersion: legacyAlgorithmVersionSchema,
    source: v.literal('server_cache'),
    sourceResultId: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(MAX_OPAQUE_ID_LENGTH),
    ),
    freshness: legacyFreshnessSchema,
    promoBlocks: v.pipe(v.array(promoBlockSchema), v.minLength(1)),
});

export const legacyNoPromoResponseSchema = v.strictObject({
    status: v.literal('no_promo'),
    videoId: youtubeVideoIdSchema,
    algorithmVersion: legacyAlgorithmVersionSchema,
    sourceResultId: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(MAX_OPAQUE_ID_LENGTH),
    ),
    freshness: legacyFreshnessSchema,
});

export const legacyUnavailableResponseSchema = v.strictObject({
    status: v.literal('unavailable'),
    videoId: youtubeVideoIdSchema,
    algorithmVersion: legacyAlgorithmVersionSchema,
    error: legacyFailureSchema,
});

export const legacyTerminalErrorResponseSchema = v.strictObject({
    status: v.literal('error'),
    videoId: v.optional(youtubeVideoIdSchema),
    algorithmVersion: legacyAlgorithmVersionSchema,
    error: legacyFailureSchema,
});

const legacyRateLimitedResponseSchema = v.pipe(
    v.strictObject({
        status: v.literal('rate_limited'),
        algorithmVersion: legacyAlgorithmVersionSchema,
        error: legacyFailureSchema,
    }),
    v.check(
        (response) =>
            (response.error.code === 'rate_limited' ||
                response.error.code === 'capacity_limited') &&
            response.error.retryAfterSec !== undefined,
        'Legacy rate limits require a retryable capacity code.',
    ),
);

/**
 * Keeps every retained legacy response private to the process-wide operator mode.
 */
export const legacyServerAnalysisResponseSchema = v.union([
    legacyProcessingResponseSchema,
    legacyReadyResponseSchema,
    legacyNoPromoResponseSchema,
    legacyUnavailableResponseSchema,
    legacyTerminalErrorResponseSchema,
    legacyRateLimitedResponseSchema,
]);

/**
 * Metadata request accepted only by an explicitly configured legacy process.
 */
export type LegacyServerAnalysisRequest = v.InferOutput<
    typeof legacyServerAnalysisRequestSchema
>;

/**
 * Response shape retained only for isolated legacy extraction servers.
 */
export type LegacyServerAnalysisResponse = v.InferOutput<
    typeof legacyServerAnalysisResponseSchema
>;
