import { MAX_PLAYBACK_DELTA_SEC } from '@/content/skip-logic';
import type { PromoBlock } from '@/shared/promo-types';
import { DEFAULT_PROMO_BLOCK_DURATION_SEC } from '@/shared/promo-block';

/**
 * Playback state needed to evaluate promo block skip decisions.
 */
export type PromoBlocksSkipInput = {
    prevTime: number;
    currentTime: number;
    duration: number;
    isSeeking: boolean;
    /**
     * Rounded `startSec` keys for blocks that already fired
     * (stable across list reorders).
     */
    firedStartKeys: ReadonlySet<number>;
    blocks: ReadonlyArray<PromoBlock>;
};

/**
 * Action produced by promo block skip evaluation.
 */
export type PromoBlocksSkipDecision =
    | { action: 'none' }
    | { action: 'skip'; blockIndex: number; targetTime: number };

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
        target = block.startSec + DEFAULT_PROMO_BLOCK_DURATION_SEC;
    }
    return Math.min(target, duration);
}

/**
 * Stable integer key for “already skipped” tracking across block list edits.
 *
 * @param startSec - Block start time
 * @returns Rounded second used as fired-tracking key
 */
export function promoBlockStartKey(startSec: number): number {
    return Math.round(startSec);
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
    const {
        prevTime,
        currentTime,
        duration,
        isSeeking,
        firedStartKeys,
        blocks,
    } = input;

    if (
        !Number.isFinite(duration) ||
        duration <= 0 ||
        isSeeking ||
        blocks.length === 0
    ) {
        return { action: 'none' };
    }

    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        if (block === undefined) {
            continue;
        }
        const startKey = promoBlockStartKey(block.startSec);
        if (firedStartKeys.has(startKey)) {
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

/**
 * Mutable fired-block state used when playback seeks backward.
 */
export type ResetFiredInput = {
    currentTime: number;
    prevTime: number;
    blocks: ReadonlyArray<PromoBlock>;
    firedStartKeys: Set<number>;
};

/**
 * Clears fired indices for blocks whose `startSec` is now ahead of
 * `currentTime` after a backward seek, so they can fire again on replay
 * (FR-004).
 *
 * @param input - Current playback state and fired set to mutate
 */
export function resetFiredIndicesOnBackwardSeek(input: ResetFiredInput): void {
    const { currentTime, prevTime, blocks, firedStartKeys } = input;
    if (currentTime >= prevTime || firedStartKeys.size === 0) {
        return;
    }
    for (const key of [...firedStartKeys]) {
        const block = blocks.find(
            (b) => promoBlockStartKey(b.startSec) === key,
        );
        if (block !== undefined && block.startSec > currentTime) {
            firedStartKeys.delete(key);
        }
    }
}
