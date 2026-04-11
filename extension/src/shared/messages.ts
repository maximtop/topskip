import type { UserPreferences } from '@/shared/constants';

/**
 * Runtime message `type` strings (popup/content → background; background →
 * content/popup).
 */
export const TOPSKIP_MESSAGE = {
  GET_PREFS: 'TOPSKIP_GET_PREFS',
  SET_PREFS: 'TOPSKIP_SET_PREFS',
  PREFS_UPDATED: 'TOPSKIP_PREFS_UPDATED',
} as const;

export type TopSkipRuntimeMessage =
  | { type: typeof TOPSKIP_MESSAGE.GET_PREFS }
  | { type: typeof TOPSKIP_MESSAGE.SET_PREFS; enabled: boolean }
  | { type: typeof TOPSKIP_MESSAGE.PREFS_UPDATED; prefs: UserPreferences };

export type GetPrefsResponse =
  | { ok: true; prefs: UserPreferences }
  | { ok: false; error: string };

export type SetPrefsResponse = { ok: true } | { ok: false; error: string };
