import * as v from 'valibot';

import type { CaptionSegment } from '@topskip/common/caption-types';
import {
    CaptionTranscriptCanonicalizer,
    MAX_TRANSCRIPT_SEGMENT_COUNT,
    MAX_TRANSCRIPT_TIMELINE_SEC,
} from '@topskip/common/captions/canonical-transcript';

/**
 * Server-owned algorithm version separates exact uploaded-caption artifacts from older results.
 */
export const SERVER_ANALYSIS_ALGORITHM_VERSION = 'server-v6';

/**
 * Stable wire boundary for the current public analysis API.
 */
export const SERVER_ANALYSIS_API_VERSION = 1;

/**
 * Inclusive raw JSON envelope limit for public transcript uploads.
 */
export const SERVER_ANALYSIS_MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

/**
 * Loopback endpoint used only by the development extension build.
 */
export const TOPSKIP_LOCAL_BACKEND_BASE_URL = 'http://127.0.0.1:8787';

/**
 * Chrome host permission corresponding to the loopback development endpoint.
 */
export const TOPSKIP_LOCAL_BACKEND_HOST_MATCH = 'http://127.0.0.1:8787/*';

/**
 * Deprecated capability retained because polling is already part of public v1.
 */
export const SERVER_ANALYSIS_CAPABILITY_PROCESSING_STATUS = 'processing-status';

/**
 * Capability advertising message-free stable public failure codes.
 */
export const SERVER_ANALYSIS_CAPABILITY_TYPED_ERRORS = 'typed-server-errors-v1';

/**
 * Header carrying bounded forward-compatible capability names before body parsing.
 */
export const TOPSKIP_CAPABILITIES_HEADER_NAME = 'X-TopSkip-Capabilities';

/**
 * Capabilities understood by this server without rejecting bounded future values.
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
const MAX_ALGORITHM_VERSION_LENGTH = 64;
const MAX_OPAQUE_ID_LENGTH = 160;
const MAX_INPUT_LANGUAGE_CODE_LENGTH = 80;
const CHROME_EXTENSION_SEMVER_PATTERN =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const INPUT_LANGUAGE_CODE_PATTERN = /^\s*[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*\s*$/u;
const NORMALIZED_LANGUAGE_CODE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const GITHUB_HOSTNAME = 'github.com';
const GITHUB_NEW_ISSUE_PATH_PATTERN = /^\/[^/]+\/[^/]+\/issues\/new\/?$/u;
const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/u;

const finiteNonnegativeSecSchema = v.pipe(
    v.number(),
    v.finite('Timeline value must be finite.'),
    v.minValue(0),
);

const algorithmVersionSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(MAX_ALGORITHM_VERSION_LENGTH),
);

const opaqueIdSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(MAX_OPAQUE_ID_LENGTH),
);

/**
 * Validates canonical YouTube watch identifiers used by every analysis path.
 */
export const youtubeVideoIdSchema = v.pipe(
    v.string(),
    v.regex(YOUTUBE_VIDEO_ID_PATTERN, 'Invalid YouTube video id.'),
);

/**
 * Validates informational Chrome extension versions without server equality gating.
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
 * Accepts bounded raw caption-language spelling for independent server normalization.
 */
export const inputCaptionLanguageCodeSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(MAX_INPUT_LANGUAGE_CODE_LENGTH),
    v.regex(INPUT_LANGUAGE_CODE_PATTERN, 'Invalid caption language code.'),
);

/**
 * Validates normalized language identity returned by the server.
 */
export const normalizedCaptionLanguageCodeSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(64),
    v.regex(NORMALIZED_LANGUAGE_CODE_PATTERN),
);

/**
 * Validates bounded capability names while ignoring unknown supported spellings.
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

const strictCaptionSegmentSchema = v.strictObject({
    startSec: finiteNonnegativeSecSchema,
    durationSec: finiteNonnegativeSecSchema,
    text: v.pipe(v.string(), v.minLength(1)),
});

const finiteDurationHintSchema = v.pipe(
    finiteNonnegativeSecSchema,
    v.maxValue(MAX_TRANSCRIPT_TIMELINE_SEC),
);

/**
 * Strict public request requires a complete timed-caption upload and no client identity.
 */
