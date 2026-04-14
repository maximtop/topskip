/**
 * One timed cue from a YouTube caption track (after XML parse).
 */
export interface CaptionSegment {
  /**
   * Start time in seconds (from the `start` attribute).
   */
  startSec: number;
  /**
   * On-screen duration in seconds (from `dur`, or 0 if absent).
   */
  durationSec: number;
  /**
   * Cue text with inline HTML stripped.
   */
  text: string;
}

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
