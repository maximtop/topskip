/**
 * Reconciliation delay after a healthy detection status read or push.
 */
export const POPUP_DETECTION_HEALTHY_RECONCILE_MS = 10_000;

/**
 * Retry delay after popup state cannot be read from the background.
 */
export const POPUP_STATE_FAILURE_RETRY_MS = 2_000;

/**
 * Bounds a detection status read so one lost MV3 reply cannot block retries.
 */
export const POPUP_DETECTION_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Bounds the core preference read so a lost MV3 reply can enter retry flow.
 */
export const POPUP_CORE_PREFS_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Bounds the popup-open re-attach so a lost reply cannot leave the request
 * pending for the popup's lifetime; covers the background's probe plus its
 * bounded wait for an orphaned bundle to finish tearing down.
 */
export const POPUP_REATTACH_REQUEST_TIMEOUT_MS = 8_000;

/**
 * Minimum visible width (seconds) for a promo block bar in the popup UI.
 */
export const MIN_PROMO_BLOCK_WIDTH_SEC = 4;
