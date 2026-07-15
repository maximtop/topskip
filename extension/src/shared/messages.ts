import * as v from 'valibot';

import { captionSegmentSchema } from '@topskip/common/caption-types';
import {
    type AnalysisMode,
    userPreferencesSchema,
    type UserPreferences,
} from '@/shared/constants';
import type {
    PromoBlock,
    PromoDetectionStatus,
} from '@topskip/common/promo-types';
import type { ServerAnalysisFailureCode } from '@topskip/common/server-analysis-contract';
import type { ProviderId } from '@/shared/providers';
import type { PROVIDER_AVAILABILITY } from './chrome-prompt-api';

/**
 * Runtime message `type` strings (popup/content → background; background →
 * content/popup).
 */
export const TOPSKIP_MESSAGE = {
    GET_PREFS: 'TOPSKIP_GET_PREFS',
    SET_PREFS: 'TOPSKIP_SET_PREFS',
    SET_ANALYSIS_MODE: 'TOPSKIP_SET_ANALYSIS_MODE',
    GET_ACTIVE_PROVIDER: 'TOPSKIP_GET_ACTIVE_PROVIDER',
    SET_ACTIVE_PROVIDER: 'TOPSKIP_SET_ACTIVE_PROVIDER',
    GET_PROVIDER_LIST: 'TOPSKIP_GET_PROVIDER_LIST',
    GET_MODEL_SETTINGS: 'TOPSKIP_GET_MODEL_SETTINGS',
    SET_ACTIVE_MODEL: 'TOPSKIP_SET_ACTIVE_MODEL',
    SAVE_CONNECTION_KEY: 'TOPSKIP_SAVE_CONNECTION_KEY',
    TEST_CONNECTION_KEY: 'TOPSKIP_TEST_CONNECTION_KEY',
    PREFS_UPDATED: 'TOPSKIP_PREFS_UPDATED',
    /**
     * Watch content script fetched captions and forwards them for service worker
     * logging.
     */
    CAPTIONS_FROM_CONTENT: 'TOPSKIP_CAPTIONS_FROM_CONTENT',
    /**
     * Installs a MAIN-world page bridge for player-mediated caption capture.
     */
    INSTALL_CAPTION_CAPTURE: 'TOPSKIP_INSTALL_CAPTION_CAPTURE',
    ACTIVATE_CAPTION_CAPTURE: 'TOPSKIP_ACTIVATE_CAPTION_CAPTURE',
    DEACTIVATE_CAPTION_CAPTURE: 'TOPSKIP_DEACTIVATE_CAPTION_CAPTURE',
    GET_OPENROUTER_CONFIG: 'TOPSKIP_GET_OPENROUTER_CONFIG',
    SET_OPENROUTER_CONFIG: 'TOPSKIP_SET_OPENROUTER_CONFIG',
    ADD_OPENROUTER_CUSTOM_MODEL: 'TOPSKIP_ADD_OPENROUTER_CUSTOM_MODEL',
    REMOVE_OPENROUTER_CUSTOM_MODEL: 'TOPSKIP_REMOVE_OPENROUTER_CUSTOM_MODEL',
    VALIDATE_OPENROUTER_MODEL: 'TOPSKIP_VALIDATE_OPENROUTER_MODEL',
    GET_DETECTION_STATUS: 'TOPSKIP_GET_DETECTION_STATUS',
    PREFLIGHT_BYOK_SETUP: 'TOPSKIP_PREFLIGHT_BYOK_SETUP',
    REQUEST_SERVER_ANALYSIS: 'TOPSKIP_REQUEST_SERVER_ANALYSIS',
    REFRESH_SERVER_ANALYSIS_STATUS: 'TOPSKIP_REFRESH_SERVER_ANALYSIS_STATUS',
    OPEN_SERVER_ANALYSIS_ISSUE: 'TOPSKIP_OPEN_SERVER_ANALYSIS_ISSUE',
    PROMO_DETECTION_UPDATED: 'TOPSKIP_PROMO_DETECTION_UPDATED',
    PROMO_BLOCKS_DETECTED: 'TOPSKIP_PROMO_BLOCKS_DETECTED',
    DEV_SET_DETECTION_STATUS: 'TOPSKIP_DEV_SET_DETECTION_STATUS',
    GET_CHROME_PROMPT_API_STATUS: 'TOPSKIP_GET_CHROME_PROMPT_API_STATUS',
    TRIGGER_CHROME_MODEL_DOWNLOAD: 'TOPSKIP_TRIGGER_CHROME_MODEL_DOWNLOAD',
    /**
     * Content script forwards a log line to the background
     * service worker console for easier debugging.
     */
    CONTENT_LOG: 'TOPSKIP_CONTENT_LOG',
} as const;

