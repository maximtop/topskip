import { SECONDS_PER_HOUR, SECONDS_PER_MINUTE } from '@/shared/constants';
import type { PromoBlock } from '@topskip/common/promo-types';
import { DEFAULT_PROMO_BLOCK_DURATION_SEC } from '@topskip/common/promo-block';

/**
 * Formats seconds as `m:ss` or `h:mm:ss` for popup display.
 *
 * @param sec - Time in seconds (non-negative)
 * @returns Compact timecode string
 */
export function formatSecondsAsTimecode(sec: number): string {
    if (!Number.isFinite(sec) || sec < 0) {
        return '?';
    }
    const total = Math.floor(sec);
    const h = Math.floor(total / SECONDS_PER_HOUR);
    const m = Math.floor((total % SECONDS_PER_HOUR) / SECONDS_PER_MINUTE);
    const s = total % SECONDS_PER_MINUTE;
    if (h > 0) {
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Human-readable list of promo block spans for the toolbar popup.
 *
 * @param blocks - Validated blocks for the current video
 * @returns Semicolon-separated ranges (e.g. `0:45–2:00` and `5:00–~5:30`)
 */
export function formatPromoBlocksSummary(
    blocks: readonly PromoBlock[],
): string {
    return blocks
        .map((b) => {
            const start = formatSecondsAsTimecode(b.startSec);
            if (b.endSec !== undefined && b.endSec > b.startSec) {
                return `${start}–${formatSecondsAsTimecode(b.endSec)}`;
            }
            const approx = b.startSec + DEFAULT_PROMO_BLOCK_DURATION_SEC;
            return `${start}–~${formatSecondsAsTimecode(approx)}`;
        })
        .join('; ');
}