export const serverAnalysisRequestSchema = v.strictObject({
    videoId: youtubeVideoIdSchema,
    durationSec: v.optional(finiteDurationHintSchema),
    extensionVersion: extensionVersionSchema,
    languageCode: inputCaptionLanguageCodeSchema,
    segments: v.pipe(
        v.array(strictCaptionSegmentSchema),
        v.minLength(1),
        v.maxLength(MAX_TRANSCRIPT_SEGMENT_COUNT),
    ),
    client: v.strictObject({
        source: v.literal('chrome-extension'),
        capabilities: requestCapabilitiesSchema,
    }),
});

const registrationEntries = {
    status: v.literal('registered'),
    token: v.pipe(
        v.string(),
        v.minLength(32),
        v.maxLength(MAX_INSTALLATION_TOKEN_LENGTH),
    ),
    expiresAtMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
};

/**
 * Prevents the backend from emitting accidental installation fields.
 */
export const installationRegistrationResponseEmissionSchema =
    v.strictObject(registrationEntries);

/**
 * Lets older extension clients ignore future additive registration metadata.
 */
export const installationRegistrationResponseSchema =
    v.object(registrationEntries);

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

const serverConfigEntries = {
    apiVersion: v.literal(SERVER_ANALYSIS_API_VERSION),
    algorithmVersion: algorithmVersionSchema,
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
};

/**
 * Prevents accidental fields from entering the public configuration response.
 */
export const serverConfigResponseEmissionSchema =
    v.strictObject(serverConfigEntries);

/**
 * Lets an older extension consume additive public configuration fields safely.
 */
export const serverConfigResponseSchema = v.object(serverConfigEntries);

/**
 * Stable safe unavailable codes shared with local capture and private legacy mode.
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
 * Full extension-safe vocabulary includes local and private legacy outcomes.
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
 * Full safe-code schema remains available to extension UI and private legacy code.
 */
export const serverAnalysisFailureCodeSchema = v.picklist(
    Object.values(SERVER_ANALYSIS_FAILURE_CODE),
);

/**
 * Strict internal failure context prevents raw diagnostic fields from crossing boundaries.
 */
export const serverAnalysisFailureSchema = v.strictObject({
    code: serverAnalysisFailureCodeSchema,
    supportId: v.optional(
        v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_SUPPORT_ID_LENGTH)),
    ),
    retryAfterSec: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
});

const serverUploadUnavailableCodeSchema = v.picklist([
    'video_too_long',
    'too_many_caption_segments',
    'transcript_too_large',
] as const);

const serverUploadErrorCodeSchema = v.picklist([
    'budget_exhausted',
    'invalid_request',
    'model_provider_error',
    'invalid_model_response',
    'unsafe_model_blocks',
    'internal_error',
    'client_upgrade_required',
    'invalid_video_id',
    'request_body_too_large',
    'token_missing',
    'token_invalid',
    'token_expired',
    'job_not_found',
    'service_unavailable',
] as const);

const serverUploadPreIdentityErrorCodeSchema = v.picklist([
    'video_too_long',
    'too_many_caption_segments',
    'transcript_too_large',
    'budget_exhausted',
    'invalid_request',
    'model_provider_error',
    'invalid_model_response',
    'unsafe_model_blocks',
    'internal_error',
    'client_upgrade_required',
    'invalid_video_id',
    'request_body_too_large',
    'token_missing',
    'token_invalid',
    'token_expired',
    'job_not_found',
    'service_unavailable',
] as const);

const uploadUnavailableEntries = {
    code: serverUploadUnavailableCodeSchema,
    supportId: v.optional(
        v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_SUPPORT_ID_LENGTH)),
    ),
    retryAfterSec: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
};

const serverUploadUnavailableSchema = v.strictObject(uploadUnavailableEntries);
const serverUploadUnavailableClientSchema = v.object(uploadUnavailableEntries);

const uploadErrorEntries = {
    code: serverUploadErrorCodeSchema,
    supportId: v.optional(
        v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_SUPPORT_ID_LENGTH)),
    ),
    retryAfterSec: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
};

