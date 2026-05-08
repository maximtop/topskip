import type { PromoBlock, PromoConfidence } from '@/shared/promo-types';
import { DEFAULT_PROMO_BLOCK_DURATION_SEC } from '@/shared/promo-block';

const CONF_RANK: Record<NonNullable<PromoConfidence>, number> = {
    low: 0,
    medium: 1,
    high: 2,
};

/**
 * Picks the higher-ranked promo confidence when merging overlapping blocks.
 *
 * @param a - Optional confidence
 * @param b - Optional confidence
 * @returns Stronger of the two, or whichever is defined
 */
function maxConfidence(
    a: PromoConfidence | undefined,
    b: PromoConfidence | undefined,
): PromoConfidence | undefined {
    if (a === undefined) {
        return b;
    }
    if (b === undefined) {
        return a;
    }
    return CONF_RANK[a] >= CONF_RANK[b] ? a : b;
}

/**
 * Sorts blocks by `startSec` and merges overlapping intervals into wider spans
 * (deterministic: merged end is the maximum of implied ends).
 *
 * @param blocks - Raw blocks from the LLM (may overlap)
 * @returns Non-overlapping blocks sorted by start
 */
export function sortAndDedupePromoBlocks(blocks: PromoBlock[]): PromoBlock[] {
    if (blocks.length === 0) {
        return [];
    }
    const sorted = [...blocks].sort((a, b) => a.startSec - b.startSec);
    const out: PromoBlock[] = [];
    const impliedEnd = (b: PromoBlock): number => {
        if (b.endSec !== undefined && b.endSec > b.startSec) {
            return b.endSec;
        }
        return b.startSec + DEFAULT_PROMO_BLOCK_DURATION_SEC;
    };
    for (const b of sorted) {
        if (out.length === 0) {
            out.push({ ...b });
            continue;
        }
        const last = out.at(-1);
        if (last === undefined) {
            out.push({ ...b });
            continue;
        }
        const lastEnd = impliedEnd(last);
        if (b.startSec < lastEnd) {
            const mergedEnd = Math.max(lastEnd, impliedEnd(b));
            last.endSec = mergedEnd;
        } else {
            out.push({ ...b });
        }
    }
    return out;
}

/**
 * Sorts by `startSec` and merges blocks when gap ≤ `gapSec` (in addition to
 * overlap), taking max confidence. Used after multi-chunk promo detection.
 *
 * @param blocks - Blocks from one or more chunk runs
 * @param gapSec - Maximum gap between implied ends to merge (seconds)
 * @returns Canonical merged list
 */
export function mergePromoBlocksWithGap(
    blocks: PromoBlock[],
    gapSec: number,
): PromoBlock[] {
    if (blocks.length === 0) {
        return [];
    }
    const sorted = [...blocks].sort((a, b) => a.startSec - b.startSec);
    const impliedEnd = (b: PromoBlock): number => {
        if (b.endSec !== undefined && b.endSec > b.startSec) {
            return b.endSec;
        }
        return b.startSec + DEFAULT_PROMO_BLOCK_DURATION_SEC;
    };
    const out: PromoBlock[] = [];
    for (const b of sorted) {
        if (out.length === 0) {
            out.push({ ...b });
            continue;
        }
        const last = out[out.length - 1];
        if (last === undefined) {
            out.push({ ...b });
            continue;
        }
        const lastEnd = impliedEnd(last);
        const gap = b.startSec - lastEnd;
        if (gap <= gapSec) {
            const mergedEnd = Math.max(lastEnd, impliedEnd(b));
            last.endSec = mergedEnd;
            last.confidence = maxConfidence(last.confidence, b.confidence);
        } else {
            out.push({ ...b });
        }
    }
    return out;
}
