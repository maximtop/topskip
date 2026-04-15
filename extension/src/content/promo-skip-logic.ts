import { MAX_PLAYBACK_DELTA_SEC } from '@/content/skip-logic';
import type { PromoBlock } from '@/shared/promo-types';

export type PromoBlocksSkipInput = {
  prevTime: number;
  currentTime: number;
  duration: number;
  isSeeking: boolean;
  firedIndices: ReadonlySet<number>;
  blocks: ReadonlyArray<PromoBlock>;
};

export type PromoBlocksSkipDecision =
  | { action: 'none' }
  | { action: 'skip'; blockIndex: number; targetTime: number };

const DEFAULT_BLOCK_END_OFFSET_SEC = 30;

/**
 * Computes seek target for a block, clamped to media duration.
 *
 * @param block - Promo block
 * @param duration - Media duration in seconds
 * @returns Target `currentTime` after skip
 */
export function computePromoBlockTargetTime(
  block: PromoBlock,
  duration: number,
): number {
  let target: number;
  if (block.endSec !== undefined && block.endSec > block.startSec) {
    target = block.endSec;
  } else {
    target = block.startSec + DEFAULT_BLOCK_END_OFFSET_SEC;
  }
  return Math.min(target, duration);
}

/**
 * Decides whether to skip the next unseen promo block when playback crosses its
 * start during natural playback (FR-015).
 *
 * @param input - Playback state and blocks
 * @returns Skip decision or none
 */
export function evaluatePromoBlocksSkip(
  input: PromoBlocksSkipInput,
): PromoBlocksSkipDecision {
  const { prevTime, currentTime, duration, isSeeking, firedIndices, blocks } =
    input;

  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    isSeeking ||
    blocks.length === 0
  ) {
    return { action: 'none' };
  }

  for (let i = 0; i < blocks.length; i++) {
    if (firedIndices.has(i)) {
      continue;
    }
    const block = blocks[i];
    if (block === undefined) {
      continue;
    }
    const start = block.startSec;
    const crossed =
      prevTime < start &&
      currentTime >= start &&
      currentTime < duration + 0.001;
    if (!crossed) {
      continue;
    }
    const delta = currentTime - prevTime;
    if (delta > MAX_PLAYBACK_DELTA_SEC) {
      continue;
    }
    const targetTime = computePromoBlockTargetTime(block, duration);
    return { action: 'skip', blockIndex: i, targetTime };
  }

  return { action: 'none' };
}

export type ResetFiredInput = {
  currentTime: number;
  prevTime: number;
  blocks: ReadonlyArray<PromoBlock>;
  firedIndices: Set<number>;
};

/**
 * Clears fired indices for blocks whose `startSec` is now ahead of
 * `currentTime` after a backward seek, so they can fire again on replay
 * (FR-004).
 *
 * @param input - Current playback state and fired set to mutate
 */
export function resetFiredIndicesOnBackwardSeek(
  input: ResetFiredInput,
): void {
  const { currentTime, prevTime, blocks, firedIndices } = input;
  if (currentTime >= prevTime || firedIndices.size === 0) {
    return;
  }
  for (const i of firedIndices) {
    const block = blocks[i];
    if (block !== undefined && block.startSec > currentTime) {
      firedIndices.delete(i);
    }
  }
}
