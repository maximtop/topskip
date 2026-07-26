import * as v from 'valibot';

/**
 * Validates one caption cue row crossing the content → background boundary.
 */
export const captionSegmentSchema = v.object({
    startSec: v.number(),
    durationSec: v.number(),
    text: v.string(),
});

/**
 * One timed cue from a captured or extracted caption track.
 */
export type CaptionSegment = v.InferOutput<typeof captionSegmentSchema>;

/**
 * Result of fetching and parsing a transcript for a single video.
 */
export type TranscriptFetchResult =
    | {
          ok: true;
          videoId: string;
          languageCode?: string;
          segments: CaptionSegment[];
      }
    | { ok: false; error: string };