const serverUploadErrorSchema = v.strictObject(uploadErrorEntries);
const serverUploadErrorClientSchema = v.object(uploadErrorEntries);

const preIdentityErrorEntries = {
    code: serverUploadPreIdentityErrorCodeSchema,
    supportId: v.optional(
        v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_SUPPORT_ID_LENGTH)),
    ),
    retryAfterSec: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
};

const serverUploadPreIdentityErrorSchema = v.strictObject(
    preIdentityErrorEntries,
);
const serverUploadPreIdentityErrorClientSchema = v.object(
    preIdentityErrorEntries,
);

const rateFailureEntries = {
    code: v.picklist(['rate_limited', 'capacity_limited'] as const),
    supportId: v.optional(
        v.pipe(v.string(), v.minLength(1), v.maxLength(MAX_SUPPORT_ID_LENGTH)),
    ),
    retryAfterSec: v.pipe(v.number(), v.integer(), v.minValue(1)),
};

const rateFailureSchema = v.strictObject(rateFailureEntries);
const rateFailureClientSchema = v.object(rateFailureEntries);

/**
 * Validates authoritative lowercase SHA-256 transcript fingerprints.
 */
export const transcriptHashSchema = v.pipe(
    v.string(),
    v.regex(/^[0-9a-f]{64}$/u),
);

const identityEntries = {
    videoId: youtubeVideoIdSchema,
    languageCode: normalizedCaptionLanguageCodeSchema,
    transcriptHash: transcriptHashSchema,
    algorithmVersion: algorithmVersionSchema,
};

/**
 * Complete authoritative identity binds every accepted transcript response.
 */
export const serverTranscriptIdentitySchema = v.strictObject(identityEntries);

const processingEntries = {
    status: v.literal('processing'),
    ...identityEntries,
    jobId: opaqueIdSchema,
    pollAfterSec: v.pipe(v.number(), v.integer(), v.minValue(1)),
};

/**
 * Strict backend processing response always exposes authoritative identity.
 */
export const processingResponseSchema = v.strictObject(processingEntries);
const processingClientResponseSchema = v.object(processingEntries);

const promoBlockEntries = {
    startSec: finiteNonnegativeSecSchema,
    endSec: v.optional(finiteNonnegativeSecSchema),
    confidence: v.optional(v.picklist(['low', 'medium', 'high'] as const)),
};

/**
 * Strict normalized promo block emitted and persisted by the backend.
 */
export const promoBlockSchema = v.pipe(
    v.strictObject(promoBlockEntries),
    v.check(
        (block) => block.endSec === undefined || block.endSec > block.startSec,
        'Promo block endSec must be greater than startSec.',
    ),
);

const promoBlockClientSchema = v.pipe(
    v.object(promoBlockEntries),
    v.check(
        (block) => block.endSec === undefined || block.endSec > block.startSec,
        'Promo block endSec must be greater than startSec.',
    ),
);

const freshnessEntries = {
    expiresAtMs: v.pipe(v.number(), v.integer(), v.minValue(1)),
};

/**
 * Strict server-owned freshness stored with exact results.
 */
export const readyResponseFreshnessSchema = v.strictObject(freshnessEntries);
const readyResponseFreshnessClientSchema = v.object(freshnessEntries);

const readyEntries = {
    status: v.literal('ready'),
    ...identityEntries,
    source: v.literal('server_cache'),
    sourceResultId: opaqueIdSchema,
    freshness: readyResponseFreshnessSchema,
    promoBlocks: v.pipe(v.array(promoBlockSchema), v.minLength(1)),
};

/**
 * Strict exact-cache result emitted by the backend.
 */
export const readyResponseSchema = v.strictObject(readyEntries);

const readyClientResponseSchema = v.object({
    ...readyEntries,
    freshness: readyResponseFreshnessClientSchema,
    promoBlocks: v.pipe(v.array(promoBlockClientSchema), v.minLength(1)),
});

const noPromoEntries = {
    status: v.literal('no_promo'),
    ...identityEntries,
    sourceResultId: opaqueIdSchema,
    freshness: readyResponseFreshnessSchema,
};

