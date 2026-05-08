/**
 * Tunables for transcript chunking (spec FR-010).
 * Change only with evaluation data.
 */

/**
 * Upper bound on adapter calls per video analysis.
 */
export const MAX_CHUNKS_PER_VIDEO = 8;

/**
 * Target overlap as a fraction of per-chunk char budget
 * (converted to seconds via transcript).
 */
export const OVERLAP_FRACTION = 0.15;

/**
 * Minimum overlap window in seconds of video time.
 */
export const OVERLAP_FLOOR_SEC = 30;

/**
 * Maximum overlap window in seconds of video time.
 */
export const OVERLAP_CEILING_SEC = 90;

/**
 * Merge adjacent LLM-reported blocks when gap ≤ this (seconds).
 */
export const BLOCK_MERGE_GAP_SEC = 3;

/**
 * Drop blocks whose `startSec` is farther than this outside the chunk
 * time range.
 */
export const CHUNK_BLOCK_TOLERANCE_SEC = 5;

/**
 * Safety cap for chunk text in service worker logs.
 */
export const LOG_CHUNK_TEXT_MAX_CHARS = 200_000;

/**
 * Safety cap for raw assistant text in logs.
 */
export const LOG_RAW_ASSISTANT_MAX_CHARS = 64_000;

/**
 * Safety cap for merged transcript in aggregate logs.
 */
export const LOG_MERGED_TEXT_MAX_CHARS = 300_000;
