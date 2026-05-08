import type { PromoBlock } from '@/shared/promo-types';

/**
 * Chunk-local promo block filtering before cross-chunk merge; static API only.
 */
export class ChunkMerge {
    /**
     * Drops promo blocks whose `startSec` lies outside this chunk's caption time
     * span, expanded by `toleranceSec` on both sides. Lets `endSec` extend past
     * the chunk so overlaps merge with later chunks; trims bogus chunk-local
     * timestamps from the model.
     *
     * @param blocks - Parsed blocks from one chunk response
     * @param chunkStartSec - First caption `startSec` in the chunk
     * @param chunkEndSec - Last caption `startSec` in the chunk
     * @param toleranceSec - Slack on both sides
     * @returns Filtered blocks (copy)
     */
    static filterPromoBlocksForChunkTimeRange(
        blocks: readonly PromoBlock[],
        chunkStartSec: number,
        chunkEndSec: number,
        toleranceSec: number,
    ): PromoBlock[] {
        const lo = chunkStartSec - toleranceSec;
        const hi = chunkEndSec + toleranceSec;
        return blocks.filter((b) => b.startSec >= lo && b.startSec <= hi);
    }
}
