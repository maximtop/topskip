import * as v from 'valibot';

/**
 * Server-side cache and algorithm version sent with local analysis requests.
 */
export const SERVER_ANALYSIS_ALGORITHM_VERSION = 'server-v4';

/**
 * Stable wire-contract version for the public analysis API.
 */
export const SERVER_ANALYSIS_API_VERSION = 1;

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

/**
 * Client capability that opts into stable message-free server error codes.
 */
export const SERVER_ANALYSIS_CAPABILITY_TYPED_ERRORS = 'typed-server-errors-v1';

/**
 * Carries bounded client capabilities before authentication or body parsing can
 * succeed, allowing stable typed failures at every public API boundary.
 */
export const TOPSKIP_CAPABILITIES_HEADER_NAME = 'X-TopSkip-Capabilities';

/**
 * Capabilities understood by the current server without rejecting future values.
 */
export const SERVER_ANALYSIS_SUPPORTED_CAPABILITIES = [
    SERVER_ANALYSIS_CAPABILITY_PROCESSING_STATUS,
    SERVER_ANALYSIS_CAPABILITY_TYPED_ERRORS,
] as const;

const MAX_EXTENSION_VERSION_LENGTH = 32;
const MAX_CAPABILITY_COUNT = 16;
const MAX_CAPABILITY_LENGTH = 64;
const MAX_INSTALLATION_TOKEN_LENGTH = 128;
const MAX_SUPPORT_ID_LENGTH = 80;
const CHROME_EXTENSION_SEMVER_PATTERN =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const GITHUB_HOSTNAME = 'github.com';
const GITHUB_NEW_ISSUE_PATH_PATTERN = /^\/[^/]+\/[^/]+\/issues\/new\/?$/u;

const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/u;

/**
 * Shared schema for canonical YouTube watch video IDs.
 */
export const youtubeVideoIdSchema = v.pipe(
    v.string(),
    v.regex(YOUTUBE_VIDEO_ID_PATTERN, 'Invalid YouTube video id.'),
);

/**
 * Validates informational extension versions without coupling server releases to them.
 */
export const extensionVersionSchema = v.pipe(
    v.string(),
    v.maxLength(MAX_EXTENSION_VERSION_LENGTH),
    v.regex(
        CHROME_EXTENSION_SEMVER_PATTERN,
        'Extension version must use MAJOR.MINOR.PATCH.',
    ),
    v.check(
        (value) =>
            value.split('.').every((component) => Number(component) <= 65_535),
        'Extension version components must not exceed 65535.',
    ),
);

/**
 * Validates bounded capability names while leaving future values forward-compatible.
 */
export const serverAnalysisCapabilitySchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(MAX_CAPABILITY_LENGTH),
);

const requestCapabilitiesSchema = v.pipe(
    v.array(serverAnalysisCapabilitySchema),
    v.maxLength(MAX_CAPABILITY_COUNT),
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
    extensionVersion: extensionVersionSchema,
    algorithmVersion: v.optional(v.pipe(v.string(), v.minLength(1))),
    client: v.strictObject({
        source: v.literal('chrome-extension'),
        capabilities: requestCapabilitiesSchema,
    }),
});

/**
 * Validates installation credentials returned once to an anonymous extension install.
 */
export const installationRegistrationResponseSchema = v.object({
    status: v.literal('registered'),
    token: v.pipe(
        v.string(),
        v.minLength(32),
        v.maxLength(MAX_INSTALLATION_TOKEN_LENGTH),
    ),
    expiresAtMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
});

const supportIssueBaseUrlSchema = v.pipe(
    v.string(),
    v.url(),
    v.check((value) => {
        const url = new URL(value);
        return (
            url.protocol === 'https:' &&
            url.hostname === GITHUB_HOSTNAME &&
            url.port === '' &&
            url.username === '' &&
            url.password === '' &&
            url.search === '' &&
            url.hash === '' &&
            GITHUB_NEW_ISSUE_PATH_PATTERN.test(url.pathname)
        );
    }, 'Support URL must be a GitHub HTTPS new-issue URL.'),
);

/**
 * Validates public configuration used for cache compatibility and support routing.
 */
export const serverConfigResponseSchema = v.object({
    apiVersion: v.literal(SERVER_ANALYSIS_API_VERSION),
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    supportedCapabilities: v.pipe(
        v.array(serverAnalysisCapabilitySchema),
        v.maxLength(MAX_CAPABILITY_COUNT),
        v.check(
            (capabilities) =>
                new Set(capabilities).size === capabilities.length,
            'Supported capabilities must be unique.',
        ),
    ),
    minimumExtensionVersion: v.optional(extensionVersionSchema),
    supportIssueBaseUrl: supportIssueBaseUrlSchema,
});

/**
 * Validates the non-blocking processing response returned by this slice.
 */
