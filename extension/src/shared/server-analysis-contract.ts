import * as v from 'valibot';

/**
 * Server-side cache and algorithm version sent with local analysis requests.
 */
export const SERVER_ANALYSIS_ALGORITHM_VERSION = 'server-v1';

/**
 * Local backend base URL used by the development server-first path.
 */
export const TOPSKIP_LOCAL_BACKEND_BASE_URL = 'http://127.0.0.1:8787';

/**
 * Chrome host-permission match for the local backend development endpoint.
 */
export const TOPSKIP_LOCAL_BACKEND_HOST_MATCH = 'http://127.0.0.1:8787/*';

/**
 * Client capability that tells the backend the extension can display pending
 * processing status.
 */
export const SERVER_ANALYSIS_CAPABILITY_PROCESSING_STATUS = 'processing-status';

const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/u;

/**
 * Shared schema for canonical YouTube watch video IDs.
 */
export const youtubeVideoIdSchema = v.pipe(
    v.string(),
    v.regex(YOUTUBE_VIDEO_ID_PATTERN, 'Invalid YouTube video id.'),
);

const requestCapabilitiesSchema = v.pipe(
    v.array(v.string()),
    v.check(
        (capabilities) => new Set(capabilities).size === capabilities.length,
        'Capabilities must be unique.',
    ),
);

/**
 * Validates metadata-only requests sent from the extension to the backend.
 */
export const serverAnalysisRequestSchema = v.strictObject({
    videoId: youtubeVideoIdSchema,
    durationSec: v.optional(v.pipe(v.number(), v.minValue(0.001))),
    extensionVersion: v.pipe(v.string(), v.minLength(1)),
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    client: v.strictObject({
        source: v.literal('chrome-extension'),
        capabilities: requestCapabilitiesSchema,
    }),
});

/**
 * Validates the non-blocking processing response returned by this slice.
 */
