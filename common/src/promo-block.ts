/**
 * Canonical fallback duration (seconds) used when a promo block's end
 * time is unknown.
 *
 * Previously split into three duplicated constants (`DEFAULT_BLOCK_SPAN_SEC`
 * in promo-dedupe, `DEFAULT_BLOCK_END_OFFSET_SEC` in promo-skip-logic,
 * `DEFAULT_BLOCK_TAIL_SEC` in promo-range-format). Unified here so a single
 * tuning change propagates everywhere.
 */
export const DEFAULT_PROMO_BLOCK_DURATION_SEC = 30;
