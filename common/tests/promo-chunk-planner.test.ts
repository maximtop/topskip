import { describe, expect, it } from 'vitest';

import {
    ChunkPlanner,
    type TimedLine,
} from '@topskip/common/promo-chunk-planner';

/**
 * Chunk cap mirrored from the BYOK route so cap assertions stay coupled.
 */
const MAX_CHUNKS = 8;

/**
 * Dynamic overlap policy matching the BYOK route's historical behavior.
 */
const DYNAMIC = {
    kind: 'dynamic',
    floorSec: 30,
    ceilingSec: 90,
    fraction: 0.15,
} as const;

/**
 * Parses `[sec] text` merged-transcript lines for planner tests.
 *
 * @param mergedText - Newline-joined `[sec] text` transcript
 * @returns Timed lines the planner consumes
 */
function toLines(mergedText: string): TimedLine[] {
    const rows: TimedLine[] = [];
    for (const raw of mergedText.split('\n')) {
        const line = raw.trimEnd();
        const m = /^\[(\d+(?:\.\d+)?)\]\s*(.*)$/.exec(line);
        if (!m) {
            continue;
        }
        const sec = Number(m[1]);
        if (Number.isFinite(sec)) {
            rows.push({ sec, line });
        }
    }
    return rows;
}

/**
 * Builds a merged transcript with one `[sec] text` line per caption row.
 *
 * @param lineCount - Number of lines
 * @param secStep - Seconds between consecutive line timestamps
 * @param bodyRepeat - Repeated character count after the bracket prefix
 * @returns Newline-joined transcript
 */
function makeTimedTranscript(
    lineCount: number,
    secStep: number,
    bodyRepeat: number,
): string {
    const pad = 'x'.repeat(bodyRepeat);
    const lines: string[] = [];
    for (let i = 0; i < lineCount; i++) {
        lines.push(`[${String(i * secStep)}] ${pad}`);
    }
    return lines.join('\n');
}

describe('ChunkPlanner.buildChunkPlan', () => {
    it('returns no chunks for empty merged text', () => {
        const plan = ChunkPlanner.buildChunkPlan(toLines(''), {
            budgetChars: 500,
            maxChunks: MAX_CHUNKS,
            overlap: DYNAMIC,
        });
        expect(plan.chunks).toHaveLength(0);
        expect(plan.partialCoverage).toBe(false);
        expect(plan.coverageFraction).toBe(0);
    });

    it('returns no chunks when budget is non-positive', () => {
        const plan = ChunkPlanner.buildChunkPlan(toLines('[0] hi'), {
            budgetChars: 0,
            maxChunks: MAX_CHUNKS,
            overlap: DYNAMIC,
        });
        expect(plan.chunks).toHaveLength(0);
    });

    it('returns no chunks when there are no timed lines', () => {
        const plan = ChunkPlanner.buildChunkPlan(
            toLines('no bracket lines here'),
            { budgetChars: 100, maxChunks: MAX_CHUNKS, overlap: DYNAMIC },
        );
        expect(plan.chunks).toHaveLength(0);
    });

    it('fits the full transcript in one chunk when budget is large', () => {
        const merged = ['[0] a', '[10] b', '[20] c'].join('\n');
        const plan = ChunkPlanner.buildChunkPlan(toLines(merged), {
            budgetChars: 10_000,
            maxChunks: MAX_CHUNKS,
            overlap: DYNAMIC,
        });
        expect(plan.chunks).toHaveLength(1);
        expect(plan.partialCoverage).toBe(false);
        expect(plan.chunks[0]?.text).toBe(merged);
        expect(plan.coverageFraction).toBe(1);
    });

    it('is deterministic for the same inputs', () => {
        const lines = toLines(makeTimedTranscript(12, 2, 12));
        const options = {
            budgetChars: 80,
            maxChunks: MAX_CHUNKS,
            overlap: DYNAMIC,
        };
        const a = ChunkPlanner.buildChunkPlan(lines, options);
        const b = ChunkPlanner.buildChunkPlan(lines, options);
        expect(
            a.chunks.map((c) => ({
                startSec: c.startSec,
                endSec: c.endSec,
                lineStartIndex: c.lineStartIndex,
                lineEndIndex: c.lineEndIndex,
                text: c.text,
            })),
        ).toEqual(
            b.chunks.map((c) => ({
                startSec: c.startSec,
                endSec: c.endSec,
                lineStartIndex: c.lineStartIndex,
                lineEndIndex: c.lineEndIndex,
                text: c.text,
            })),
        );
        expect(a.overlapSec).toBe(b.overlapSec);
        expect(a.partialCoverage).toBe(b.partialCoverage);
    });

    it('produces multiple newline-aligned chunks when budget is tight', () => {
        const lines = toLines(makeTimedTranscript(24, 1, 20));
        const plan = ChunkPlanner.buildChunkPlan(lines, {
            budgetChars: 55,
            maxChunks: MAX_CHUNKS,
            overlap: DYNAMIC,
        });
        expect(plan.chunks.length).toBeGreaterThan(1);
        for (const c of plan.chunks) {
            expect(c.text).not.toMatch(/\n\n$/);
            expect(c.chars).toBeLessThanOrEqual(55);
        }
    });

    it('caps at maxChunks and sets partial coverage', () => {
        const lines = toLines(makeTimedTranscript(200, 5, 22));
        const plan = ChunkPlanner.buildChunkPlan(lines, {
            budgetChars: 48,
            maxChunks: MAX_CHUNKS,
            overlap: DYNAMIC,
        });
        expect(plan.chunks.length).toBe(MAX_CHUNKS);
        expect(plan.partialCoverage).toBe(true);
        expect(plan.coverageFraction).toBeLessThan(1);
        const last = plan.chunks[plan.chunks.length - 1];
        expect(last?.lineEndIndex).toBeLessThan(199);
    });

    it('fixed overlap: adjacent chunks share at least the requested window', () => {
        const lines: TimedLine[] = [];
        for (let sec = 0; sec < 3600; sec += 4) {
            lines.push({ sec, line: `[${sec}] word word word word word` });
        }
        const plan = ChunkPlanner.buildChunkPlan(lines, {
            budgetChars: 8_000,
            maxChunks: 12,
            overlap: { kind: 'fixed', sec: 240 },
        });
        expect(plan.chunks.length).toBeGreaterThan(1);
        expect(plan.partialCoverage).toBe(false);
        for (let i = 1; i < plan.chunks.length; i++) {
            const prev = plan.chunks[i - 1];
            const next = plan.chunks[i];
            expect(next.startSec).toBeLessThanOrEqual(prev.endSec - 239);
        }
    });

    it('fixed overlap: single chunk when the transcript fits the budget', () => {
        const lines = toLines('[0] hello\n[5] world');
        const plan = ChunkPlanner.buildChunkPlan(lines, {
            budgetChars: 60_000,
            maxChunks: 12,
            overlap: { kind: 'fixed', sec: 240 },
        });
        expect(plan.chunks).toHaveLength(1);
        expect(plan.overlapSec).toBe(240);
    });
});
