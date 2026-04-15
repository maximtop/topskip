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
 * High-level detection status for UI (spec Key Entities).
 */
export type PromoDetectionStatus =
  | 'not_configured'
  | 'unavailable'
  | 'analyzing'
  | 'detected'
  | 'no_promo'
  | 'error';