/**
 * Bounded caption acquisition failure reasons safe to surface in diagnostics.
 */
export const CAPTION_CAPTURE_FAILURE_REASON = {
    PlayerNotReady: 'player-not-ready',
    ActivationUnavailable: 'activation-unavailable',
    CaptureTimeout: 'capture-timeout',
    ParseFailed: 'parse-failed',
    CaptionsUnavailable: 'captions-unavailable',
    StaleVideo: 'stale-video',
    BridgeInstallFailed: 'bridge-install-failed',
} as const;

/**
 * Failure reason literals accepted in caption capture diagnostics.
 */
export type CaptionCaptureFailureReason =
    (typeof CAPTION_CAPTURE_FAILURE_REASON)[keyof typeof CAPTION_CAPTURE_FAILURE_REASON];

const captionCaptureFailureReasonSchema = v.picklist([
    CAPTION_CAPTURE_FAILURE_REASON.PlayerNotReady,
    CAPTION_CAPTURE_FAILURE_REASON.ActivationUnavailable,
    CAPTION_CAPTURE_FAILURE_REASON.CaptureTimeout,
    CAPTION_CAPTURE_FAILURE_REASON.ParseFailed,
    CAPTION_CAPTURE_FAILURE_REASON.CaptionsUnavailable,
    CAPTION_CAPTURE_FAILURE_REASON.StaleVideo,
    CAPTION_CAPTURE_FAILURE_REASON.BridgeInstallFailed,
] as const);

const captionCaptureDiagnosticsSchema = v.strictObject({
    stage: v.string(),
    bodyLength: v.optional(v.number()),
    segmentCount: v.optional(v.number()),
    languageCode: v.optional(v.string()),
    urlShape: v.optional(
        v.strictObject({
            pathname: v.string(),
            paramNames: v.array(v.string()),
            fmt: v.nullable(v.string()),
            hasPot: v.boolean(),
        }),
    ),
});

const captionsFromContentPayloadOkSchema = v.object({
    ok: v.literal(true),
    videoId: v.pipe(v.string(), v.minLength(1)),
    languageCode: v.string(),
    segments: v.array(captionSegmentSchema),
    diagnostics: v.optional(captionCaptureDiagnosticsSchema),
});

const captionsFromContentPayloadErrSchema = v.strictObject({
    ok: v.literal(false),
    videoId: v.pipe(v.string(), v.minLength(1)),
    error: v.string(),
    reason: v.optional(captionCaptureFailureReasonSchema),
    diagnostics: v.optional(captionCaptureDiagnosticsSchema),
});

/**
 * Valibot schema for the watch script captions payload (page → background).
 */
export const captionsFromContentPayloadSchema = v.union([
    captionsFromContentPayloadOkSchema,
    captionsFromContentPayloadErrSchema,
]);

/**
 * Payload from the watch content script after a transcript fetch in the page
 * context.
 */
export type CaptionsFromContentPayload = v.InferOutput<
    typeof captionsFromContentPayloadSchema
>;

/**
 * Full `runtime.sendMessage` body for
 * {@link TOPSKIP_MESSAGE.CAPTIONS_FROM_CONTENT} (watch content script →
 * background).
 */
export const captionsFromContentRuntimeMessageSchema = v.object({
    type: v.literal(TOPSKIP_MESSAGE.CAPTIONS_FROM_CONTENT),
    payload: captionsFromContentPayloadSchema,
});

/**
 * Runtime message body for validated content-script caption payloads.
 */
