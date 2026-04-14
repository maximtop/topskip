import type { CaptionSegment } from '@/shared/caption-types';

const PREVIEW_LINES = 8;
const CHUNK_SIZE = 40;

/**
 * Logs structured caption data in the service worker for developer inspection.
 * Uses chunked logs to avoid a single unusably large console line.
 *
 * @param videoId YouTube video id.
 * @param languageCode Track language when known.
 * @param segments Parsed cues.
 * @returns A short text preview for messaging acks.
 */
export function logTranscriptForDeveloper(
  videoId: string,
  languageCode: string | undefined,
  segments: CaptionSegment[],
): string {
  const head = [
    '[TopSkip captions]',
    `videoId=${videoId}`,
    `lang=${languageCode ?? '?'}`,
    `total=${String(segments.length)}`,
  ].join(' ');
  console.info(head);

  const previewSlice = segments.slice(0, PREVIEW_LINES);
  for (const s of previewSlice) {
    console.info(
      `[TopSkip captions] ${s.startSec.toFixed(2)}s\t${s.text}`,
    );
  }

  if (segments.length > PREVIEW_LINES) {
    const more = segments.length - PREVIEW_LINES;
    console.info(
      `[TopSkip captions] … ${String(more)} more segment(s); chunked below`,
    );
  }

  for (let i = 0; i < segments.length; i += CHUNK_SIZE) {
    const chunk = segments.slice(i, i + CHUNK_SIZE);
    console.info(
      `[TopSkip captions] chunk ${String(i)}–${String(i + chunk.length - 1)}`,
      chunk.map((s) => ({
        start: s.startSec,
        dur: s.durationSec,
        text: s.text,
      })),
    );
  }

  return previewSlice.map((s) => s.text).join(' ').slice(0, 200);
}
