import type { CaptionSegment } from '@/shared/caption-types';
import type { UserPreferences } from '@/shared/constants';
import type { PromoBlock, PromoDetectionStatus } from '@/shared/promo-types';

/**
 * Runtime message `type` strings (popup/content → background; background →
 * content/popup).
 */
export const TOPSKIP_MESSAGE = {
  GET_PREFS: 'TOPSKIP_GET_PREFS',
  SET_PREFS: 'TOPSKIP_SET_PREFS',
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
  GET_DETECTION_STATUS: 'TOPSKIP_GET_DETECTION_STATUS',
  PROMO_DETECTION_UPDATED: 'TOPSKIP_PROMO_DETECTION_UPDATED',
  PROMO_BLOCKS_DETECTED: 'TOPSKIP_PROMO_BLOCKS_DETECTED',
} as const;

/**
 * Response from {@link TOPSKIP_MESSAGE.FETCH_TIMEDTEXT_PAGE}.
 */
export type FetchTimedtextPageResponse =
  | { ok: true; status: number; body: string }
  | { ok: false; error: string };

/**
 * Payload from the watch content script after a transcript fetch in the page
 * context.
 */
export type CaptionsFromContentPayload =
  | {
      ok: true;
      videoId: string;
      languageCode: string;
      segments: CaptionSegment[];
    }
  | { ok: false; videoId: string; error: string };

/**
 * Sanitized OpenRouter settings for the options page (never raw API key).
 */
export type GetOpenRouterConfigResponse =
  | {
      ok: true;
      enabled: boolean;
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
};

export type GetDetectionStatusResponse =
  | { ok: true; state: PromoDetectionStatePayload | null }
  | { ok: false; error: string };

export type TopSkipRuntimeMessage =
  | { type: typeof TOPSKIP_MESSAGE.GET_PREFS }
  | { type: typeof TOPSKIP_MESSAGE.SET_PREFS; enabled: boolean }
  | { type: typeof TOPSKIP_MESSAGE.PREFS_UPDATED; prefs: UserPreferences }
  | {
      type: typeof TOPSKIP_MESSAGE.CAPTIONS_FROM_CONTENT;
      payload: CaptionsFromContentPayload;
    }
  | { type: typeof TOPSKIP_MESSAGE.FETCH_TIMEDTEXT_PAGE; url: string }
  | { type: typeof TOPSKIP_MESSAGE.GET_OPENROUTER_CONFIG }
  | {
      type: typeof TOPSKIP_MESSAGE.SET_OPENROUTER_CONFIG;
      enabled: boolean;
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
  | { type: typeof TOPSKIP_MESSAGE.GET_DETECTION_STATUS }
  | {
      type: typeof TOPSKIP_MESSAGE.PROMO_DETECTION_UPDATED;
      payload: PromoDetectionStatePayload;
    }
  | {
      type: typeof TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED;
      videoId: string;
      promoBlocks: PromoBlock[];
    };

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
