import type { CaptionSegment } from '@/shared/caption-types';
import type { UserPreferences } from '@/shared/constants';

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

export type TopSkipRuntimeMessage =
  | { type: typeof TOPSKIP_MESSAGE.GET_PREFS }
  | { type: typeof TOPSKIP_MESSAGE.SET_PREFS; enabled: boolean }
  | { type: typeof TOPSKIP_MESSAGE.PREFS_UPDATED; prefs: UserPreferences }
  | {
      type: typeof TOPSKIP_MESSAGE.CAPTIONS_FROM_CONTENT;
      payload: CaptionsFromContentPayload;
    }
  | { type: typeof TOPSKIP_MESSAGE.FETCH_TIMEDTEXT_PAGE; url: string };

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