export const processingResponseSchema = v.object({
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
    v.object({
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
export const readyResponseFreshnessSchema = v.object({
    expiresAtMs: finiteEpochMsSchema,
});

/**
 * Validates ready cache-hit responses from the local backend.
 */
export const readyResponseSchema = v.object({
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
export const noPromoResponseSchema = v.object({
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
    VideoUnavailable: 'video_unavailable',
    CaptionsUnavailable: 'captions_unavailable',
    VideoTooLong: 'video_too_long',
    TooManyCaptionSegments: 'too_many_caption_segments',
    TranscriptTooLarge: 'transcript_too_large',
    SubtitleResponseTooLarge: 'subtitle_response_too_large',
} as const;

/**
 * Stable public failure codes let the extension localize messages safely.
 */
export const SERVER_ANALYSIS_FAILURE_CODE = {
    ...SERVER_ANALYSIS_UNAVAILABLE_REASON,
    RateLimited: 'rate_limited',
    CapacityLimited: 'capacity_limited',
    BudgetExhausted: 'budget_exhausted',
    InvalidRequest: 'invalid_request',
    InvalidVideoId: 'invalid_video_id',
    RequestBodyTooLarge: 'request_body_too_large',
    JobNotFound: 'job_not_found',
    InvalidServerResponse: 'invalid_server_response',
    ClientUpgradeRequired: 'client_upgrade_required',
    TokenMissing: 'token_missing',
    TokenInvalid: 'token_invalid',
    TokenExpired: 'token_expired',
    InternalError: 'internal_error',
    ServiceUnavailable: 'service_unavailable',
    FixtureError: 'fixture_error',
    InvalidModelResponse: 'invalid_model_response',
    UnsafeModelBlocks: 'unsafe_model_blocks',
    ModelProviderError: 'model_provider_error',
} as const;

/**
 * Schema for the allow-listed error vocabulary shared across HTTP and runtime layers.
 */
export const serverAnalysisFailureCodeSchema = v.picklist(
    Object.values(SERVER_ANALYSIS_FAILURE_CODE),
);

/**
 * Message-free failure details prevent provider text from crossing the API boundary.
 */
export const serverAnalysisFailureSchema = v.object({
    code: serverAnalysisFailureCodeSchema,
    supportId: v.optional(
        v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_SUPPORT_ID_LENGTH)),
    ),
    retryAfterSec: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

/**
 * Validates terminal user-safe unavailable reasons.
 */
export const unavailableResponseSchema = v.object({
    status: v.literal('unavailable'),
    videoId: youtubeVideoIdSchema,
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    error: serverAnalysisFailureSchema,
});

/**
 * Stable terminal error codes for deterministic fixture and model analysis failures.
 */
export const SERVER_ANALYSIS_ERROR_CODE = {
    FixtureError: SERVER_ANALYSIS_FAILURE_CODE.FixtureError,
    InvalidModelResponse: SERVER_ANALYSIS_FAILURE_CODE.InvalidModelResponse,
    UnsafeModelBlocks: SERVER_ANALYSIS_FAILURE_CODE.UnsafeModelBlocks,
    ModelProviderError: SERVER_ANALYSIS_FAILURE_CODE.ModelProviderError,
    BudgetExhausted: SERVER_ANALYSIS_FAILURE_CODE.BudgetExhausted,
    InternalError: SERVER_ANALYSIS_FAILURE_CODE.InternalError,
} as const;

/**
 * Validates terminal responses when deterministic analysis fails safely.
 */
export const terminalErrorResponseSchema = v.object({
    status: v.literal('error'),
    videoId: v.optional(youtubeVideoIdSchema),
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    error: serverAnalysisFailureSchema,
});

/**
 * Validates retryable local throttling responses for cold backend work.
 */
export const rateLimitedResponseSchema = v.object({
    status: v.literal('rate_limited'),
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    error: v.pipe(
        serverAnalysisFailureSchema,
        v.check(
            (error) =>
                (error.code === SERVER_ANALYSIS_FAILURE_CODE.RateLimited ||
                    error.code ===
                        SERVER_ANALYSIS_FAILURE_CODE.CapacityLimited) &&
                error.retryAfterSec !== undefined,
            'Rate-limited responses require a retryable capacity code.',
        ),
    ),
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
export const errorResponseSchema = terminalErrorResponseSchema;

/**
 * Validated metadata payload sent from the extension to the local backend.
 */
export type ServerAnalysisRequest = v.InferOutput<
    typeof serverAnalysisRequestSchema
>;

/**
 * Anonymous installation credential response retained only by background storage.
 */
export type InstallationRegistrationResponse = v.InferOutput<
    typeof installationRegistrationResponseSchema
>;

/**
 * Public server configuration used for version and capability negotiation.
 */
export type ServerConfigResponse = v.InferOutput<
    typeof serverConfigResponseSchema
>;

/**
 * Stable message-free failure details shown through localized extension copy.
 */
export type ServerAnalysisFailure = v.InferOutput<
    typeof serverAnalysisFailureSchema
>;

/**
 * Stable error-code union shared by server and extension mappings.
 */
export type ServerAnalysisFailureCode = v.InferOutput<
    typeof serverAnalysisFailureCodeSchema
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
        client: {
            source: 'chrome-extension',
            capabilities: [...SERVER_ANALYSIS_SUPPORTED_CAPABILITIES],
        },
    });
}
