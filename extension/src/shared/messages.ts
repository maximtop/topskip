import * as v from 'valibot';

import { captionSegmentSchema } from '@/shared/caption-types';
import {
    userPreferencesSchema,
    type UserPreferences,
} from '@/shared/constants';
import type { PromoBlock, PromoDetectionStatus } from '@/shared/promo-types';
import type { PROVIDER_AVAILABILITY } from './chrome-prompt-api';

/**
 * Runtime message `type` strings (popup/content → background; background →
 * content/popup).
 */
export const TOPSKIP_MESSAGE = {
    GET_PREFS: 'TOPSKIP_GET_PREFS',
    SET_PREFS: 'TOPSKIP_SET_PREFS',
    GET_ACTIVE_PROVIDER: 'TOPSKIP_GET_ACTIVE_PROVIDER',
    SET_ACTIVE_PROVIDER: 'TOPSKIP_SET_ACTIVE_PROVIDER',
    GET_PROVIDER_LIST: 'TOPSKIP_GET_PROVIDER_LIST',
    PREFS_UPDATED: 'TOPSKIP_PREFS_UPDATED',
    /**
     * Watch content script fetched captions and forwards them for service worker
     * logging.
     */
    CAPTIONS_FROM_CONTENT: 'TOPSKIP_CAPTIONS_FROM_CONTENT',
    /**
     * Fetch `/api/timedtext` in the page MAIN world (content-script fetch can get
     * empty bodies on YouTube).
     */
    FETCH_TIMEDTEXT_PAGE: 'TOPSKIP_FETCH_TIMEDTEXT_PAGE',
    GET_OPENROUTER_CONFIG: 'TOPSKIP_GET_OPENROUTER_CONFIG',
    SET_OPENROUTER_CONFIG: 'TOPSKIP_SET_OPENROUTER_CONFIG',
    ADD_OPENROUTER_CUSTOM_MODEL: 'TOPSKIP_ADD_OPENROUTER_CUSTOM_MODEL',
    REMOVE_OPENROUTER_CUSTOM_MODEL: 'TOPSKIP_REMOVE_OPENROUTER_CUSTOM_MODEL',
    VALIDATE_OPENROUTER_MODEL: 'TOPSKIP_VALIDATE_OPENROUTER_MODEL',
    GET_DETECTION_STATUS: 'TOPSKIP_GET_DETECTION_STATUS',
    PROMO_DETECTION_UPDATED: 'TOPSKIP_PROMO_DETECTION_UPDATED',
    PROMO_BLOCKS_DETECTED: 'TOPSKIP_PROMO_BLOCKS_DETECTED',
    GET_CHROME_PROMPT_API_STATUS: 'TOPSKIP_GET_CHROME_PROMPT_API_STATUS',
    TRIGGER_CHROME_MODEL_DOWNLOAD: 'TOPSKIP_TRIGGER_CHROME_MODEL_DOWNLOAD',
    /**
     * Content script forwards a log line to the background
     * service worker console for easier debugging.
     */
    CONTENT_LOG: 'TOPSKIP_CONTENT_LOG',
} as const;

/**
 * Response from {@link TOPSKIP_MESSAGE.FETCH_TIMEDTEXT_PAGE}.
 */
export type FetchTimedtextPageResponse =
    | { ok: true; status: number; body: string }
    | { ok: false; error: string };

const captionsFromContentPayloadOkSchema = v.object({
    ok: v.literal(true),
    videoId: v.pipe(v.string(), v.minLength(1)),
    languageCode: v.string(),
    segments: v.array(captionSegmentSchema),
});

const captionsFromContentPayloadErrSchema = v.object({
    ok: v.literal(false),
    videoId: v.pipe(v.string(), v.minLength(1)),
    error: v.string(),
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
 * Detection snapshot for the active tab’s current video (popup).
 */
export type PromoDetectionStatePayload = {
    videoId: string;
    status: PromoDetectionStatus;
    promoBlocks?: PromoBlock[];
    error?: string;
    /**
     * True when some transcript regions were not analyzed or a chunk failed
     * (multi-chunk pipeline).
     */
    partialCoverage?: boolean;
};

export type GetDetectionStatusResponse =
    | { ok: true; state: PromoDetectionStatePayload | null }
    | { ok: false; error: string };

export type ProviderAvailabilityMessage =
    (typeof PROVIDER_AVAILABILITY)[keyof typeof PROVIDER_AVAILABILITY];

export type ProviderListItem = {
    id: string;
    displayName: string;
    availability: ProviderAvailabilityMessage;
};

export type GetActiveProviderResponse =
    | { ok: true; providerId: string; displayName: string; modelName: string }
    | { ok: false; error: string };

export type SetActiveProviderResponse =
    | { ok: true }
    | { ok: false; error: string };

export type GetProviderListResponse =
    | { ok: true; providers: ProviderListItem[] }
    | { ok: false; error: string };

export type GetChromePromptApiStatusResponse =
    | {
          ok: true;
          availability: ProviderAvailabilityMessage;
          downloadProgress: number | null;
      }
    | { ok: false; error: string };

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

export type TopSkipRuntimeMessage =
    | { type: typeof TOPSKIP_MESSAGE.GET_PREFS }
    | { type: typeof TOPSKIP_MESSAGE.SET_PREFS; enabled: boolean }
    | { type: typeof TOPSKIP_MESSAGE.GET_ACTIVE_PROVIDER }
    | {
          type: typeof TOPSKIP_MESSAGE.SET_ACTIVE_PROVIDER;
          providerId: string;
      }
    | { type: typeof TOPSKIP_MESSAGE.GET_PROVIDER_LIST }
    | { type: typeof TOPSKIP_MESSAGE.PREFS_UPDATED; prefs: UserPreferences }
    | {
          type: typeof TOPSKIP_MESSAGE.CAPTIONS_FROM_CONTENT;
          payload: CaptionsFromContentPayload;
      }
    | { type: typeof TOPSKIP_MESSAGE.FETCH_TIMEDTEXT_PAGE; url: string }
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

export type GetPrefsResponse =
    | { ok: true; prefs: UserPreferences }
    | { ok: false; error: string };

export type SetPrefsResponse = { ok: true } | { ok: false; error: string };

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
 * Valibot schema for {@link TOPSKIP_MESSAGE.FETCH_TIMEDTEXT_PAGE}.
 * Validates structure only; the caller checks the allowed URL prefix
 * separately since an invalid prefix warrants an error response rather
 * than silently ignoring the message.
 */
export const fetchTimedtextPageMessageSchema = v.object({
    type: v.literal(TOPSKIP_MESSAGE.FETCH_TIMEDTEXT_PAGE),
    url: v.string(),
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
