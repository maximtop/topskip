import type { PromoBlock } from '@/shared/promo-types';

const DEFAULT_BLOCK_TAIL_SEC = 30;

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
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
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
      const approx = b.startSec + DEFAULT_BLOCK_TAIL_SEC;
      return `${start}–~${formatSecondsAsTimecode(approx)}`;
    })
    .join('; ');
}
