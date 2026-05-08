import type { CaptionSegment } from '@/shared/caption-types';

/**
 * Merges caption segments into one deterministic transcript string for the LLM
 * user message (spec: chronological, bounded).
 *
 * @param segments - Caption rows from YouTube transcript
 * @param maxChars - Maximum characters for the merged text
 * @returns Merged transcript and whether the tail was truncated
 */
export function mergeCaptionSegmentsToTranscript(
    segments: CaptionSegment[],
    maxChars: number,
): { text: string; truncated: boolean } {
    if (segments.length === 0) {
        return { text: '', truncated: false };
    }
    const sorted = [...segments].sort((a, b) => a.startSec - b.startSec);
    const lines = sorted.map((s) => `[${s.startSec}] ${s.text.trim()}`);
    let text = lines.join('\n');
    let truncated = false;
    if (text.length > maxChars) {
        text = text.slice(0, maxChars);
        truncated = true;
    }
    return { text, truncated };
}