export type CaptionsFromContentRuntimeMessage = v.InferOutput<
    typeof captionsFromContentRuntimeMessageSchema
>;

/**
 * Result of interpreting an unknown runtime message in the captions handler.
 */
export type CaptionsFromContentIncomingOutcome =
    | { kind: 'ignore' }
    | { kind: 'invalid_captions' }
    | { kind: 'ok'; payload: CaptionsFromContentPayload };

/**
 * Single Valibot parse for the captions handler: classifies unknown input into
 * ignore (wrong / missing `type`), invalid captions payload, or success.
 * `payload` is optional on the outer object so non-captions messages (e.g.
 * `{}`) still parse before the transform runs.
 */
export const captionsFromContentIncomingMessageSchema = v.pipe(
    v.object({
        type: v.optional(v.string()),
        payload: v.optional(v.unknown()),
    }),
    v.transform((input): CaptionsFromContentIncomingOutcome => {
        if (input.type !== TOPSKIP_MESSAGE.CAPTIONS_FROM_CONTENT) {
            return { kind: 'ignore' };
        }
        const parsed = v.safeParse(
            captionsFromContentPayloadSchema,
            input.payload,
        );
        if (!parsed.success || !parsed.typed) {
            return { kind: 'invalid_captions' };
        }
        return { kind: 'ok', payload: parsed.output };
    }),
);

/**
 * Sanitized OpenRouter settings for the options page (never raw API key).
 */
export type GetOpenRouterConfigResponse =
    | {
          ok: true;
          model: string;
          apiKeyMasked: string | null;
          customModels: string[];
      }
    | { ok: false; error: string };

/**
 * Result of saving OpenRouter API key and selected model.
 */
export type SetOpenRouterConfigResponse =
    | { ok: true }
    | { ok: false; error: string };

/**
 * Response for add/remove custom OpenRouter model slug (options page).
 */
export type MutateOpenRouterCustomModelResponse =
    | { ok: true; customModels: string[] }
    | { ok: false; error: string };

/**
 * Origin of the latest promo detection state shown in the popup.
 */
export type PromoDetectionSource =
    | 'server'
    | 'local_provider'
    | 'local_cache'
    | 'server_cache';

/**
 * Message-free server context used for localized popup copy and safe issue
 * reporting.
 */
export type ServerAnalysisFailureContext = {
    code: ServerAnalysisFailureCode;
    supportId?: string;
    retryAfterSec?: number;
    apiVersion: number;
    algorithmVersion?: string;
    extensionVersion: string;
    supportIssueBaseUrl?: string;
};

/**
 * Detection snapshot for the active tab’s current video (popup).
 */
export type PromoDetectionStatePayload = {
    videoId: string;
    status: PromoDetectionStatus;
    source?: PromoDetectionSource;
    promoBlocks?: PromoBlock[];
    durationSec?: number;
    error?: string;
    serverFailure?: ServerAnalysisFailureContext;
    /**
     * True when some transcript regions were not analyzed or a chunk failed
     * (multi-chunk pipeline).
     */
    partialCoverage?: boolean;
};

/**
 * Popup response containing the latest detection state for the active tab.
 */
export type GetDetectionStatusResponse =
    | { ok: true; state: PromoDetectionStatePayload | null }
    | { ok: false; error: string };

/**
 * Content-to-background payload requesting server-first analysis.
 */
export type RequestServerAnalysisPayload = {
    videoId: string;
    durationSec?: number;
};

/**
 * Watch-open readiness probe for a video assigned to the Private BYOK route.
 */
export type PreflightByokSetupPayload = {
    videoId: string;
};

/**
 * Ack for a caption-independent Private BYOK readiness probe.
 */
export type PreflightByokSetupResponse =
    | { ok: true; status: 'inactive' | 'ready' | 'setup_required' }
    | { ok: false; error: string };

/**
 * Content-to-background payload requesting a pollable server job status.
 */
export type RefreshServerAnalysisStatusPayload = {
    videoId: string;
    jobId: string;
    durationSec?: number;
};

/**
 * Terminal server-analysis statuses acknowledged by background polling.
 */
