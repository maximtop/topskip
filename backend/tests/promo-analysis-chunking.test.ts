import { describe, expect, it } from 'vitest';

import { buildServerTranscriptChunks } from '@topskip/backend/analysis/promo-analysis-chunking';
import type { CaptionSegment } from '@topskip/common/caption-types';

/**
 * Builds a uniform transcript: one segment every 4 s, ~28 chars per line.
 *
 * @param totalSec - Transcript timeline length in seconds
 * @returns Ordered caption segments
 */
function makeSegments(totalSec: number): CaptionSegment[] {
    const segments: CaptionSegment[] = [];
    for (let sec = 0; sec < totalSec; sec += 4) {
        segments.push({
            startSec: sec,
            durationSec: 4,
            text: 'promo talk sample words here',
        });
    }
    return segments;
}

describe('buildServerTranscriptChunks', () => {
    it('returns one chunk for a short transcript', () => {
        const segments = makeSegments(600);
        const result = buildServerTranscriptChunks(segments);
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.chunks).toHaveLength(1);
        expect(result.chunks[0].segments).toHaveLength(segments.length);
    });

    it('splits a long transcript into overlapping chunks covering every segment', () => {
        const segments = makeSegments(13_600);
        const result = buildServerTranscriptChunks(segments);
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.chunks.length).toBeGreaterThan(1);
        // Adjacent chunks overlap by at least ~240s of video time.
        for (let i = 1; i < result.chunks.length; i++) {
            const prev = result.chunks[i - 1];
            const next = result.chunks[i];
            expect(next.startSec).toBeLessThanOrEqual(prev.endSec - 239);
        }
        // Every source segment appears in at least one chunk.
        const covered = new Set<number>();
        for (const chunk of result.chunks) {
            for (const s of chunk.segments) {
                covered.add(s.startSec);
            }
        }
        expect(covered.size).toBe(segments.length);
        // Chunk segment slices align with the reported time range.
        for (const chunk of result.chunks) {
            expect(chunk.segments[0]?.startSec).toBe(chunk.startSec);
            expect(chunk.segments.at(-1)?.startSec).toBe(chunk.endSec);
        }
    });
});
