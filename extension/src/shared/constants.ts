import * as v from 'valibot';

/**
 * Start of auto-skip window (seconds).
 */
export const SKIP_START_SEC = 30;

/**
 * End of auto-skip window (seconds).
 */
export const SKIP_END_SEC = 60;

/**
 * Single key in `browser.storage.local` for preferences (read/written only in
 * the background service worker).
 */
export const STORAGE_KEY_PREFS = 'topskip:prefs';

/**
 * Validates persisted preference objects from storage.
 */
export const userPreferencesSchema = v.object({
  enabled: v.boolean(),
});

export type UserPreferences = v.InferOutput<typeof userPreferencesSchema>;