export type ServerAnalysisTerminalStatus =
    | 'ready'
    | 'no_promo'
    | 'unavailable'
    | 'error'
    | 'rate_limited';

/**
 * Ack returned after the background updates server detection state.
 */
export type RequestServerAnalysisResponse =
    | { ok: true; status: 'processing'; jobId: string; pollAfterSec: number }
    | { ok: true; status: 'inactive' }
    | { ok: true; status: ServerAnalysisTerminalStatus }
    | { ok: false; error: string };

/**
 * Ack returned after the background refreshes a pollable server job status.
 */
export type RefreshServerAnalysisStatusResponse = RequestServerAnalysisResponse;

/**
 * Result of opening a sanitized GitHub server-analysis report.
 */
export type OpenServerAnalysisIssueResponse =
    | { ok: true }
    | { ok: false; error: string };

/**
 * Serialized provider availability state sent over runtime messages.
 */
export type ProviderAvailabilityMessage =
    (typeof PROVIDER_AVAILABILITY)[keyof typeof PROVIDER_AVAILABILITY];

/**
 * Provider registry item exposed to extension UI.
 */
export type ProviderListItem = {
    id: string;
    displayName: string;
    availability: ProviderAvailabilityMessage;
};

/**
 * Active provider metadata used by legacy provider-first UI paths.
 */
export type GetActiveProviderResponse =
    | { ok: true; providerId: string; displayName: string; modelName: string }
    | { ok: false; error: string };

/**
 * Result of changing the active provider through legacy provider messages.
 */
export type SetActiveProviderResponse =
    | { ok: true }
    | { ok: false; error: string };

/**
 * Provider list response returned to extension UI.
 */
export type GetProviderListResponse =
    | { ok: true; providers: ProviderListItem[] }
    | { ok: false; error: string };

/**
 * Chrome Prompt API readiness and download progress response.
 */
export type GetChromePromptApiStatusResponse =
    | {
          ok: true;
          availability: ProviderAvailabilityMessage;
          downloadProgress: number | null;
      }
    | { ok: false; error: string };

/**
 * Result of requesting Chrome Prompt API model download.
 */
export type TriggerChromeModelDownloadResponse =
    | { ok: true }
    | { ok: false; error: string };

/**
 * Response from slug validation: format check + optional API check.
 */
export type ValidateOpenRouterModelResponse =
    | { ok: true; valid: boolean; error?: string; unverified?: boolean }
    | { ok: false; error: string };

/**
 * User-facing model option serialized for options and popup UI.
 */
export type DetectionModelMessage = {
    id: string;
    label: string;
    providerId: ProviderId;
    providerLabel: string;
    modelName: string;
    requiresConnection: boolean;
    availability: ProviderAvailabilityMessage;
};

/**
 * Providers that expose API-key connection entries.
 */
export type ConnectionProviderId = 'openrouter' | 'openai';

export const CONNECTION_STATUS = {
    Missing: 'missing',
    Saved: 'saved',
} as const;

/**
 * Saved/missing key state for a provider connection row.
 */
export type ConnectionStatus =
    (typeof CONNECTION_STATUS)[keyof typeof CONNECTION_STATUS];

/**
 * Provider connection row sent to the model-first settings UI.
 */
export type ConnectionEntryMessage = {
    providerId: ConnectionProviderId;
    providerLabel: string;
    requiredForActiveModel: boolean;
    apiKeyMasked: string | null;
    status: ConnectionStatus;
};

/**
 * Complete model-first settings snapshot for options and popup.
 */
export type GetModelSettingsResponse =
    | {
          ok: true;
          activeModelId: string;
          models: DetectionModelMessage[];
          connections: ConnectionEntryMessage[];
          customOpenRouterModels: string[];
      }
    | { ok: false; error: string };

/**
 * Result of persisting a new active detection model.
 */
export type SetActiveModelResponse =
    | { ok: true }
    | { ok: false; error: string };

/**
 * Result of saving a provider connection key.
 */
export type SaveConnectionKeyResponse =
    | { ok: true; apiKeyMasked: string | null }
    | { ok: false; error: string };

/**
 * Result of validating a draft or saved provider connection key.
 */
