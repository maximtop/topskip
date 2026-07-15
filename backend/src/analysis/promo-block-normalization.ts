import * as v from 'valibot';

import {
    BACKEND_ANALYSIS_FAILURE_REASON,
    type BackendAnalysisFailureReason,
} from '@topskip/backend/analysis/promo-analysis-types';
import { DEFAULT_PROMO_BLOCK_DURATION_SEC } from '@topskip/common/promo-block';
import { sortAndDedupePromoBlocks } from '@topskip/common/promo-dedupe';
import type { PromoBlock } from '@topskip/common/promo-types';
import { promoBlockSchema } from '@topskip/common/server-analysis-contract';

const MIN_TIMELINE_SEC = 0;
const FULL_VIDEO_BLOCK_START_SEC = 0;
const OPEN_ENDED_BLOCK_IMPLIED_DURATION_SEC = DEFAULT_PROMO_BLOCK_DURATION_SEC;

/**
 * Input for backend promo block normalization.
 */
export type BackendPromoBlockNormalizationInput = {
    promoBlocks: PromoBlock[];
    durationSec: number | undefined;
};

/**
 * Result of validating and normalizing model-produced promo blocks.
 */
export type BackendPromoBlockNormalizationResult =
    | { ok: true; promoBlocks: PromoBlock[] }
    | { ok: false; failureReason: BackendAnalysisFailureReason };

/**
 * Normalizes model promo blocks before the backend can deliver them to clients.
 *
 * @param input - Raw model blocks and optional known video duration.
 * @returns Sorted safe blocks, or a stable unsafe-block failure.
 */
export function normalizeBackendPromoBlocks(
    input: BackendPromoBlockNormalizationInput,
): BackendPromoBlockNormalizationResult {
    if (!input.promoBlocks.every(isSafeBlock(input.durationSec))) {
        return unsafeBlocks();
    }

    const normalized = sortAndDedupePromoBlocks(input.promoBlocks);
    if (!normalized.every(isSafeBlock(input.durationSec))) {
        return unsafeBlocks();
    }

    return { ok: true, promoBlocks: normalized };
}

/**
 * Builds a validation predicate scoped to the known duration.
 *
 * @param durationSec - Known video duration, if the extension sent one.
 * @returns Predicate that accepts only delivery-safe blocks.
 */
function isSafeBlock(
    durationSec: number | undefined,
): (block: PromoBlock) => boolean {
    return (block) => {
        const parsed = v.safeParse(promoBlockSchema, block);
        if (!parsed.success) {
            return false;
        }

        const endSec = effectiveEndSec(parsed.output);
        if (
            parsed.output.startSec < MIN_TIMELINE_SEC ||
            endSec <= parsed.output.startSec
        ) {
            return false;
        }

        if (durationSec === undefined) {
            return true;
        }

        if (parsed.output.startSec > durationSec || endSec > durationSec) {
            return false;
        }

        return !(
            parsed.output.startSec <= FULL_VIDEO_BLOCK_START_SEC &&
            endSec >= durationSec
        );
    };
}

/**
 * Mirrors content-side interpretation for blocks that omit an explicit end.
 *
 * @param block - Validated promo block.
 * @returns Explicit or implied timeline end.
 */
function effectiveEndSec(block: PromoBlock): number {
    return (
        block.endSec ?? block.startSec + OPEN_ENDED_BLOCK_IMPLIED_DURATION_SEC
    );
}

/**
 * Keeps unsafe model timing failures mapped to one public terminal reason.
 *
 * @returns Stable unsafe-block normalization failure.
 */
function unsafeBlocks(): BackendPromoBlockNormalizationResult {
    return {
        ok: false,
        failureReason: BACKEND_ANALYSIS_FAILURE_REASON.UnsafeModelBlocks,
    };
}
