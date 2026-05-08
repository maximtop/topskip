import { describe, expect, it } from 'vitest';

import type { CaptionSegment } from '@/shared/caption-types';
import { mergeCaptionSegmentsToTranscript } from '@/shared/captions/merge-transcript';

describe('mergeCaptionSegmentsToTranscript', () => {
    it('returns empty string for empty segments', () => {
        const r = mergeCaptionSegmentsToTranscript([], 10_000);
        expect(r.text).toBe('');
        expect(r.truncated).toBe(false);
    });

    it('sorts by startSec and joins deterministically', () => {
        const segments: CaptionSegment[] = [
            { startSec: 10, durationSec: 1, text: 'B' },
            { startSec: 2, durationSec: 1, text: 'A' },
        ];
        const r = mergeCaptionSegmentsToTranscript(segments, 10_000);
        expect(r.text).toBe('[2] A\n[10] B');
        expect(r.truncated).toBe(false);
    });

    it('sets truncated when exceeding maxChars', () => {
        const segments: CaptionSegment[] = [
            { startSec: 0, durationSec: 1, text: 'hello' },
        ];
        const r = mergeCaptionSegmentsToTranscript(segments, 4);
        expect(r.truncated).toBe(true);
        expect(r.text.length).toBeLessThanOrEqual(4);
    });
});
