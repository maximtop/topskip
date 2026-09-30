/**
 * @file Shared promo-block and promo-detection-status types used by the
 * backend, the extension and their common validation/formatting code.
 */

/**
 * Confidence label returned by the LLM for promo detection (FR-011).
 */
export type PromoConfidence = 'low' | 'medium' | 'high';

/**
 * One validated promo / sponsor integration block on the timeline.
 */
export interface PromoBlock {
    /**
     * Seconds from the start of the video where the promo/sponsor segment
     * begins.
     */
    startSec: number;

    /**
     * Seconds from the start of the video where the promo/sponsor segment
     * ends; absent when the model could not determine an end within the
     * visible transcript.
     */
    endSec?: number | undefined;

    /**
     * LLM-reported confidence for this block; absent when the model did not
     * report one.
     */
    confidence?: PromoConfidence | undefined;
}

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
export type PromoDetectionStatus = (typeof PROMO_DETECTION_STATUS)[keyof typeof PROMO_DETECTION_STATUS];
