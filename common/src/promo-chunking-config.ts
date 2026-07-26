/**
 * Chunking tunables shared by the BYOK (extension) and server (backend)
 * promo-analysis routes. Change only with evaluation data.
 */

/**
 * Merge adjacent LLM-reported blocks when the gap is at most this (seconds).
 */
export const BLOCK_MERGE_GAP_SEC = 3;

/**
 * Drop blocks whose `startSec` is farther than this outside the chunk range.
 */
export const CHUNK_BLOCK_TOLERANCE_SEC = 5;

/**
 * Server route: transcript character budget per model call.
 */
export const SERVER_CHUNK_BUDGET_CHARS = 60_000;

/**
 * Server route: fixed overlap so a typical promo block fits fully inside at
 * least one chunk; longer blocks are stitched by the cross-chunk merge.
 */
export const SERVER_CHUNK_OVERLAP_SEC = 240;

/**
 * Server route: chunk cap. With the 500k-char contract limit and the 60k
 * budget the worst case is ~9 chunks, so coverage is never truncated.
 */
export const SERVER_MAX_CHUNKS_PER_VIDEO = 12;
