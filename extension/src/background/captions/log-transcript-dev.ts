/**
 * @file Dev-only console logging of caption capture timing, kept free of
 * user-visible transcript text.
 */

import { LOG_PREFIX_CAPTIONS } from '@/shared/constants';

import type { CaptionSegment } from '@topskip/common/caption-types';

/**
 * Exposes capture timing without copying user-visible captions into logs.
 *
 * @param videoId YouTube video id.
 * @param languageCode Track language when known.
 * @param segments Parsed cues.
 * @param enabled Explicit override used by unit tests.
 */
export function logTranscriptForDeveloper(
    videoId: string,
    languageCode: string | undefined,
    segments: CaptionSegment[],
    enabled = TOPSKIP_INCLUDE_DEV_LOCAL,
): void {
    if (!enabled) {
        return;
    }

    const firstStartSec = segments.reduce<number | undefined>(
        (earliest, segment) => (earliest === undefined
            ? segment.startSec
            : Math.min(earliest, segment.startSec)),
        undefined,
    );
    const lastEndSec = segments.reduce<number | undefined>(
        (latest, segment) => {
            const endSec = segment.startSec + segment.durationSec;
            return latest === undefined ? endSec : Math.max(latest, endSec);
        },
        undefined,
    );

    console.debug(LOG_PREFIX_CAPTIONS, {
        videoId,
        languageCode: languageCode ?? null,
        segmentCount: segments.length,
        firstStartSec: firstStartSec ?? null,
        lastEndSec: lastEndSec ?? null,
    });
}