export const processingResponseSchema = v.strictObject({
    status: v.literal('processing'),
    videoId: youtubeVideoIdSchema,
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    jobId: v.pipe(v.string(), v.minLength(1)),
    pollAfterSec: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

const promoConfidenceSchema = v.picklist(['low', 'medium', 'high'] as const);

const finiteTimelineSecSchema = v.pipe(
    v.number(),
    v.check(
        (value) => Number.isFinite(value),
        'Promo block timeline values must be finite.',
    ),
    v.minValue(0),
);

/**
 * Validates cached promo block timings returned by the backend.
 */
export const promoBlockSchema = v.pipe(
    v.strictObject({
        startSec: finiteTimelineSecSchema,
        endSec: v.optional(finiteTimelineSecSchema),
        confidence: v.optional(promoConfidenceSchema),
    }),
    v.check(
        (block) => block.endSec === undefined || block.endSec > block.startSec,
        'Promo block endSec must be greater than startSec.',
    ),
);

const finiteEpochMsSchema = v.pipe(
    v.number(),
    v.check(
        (value) => Number.isFinite(value),
        'Epoch milliseconds must be finite.',
    ),
    v.integer(),
    v.minValue(1),
);

/**
 * Validates server-owned freshness metadata mirrored by the extension cache.
 */
export const readyResponseFreshnessSchema = v.strictObject({
    expiresAtMs: finiteEpochMsSchema,
});

/**
 * Validates ready cache-hit responses from the local backend.
 */
export const readyResponseSchema = v.strictObject({
    status: v.literal('ready'),
    videoId: youtubeVideoIdSchema,
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    source: v.literal('server_cache'),
    sourceResultId: v.pipe(v.string(), v.minLength(1)),
    freshness: readyResponseFreshnessSchema,
    promoBlocks: v.pipe(v.array(promoBlockSchema), v.minLength(1)),
});

/**
 * Validates terminal responses for videos with no detected server promo blocks.
 */
export const noPromoResponseSchema = v.strictObject({
    status: v.literal('no_promo'),
    videoId: youtubeVideoIdSchema,
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    sourceResultId: v.pipe(v.string(), v.minLength(1)),
    freshness: readyResponseFreshnessSchema,
});

/**
 * Validates terminal responses when deterministic fixture analysis is unavailable.
 */
export const SERVER_ANALYSIS_UNAVAILABLE_REASON = {
    FixtureUnavailable: 'fixture_unavailable',
    CaptionExtractionFailed: 'caption_extraction_failed',
} as const;

const unavailableReasonSchema = v.picklist([
    SERVER_ANALYSIS_UNAVAILABLE_REASON.FixtureUnavailable,
    SERVER_ANALYSIS_UNAVAILABLE_REASON.CaptionExtractionFailed,
] as const);

/**
 * Validates terminal user-safe unavailable reasons.
 */
export const unavailableResponseSchema = v.strictObject({
    status: v.literal('unavailable'),
    videoId: youtubeVideoIdSchema,
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    reason: unavailableReasonSchema,
    message: v.pipe(v.string(), v.minLength(1)),
});

/**
 * Stable terminal error codes for deterministic fixture and model analysis failures.
 */
export const SERVER_ANALYSIS_ERROR_CODE = {
    FixtureError: 'fixture_error',
    InvalidModelResponse: 'invalid_model_response',
    UnsafeModelBlocks: 'unsafe_model_blocks',
    ModelProviderError: 'model_provider_error',
} as const;

const terminalErrorCodeSchema = v.picklist([
    SERVER_ANALYSIS_ERROR_CODE.FixtureError,
    SERVER_ANALYSIS_ERROR_CODE.InvalidModelResponse,
    SERVER_ANALYSIS_ERROR_CODE.UnsafeModelBlocks,
    SERVER_ANALYSIS_ERROR_CODE.ModelProviderError,
] as const);

/**
 * Validates terminal responses when deterministic analysis fails safely.
 */
export const terminalErrorResponseSchema = v.strictObject({
    status: v.literal('error'),
    videoId: youtubeVideoIdSchema,
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    error: v.strictObject({
        code: terminalErrorCodeSchema,
        message: v.pipe(v.string(), v.minLength(1)),
    }),
});

/**
 * Validates retryable local throttling responses for cold backend work.
 */
export const rateLimitedResponseSchema = v.strictObject({
    status: v.literal('rate_limited'),
    retryAfterSec: v.pipe(v.number(), v.integer(), v.minValue(1)),
    error: v.strictObject({
        code: v.literal('rate_limited'),
        message: v.pipe(v.string(), v.minLength(1)),
    }),
});

/**
 * Validates every successful analysis response consumed by the extension.
 */
export const serverAnalysisResponseSchema = v.union([
    processingResponseSchema,
    readyResponseSchema,
    noPromoResponseSchema,
    unavailableResponseSchema,
    terminalErrorResponseSchema,
    rateLimitedResponseSchema,
]);

/**
 * Validates typed request errors returned before expensive work can start.
 */
export const errorResponseSchema = v.strictObject({
    status: v.literal('invalid_request'),
    error: v.strictObject({
        code: v.picklist([
            'invalid_video_id',
            'invalid_request',
            'request_body_too_large',
            'job_not_found',
        ] as const),
        message: v.pipe(v.string(), v.minLength(1)),
    }),
});

/**
 * Validated metadata payload sent from the extension to the local backend.
 */
export type ServerAnalysisRequest = v.InferOutput<
    typeof serverAnalysisRequestSchema
>;

/**
 * Non-blocking server response used while backend analysis is pending.
 */
export type ProcessingResponse = v.InferOutput<typeof processingResponseSchema>;

/**
 * Ready cache-hit response with normalized promo blocks.
 */
export type ReadyResponse = v.InferOutput<typeof readyResponseSchema>;

/**
 * Terminal clean response for videos with no server-detected promo blocks.
 */
export type NoPromoResponse = v.InferOutput<typeof noPromoResponseSchema>;

/**
 * Terminal response for user-safe server analysis unavailability.
 */
export type UnavailableResponse = v.InferOutput<
    typeof unavailableResponseSchema
>;

/**
 * Terminal response for deterministic fixture job failures.
 */
export type TerminalErrorResponse = v.InferOutput<
    typeof terminalErrorResponseSchema
>;

/**
 * Retryable response returned when local cold-work capacity is exhausted.
 */
export type RateLimitedResponse = v.InferOutput<
    typeof rateLimitedResponseSchema
>;

/**
 * Freshness metadata returned by the backend for local cache reuse.
 */
export type ReadyResponseFreshness = v.InferOutput<
    typeof readyResponseFreshnessSchema
>;

/**
 * Successful server analysis response consumed by background messaging.
 */
export type ServerAnalysisResponse = v.InferOutput<
    typeof serverAnalysisResponseSchema
>;

/**
 * Typed error response returned before any expensive analysis work starts.
 */
export type ErrorResponse = v.InferOutput<typeof errorResponseSchema>;

/**
 * Checks the canonical YouTube ID shape accepted by the local backend.
 *
 * @param videoId - Candidate watch-page video ID.
 * @returns `true` when the value matches the supported YouTube ID shape.
 */
export function isValidYouTubeVideoId(videoId: string): boolean {
    return YOUTUBE_VIDEO_ID_PATTERN.test(videoId);
}

/**
 * Builds the metadata-only request body used by server-first analysis.
 *
 * @param input - Current video metadata already known to the extension.
 * @returns Validated request body for the local backend.
 */
export function buildServerAnalysisRequest(input: {
    videoId: string;
    durationSec?: number;
    extensionVersion: string;
}): ServerAnalysisRequest {
    const maybeDuration =
        input.durationSec !== undefined && Number.isFinite(input.durationSec)
            ? { durationSec: input.durationSec }
            : {};
    return v.parse(serverAnalysisRequestSchema, {
        videoId: input.videoId,
        ...maybeDuration,
        extensionVersion: input.extensionVersion,
        algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        client: {
            source: 'chrome-extension',
            capabilities: [SERVER_ANALYSIS_CAPABILITY_PROCESSING_STATUS],
        },
    });
}