export type TestConnectionKeyResponse =
    | { ok: true; valid: true }
    | { ok: true; valid: false; error: string }
    | { ok: false; error: string; retryable?: boolean };

/**
 * Log level for content-to-background log forwarding.
 */
export type ContentLogLevel = 'info' | 'warn' | 'error';

/**
 * Valibot schema for a {@link TOPSKIP_MESSAGE.CONTENT_LOG} message sent from
 * the content script to the background service worker.
 */
export const contentLogMessageSchema = v.object({
    type: v.literal(TOPSKIP_MESSAGE.CONTENT_LOG),
    level: v.picklist(['info', 'warn', 'error'] as const),
    args: v.array(v.unknown()),
});

/**
 * Union of all runtime messages routed through the background service worker.
 */
export type TopSkipRuntimeMessage =
    | { type: typeof TOPSKIP_MESSAGE.GET_PREFS }
    | { type: typeof TOPSKIP_MESSAGE.SET_PREFS; enabled: boolean }
    | {
          type: typeof TOPSKIP_MESSAGE.SET_ANALYSIS_MODE;
          analysisMode: AnalysisMode;
      }
    | { type: typeof TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER }
    | {
          type: typeof TOPSKIP_MESSAGE.SET_ACTIVE_PROVIDER;
          providerId: string;
      }
    | { type: typeof TOPSKIP_MESSAGE.GET_PROVIDER_LIST }
    | { type: typeof TOPSKIP_MESSAGE.GET_MODEL_SETTINGS }
    | {
          type: typeof TOPSKIP_MESSAGE.SET_ACTIVE_MODEL;
          modelId: string;
      }
    | {
          type: typeof TOPSKIP_MESSAGE.SAVE_CONNECTION_KEY;
          providerId: ConnectionProviderId;
          apiKey: string;
      }
    | {
          type: typeof TOPSKIP_MESSAGE.TEST_CONNECTION_KEY;
          providerId: ConnectionProviderId;
          apiKey?: string;
      }
    | { type: typeof TOPSKIP_MESSAGE.PREFS_UPDATED; prefs: UserPreferences }
    | {
          type: typeof TOPSKIP_MESSAGE.CAPTIONS_FROM_CONTENT;
          payload: CaptionsFromContentPayload;
      }
    | { type: typeof TOPSKIP_MESSAGE.INSTALL_CAPTION_CAPTURE }
    | { type: typeof TOPSKIP_MESSAGE.ACTIVATE_CAPTION_CAPTURE }
    | { type: typeof TOPSKIP_MESSAGE.DEACTIVATE_CAPTION_CAPTURE }
    | { type: typeof TOPSKIP_MESSAGE.GET_OPENROUTER_CONFIG }
    | {
          type: typeof TOPSKIP_MESSAGE.SET_OPENROUTER_CONFIG;
          apiKey: string;
          model: string;
      }
    | {
          type: typeof TOPSKIP_MESSAGE.ADD_OPENROUTER_CUSTOM_MODEL;
          slug: string;
      }
    | {
          type: typeof TOPSKIP_MESSAGE.REMOVE_OPENROUTER_CUSTOM_MODEL;
          slug: string;
      }
    | {
          type: typeof TOPSKIP_MESSAGE.VALIDATE_OPENROUTER_MODEL;
          slug: string;
          apiKey: string;
      }
    | { type: typeof TOPSKIP_MESSAGE.GET_DETECTION_STATUS }
    | {
          type: typeof TOPSKIP_MESSAGE.PREFLIGHT_BYOK_SETUP;
          payload: PreflightByokSetupPayload;
      }
    | {
          type: typeof TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS;
          payload: RequestServerAnalysisPayload;
      }
    | {
          type: typeof TOPSKIP_MESSAGE.REFRESH_SERVER_ANALYSIS_STATUS;
          payload: RefreshServerAnalysisStatusPayload;
      }
    | { type: typeof TOPSKIP_MESSAGE.OPEN_SERVER_ANALYSIS_ISSUE }
    | {
          type: typeof TOPSKIP_MESSAGE.DEV_SET_DETECTION_STATUS;
          state: PromoDetectionStatePayload | null;
      }
    | {
          type: typeof TOPSKIP_MESSAGE.PROMO_DETECTION_UPDATED;
          payload: PromoDetectionStatePayload;
      }
    | {
          type: typeof TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED;
          videoId: string;
          promoBlocks: PromoBlock[];
          /**
           * True when the chunk plan was capped, a chunk failed, or the merged
           * transcript hit the global safety cap (same meaning as detection
           * status payload).
           */
          partialCoverage?: boolean;
      }
    | { type: typeof TOPSKIP_MESSAGE.GET_CHROME_PROMPT_API_STATUS }
    | { type: typeof TOPSKIP_MESSAGE.TRIGGER_CHROME_MODEL_DOWNLOAD }
    | {
          type: typeof TOPSKIP_MESSAGE.CONTENT_LOG;
          level: ContentLogLevel;
          args: unknown[];
      };

