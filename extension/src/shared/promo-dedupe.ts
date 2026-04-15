import type { PromoBlock } from '@/shared/promo-types';

const DEFAULT_BLOCK_SPAN_SEC = 30;

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
    return b.startSec + DEFAULT_BLOCK_SPAN_SEC;
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