/**
 * Strict clean terminal result emitted by the backend.
 */
export const noPromoResponseSchema = v.strictObject(noPromoEntries);
const noPromoClientResponseSchema = v.object({
    ...noPromoEntries,
    freshness: readyResponseFreshnessClientSchema,
});

const unavailableEntries = {
    status: v.literal('unavailable'),
    ...identityEntries,
    error: serverUploadUnavailableSchema,
};

/**
 * Strict transcript-bound public limitation response.
 */
export const unavailableResponseSchema = v.strictObject(unavailableEntries);
const unavailableClientResponseSchema = v.object({
    ...unavailableEntries,
    error: serverUploadUnavailableClientSchema,
});

const identifiedErrorEntries = {
    status: v.literal('error'),
    ...identityEntries,
    error: serverUploadErrorSchema,
};

/**
 * Strict transcript-bound model or internal failure response.
 */
export const terminalErrorResponseSchema = v.strictObject(
    identifiedErrorEntries,
);
const terminalErrorClientResponseSchema = v.object({
    ...identifiedErrorEntries,
    error: serverUploadErrorClientSchema,
});

const preIdentityResponseErrorEntries = {
    status: v.literal('error'),
    algorithmVersion: algorithmVersionSchema,
    error: serverUploadPreIdentityErrorSchema,
};

/**
 * Strict safe failure used before an authoritative transcript identity exists.
 */
export const preIdentityErrorResponseSchema = v.strictObject(
    preIdentityResponseErrorEntries,
);
const preIdentityErrorClientResponseSchema = v.object({
    ...preIdentityResponseErrorEntries,
    error: serverUploadPreIdentityErrorClientSchema,
});

const preIdentityRateEntries = {
    status: v.literal('rate_limited'),
    algorithmVersion: algorithmVersionSchema,
    error: rateFailureSchema,
};

/**
 * Strict retryable failure before transcript identity is available.
 */
export const preIdentityRateLimitedResponseSchema = v.strictObject(
    preIdentityRateEntries,
);
const preIdentityRateLimitedClientResponseSchema = v.object({
    ...preIdentityRateEntries,
    error: rateFailureClientSchema,
});

const identifiedRateEntries = {
    status: v.literal('rate_limited'),
    ...identityEntries,
    error: rateFailureSchema,
};

/**
 * Strict retryable failure after transcript identity is available.
 */
export const identifiedRateLimitedResponseSchema = v.strictObject(
    identifiedRateEntries,
);
const identifiedRateLimitedClientResponseSchema = v.object({
    ...identifiedRateEntries,
    error: rateFailureClientSchema,
});

/**
 * Strict rate-limit union supports both pre-identity and transcript-bound admission.
 */
export const rateLimitedResponseSchema = v.union([
    preIdentityRateLimitedResponseSchema,
    identifiedRateLimitedResponseSchema,
]);

/**
 * Strict terminal result union excludes processing responses.
 */
export const terminalAnalysisResponseEmissionSchema = v.union([
    readyResponseSchema,
    noPromoResponseSchema,
    unavailableResponseSchema,
    terminalErrorResponseSchema,
    identifiedRateLimitedResponseSchema,
]);

/**
 * Strict server emission union prevents accidental response data from escaping.
 */
export const serverAnalysisResponseEmissionSchema = v.union([
    processingResponseSchema,
    terminalAnalysisResponseEmissionSchema,
    preIdentityErrorResponseSchema,
    preIdentityRateLimitedResponseSchema,
]);

/**
 * Additive-field-tolerant client parser returns only known validated response data.
 */
export const serverAnalysisResponseSchema = v.union([
    processingClientResponseSchema,
    readyClientResponseSchema,
    noPromoClientResponseSchema,
    unavailableClientResponseSchema,
    terminalErrorClientResponseSchema,
    identifiedRateLimitedClientResponseSchema,
    preIdentityErrorClientResponseSchema,
    preIdentityRateLimitedClientResponseSchema,
]);

/**
 * Strict typed error union used by backend response serialization.
 */
export const errorResponseSchema = v.union([
    preIdentityErrorResponseSchema,
    terminalErrorResponseSchema,
]);