/**
 * Narrows an opaque runtime `message` to the specific member of
 * {@link TopSkipRuntimeMessage} whose `type` equals `T['type']`.
 *
 * Checks only the `type` discriminant — no schema traversal — so callers can
 * rely on the TypeScript-typed payload without runtime schema boilerplate.
 *
 * @param type - The expected `type` literal (from `TOPSKIP_MESSAGE.*`).
 * @param message - Opaque value from `runtime.onMessage`.
 * @returns The narrowed message, or `undefined` when the type does not match.
 */
export function pickMessage<K extends TopSkipRuntimeMessage['type']>(
    type: K,
    message: unknown,
): Extract<TopSkipRuntimeMessage, { type: K }> | undefined {
    if (
        message === null ||
        typeof message !== 'object' ||
        Reflect.get(message, 'type') !== type
    ) {
        return undefined;
    }
    return message as Extract<TopSkipRuntimeMessage, { type: K }>;
}

/**
 * Response from reading stored user preferences.
 */
export type GetPrefsResponse =
    | { ok: true; prefs: UserPreferences }
    | { ok: false; error: string };

/**
 * Result of saving user preferences.
 */
export type SetPrefsResponse = { ok: true } | { ok: false; error: string };

/**
 * Result of changing the selected analysis route without replacing BYOK setup.
 */
export type SetAnalysisModeResponse =
    | { ok: true; prefs: UserPreferences }
    | { ok: false; error: string };

/**
 * Ack for {@link TOPSKIP_MESSAGE.CAPTIONS_FROM_CONTENT}.
 */
export type CaptionsFromContentAck =
    | { ok: true }
    | { ok: false; error: string };

/**
 * Message sent over the long-lived prefs port from the background to
 * connected extension pages.
 */
export type PrefsPortMessage = {
    type: typeof TOPSKIP_MESSAGE.PREFS_UPDATED;
    prefs: UserPreferences;
};

/**
 * Valibot schema for {@link PrefsPortMessage} and the equivalent
 * `runtime.sendMessage` broadcast. Exported so both the background
 * broadcast path and content-script receivers can parse it without
 * duplicating the definition.
 */
export const prefsUpdatedMessageSchema = v.object({
    type: v.literal(TOPSKIP_MESSAGE.PREFS_UPDATED),
    prefs: userPreferencesSchema,
});

/**
 * Type guard for messages received on a prefs port.
 *
 * @param msg Unknown value from `port.onMessage`.
 * @returns Whether `msg` is a valid {@link PrefsPortMessage}.
 */
export function isPrefsPortMessage(msg: unknown): msg is PrefsPortMessage {
    return v.safeParse(prefsUpdatedMessageSchema, msg).success;
}

/**
 * Valibot schema for {@link TOPSKIP_MESSAGE.GET_PREFS}.
 */
export const getPrefsMessageSchema = v.object({
    type: v.literal(TOPSKIP_MESSAGE.GET_PREFS),
});

/**
 * Valibot schema for {@link TOPSKIP_MESSAGE.SET_PREFS}.
 */
export const setPrefsMessageSchema = v.object({
    type: v.literal(TOPSKIP_MESSAGE.SET_PREFS),
    enabled: v.boolean(),
});

