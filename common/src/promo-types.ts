/**
 * Confidence label returned by the LLM for promo detection (FR-011).
 */
export type PromoConfidence = 'low' | 'medium' | 'high';

/**
 * One validated promo / sponsor integration block on the timeline.
 */
export type PromoBlock = {
    startSec: number;
    endSec?: number;
    confidence?: PromoConfidence;
};

/**
 * Stable promo-detection states shared across runtime packages.
 */
export const PROMO_DETECTION_STATUS = {
    NotConfigured: 'not_configured',
    Unavailable: 'unavailable',
    Analyzing: 'analyzing',
    Detected: 'detected',
    NoPromo: 'no_promo',
    Error: 'error',
} as const;

/**
 * High-level detection status for UI (spec Key Entities).
 */
export type PromoDetectionStatus =
    (typeof PROMO_DETECTION_STATUS)[keyof typeof PROMO_DETECTION_STATUS];