/**
 * Stable model failure constants retained for worker outcome mapping.
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
 * Validated public timed-caption request.
 */
export type ServerAnalysisRequest = v.InferOutput<
    typeof serverAnalysisRequestSchema
>;

/**
 * Anonymous installation credential retained only by background storage.
 */
export type InstallationRegistrationResponse = v.InferOutput<
    typeof installationRegistrationResponseSchema
>;

/**
 * Public server configuration consumed by background compatibility logic.
 */
export type ServerConfigResponse = v.InferOutput<
    typeof serverConfigResponseSchema
>;

/**
 * Complete server-owned transcript identity used by cache and polling.
 */
export type ServerTranscriptIdentity = v.InferOutput<
    typeof serverTranscriptIdentitySchema
>;

/**
 * Stable safe failure details used by extension localization.
 */
export type ServerAnalysisFailure = v.InferOutput<
    typeof serverAnalysisFailureSchema
>;

/**
 * Stable full safe-code union shared with local and private legacy paths.
 */
export type ServerAnalysisFailureCode = v.InferOutput<
    typeof serverAnalysisFailureCodeSchema
>;

/**
 * Non-blocking response for one exact owner-authorized job.
 */
export type ProcessingResponse = v.InferOutput<typeof processingResponseSchema>;

/**
 * Exact ready response containing normalized promo blocks.
 */
export type ReadyResponse = v.InferOutput<typeof readyResponseSchema>;

/**
 * Exact terminal result when the model detects no promo blocks.
 */
export type NoPromoResponse = v.InferOutput<typeof noPromoResponseSchema>;

/**
 * Exact transcript-bound public limitation response.
 */
export type UnavailableResponse = v.InferOutput<
    typeof unavailableResponseSchema
>;

/**
 * Exact transcript-bound public model or internal failure.
 */
export type TerminalErrorResponse = v.InferOutput<
    typeof terminalErrorResponseSchema
>;

/**
 * Retryable response before or after transcript identity is available.
 */
export type RateLimitedResponse = v.InferOutput<
    typeof rateLimitedResponseSchema
>;

/**
 * Server-owned cache freshness mirrored by extension storage.
 */
export type ReadyResponseFreshness = v.InferOutput<
    typeof readyResponseFreshnessSchema
>;

/**
 * Known validated response consumed by the extension client.
 */
export type ServerAnalysisResponse = v.InferOutput<
    typeof serverAnalysisResponseSchema
>;

/**
 * Strict error response emitted before or after transcript identity.
 */
export type ErrorResponse = v.InferOutput<typeof errorResponseSchema>;

/**
 * Checks whether a candidate matches the canonical YouTube video-ID shape.
 *
 * @param videoId - Candidate watch-page identifier.
 * @returns True when the identifier is safe for public analysis.
 */
export function isValidYouTubeVideoId(videoId: string): boolean {
    return YOUTUBE_VIDEO_ID_PATTERN.test(videoId);
}

/**
 * Builds the official request from one canonicalized timed-caption payload.
 *
 * @param input - Current video metadata and captured caption payload.
 * @returns Strict public request without client hash or algorithm fields.
 */
export function buildServerAnalysisRequest(input: {
    videoId: string;
    durationSec?: number;
    extensionVersion: string;
    languageCode: string;
    segments: readonly CaptionSegment[];
}): ServerAnalysisRequest {
    const canonical = CaptionTranscriptCanonicalizer.canonicalize({
        languageCode: input.languageCode,
        segments: input.segments,
    });
    if (!canonical.ok) {
        throw new Error(`Invalid caption transcript: ${canonical.code}`);
    }

    return v.parse(serverAnalysisRequestSchema, {
        videoId: input.videoId,
        ...(input.durationSec === undefined
            ? {}
            : { durationSec: input.durationSec }),
        extensionVersion: input.extensionVersion,
        languageCode: canonical.transcript.languageCode,
        segments: canonical.transcript.segments,
        client: {
            source: 'chrome-extension',
            capabilities: [...SERVER_ANALYSIS_SUPPORTED_CAPABILITIES],
        },
    });
}