/**
 * Valibot schema for {@link TOPSKIP_MESSAGE.GET_OPENROUTER_CONFIG}.
 */
export const getOpenRouterConfigMessageSchema = v.object({
    type: v.literal(TOPSKIP_MESSAGE.GET_OPENROUTER_CONFIG),
});

/**
 * Valibot schema for {@link TOPSKIP_MESSAGE.SET_OPENROUTER_CONFIG}.
 */
export const setOpenRouterConfigMessageSchema = v.object({
    type: v.literal(TOPSKIP_MESSAGE.SET_OPENROUTER_CONFIG),
    apiKey: v.string(),
    model: v.string(),
});

/**
 * Valibot schema for {@link TOPSKIP_MESSAGE.ADD_OPENROUTER_CUSTOM_MODEL}.
 */
export const addOpenRouterCustomModelMessageSchema = v.object({
    type: v.literal(TOPSKIP_MESSAGE.ADD_OPENROUTER_CUSTOM_MODEL),
    slug: v.string(),
});

/**
 * Valibot schema for
 * {@link TOPSKIP_MESSAGE.REMOVE_OPENROUTER_CUSTOM_MODEL}.
 */
export const removeOpenRouterCustomModelMessageSchema = v.object({
    type: v.literal(TOPSKIP_MESSAGE.REMOVE_OPENROUTER_CUSTOM_MODEL),
    slug: v.string(),
});

/**
 * Valibot schema for {@link TOPSKIP_MESSAGE.VALIDATE_OPENROUTER_MODEL}.
 */
export const validateOpenRouterModelMessageSchema = v.object({
    type: v.literal(TOPSKIP_MESSAGE.VALIDATE_OPENROUTER_MODEL),
    slug: v.string(),
    apiKey: v.string(),
});

/**
 * Valibot schema for {@link TOPSKIP_MESSAGE.GET_DETECTION_STATUS}.
 */
export const getDetectionStatusMessageSchema = v.object({
    type: v.literal(TOPSKIP_MESSAGE.GET_DETECTION_STATUS),
});

/**
 * Valibot schema for {@link TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER}.
 */
export const getActiveProviderMessageSchema = v.object({
    type: v.literal(TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER),
});

/**
 * Valibot schema for {@link TOPSKIP_MESSAGE.GET_PROVIDER_LIST}.
 */
export const getProviderListMessageSchema = v.object({
    type: v.literal(TOPSKIP_MESSAGE.GET_PROVIDER_LIST),
});

/**
 * Valibot schema for {@link TOPSKIP_MESSAGE.SET_ACTIVE_PROVIDER}.
 */
export const setActiveProviderMessageSchema = v.object({
    type: v.literal(TOPSKIP_MESSAGE.SET_ACTIVE_PROVIDER),
    providerId: v.pipe(v.string(), v.minLength(1)),
});

/**
 * Valibot schema for
 * {@link TOPSKIP_MESSAGE.GET_CHROME_PROMPT_API_STATUS}.
 */
export const getChromePromptApiStatusMessageSchema = v.object({
    type: v.literal(TOPSKIP_MESSAGE.GET_CHROME_PROMPT_API_STATUS),
});

/**
 * Valibot schema for
 * {@link TOPSKIP_MESSAGE.TRIGGER_CHROME_MODEL_DOWNLOAD}.
 */
export const triggerChromeModelDownloadMessageSchema = v.object({
    type: v.literal(TOPSKIP_MESSAGE.TRIGGER_CHROME_MODEL_DOWNLOAD),
});

/**
 * Structural schema for a single promo block.
 */
const promoBlockSchema = v.object({
    startSec: v.number(),
    endSec: v.optional(v.number()),
    confidence: v.optional(v.picklist(['low', 'medium', 'high'] as const)),
});

/**
 * Valibot schema for {@link TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED}.
 */
export const promoBlocksDetectedMessageSchema = v.object({
    type: v.literal(TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED),
    videoId: v.string(),
    promoBlocks: v.array(promoBlockSchema),
    partialCoverage: v.optional(v.boolean()),
});
