/**
 * One line-aligned slice of the merged transcript for one adapter call.
 */
export type ChunkPlanItem = {
    /**
     * Zero-based index in the plan
     */
    index: number;
    startSec: number;
    endSec: number;
    text: string;
    chars: number;
    lineStartIndex: number;
    lineEndIndex: number;
};

/**
 * Deterministic chunk layout for a merged transcript string.
 */
export type ChunkPlan = {
    chunks: ChunkPlanItem[];
    overlapSec: number;
    partialCoverage: boolean;
    plannedChunkCount: number;
    /**
     * Fraction of merged transcript characters covered by at least one planned
     * chunk (0–1).
     */
    coverageFraction: number;
};

/**
 * Timestamped transcript row: `line` is the exact prompt line, `sec` its
 * caption start time.
 */
export type TimedLine = { sec: number; line: string };

/**
 * Overlap policy: fixed seconds (server route) or dynamic from the chunk
 * budget (BYOK route, historical behavior).
 */
export type ChunkOverlapPolicy =
    | { kind: 'fixed'; sec: number }
    | {
          kind: 'dynamic';
          floorSec: number;
          ceilingSec: number;
          fraction: number;
      };

/**
 * Planner inputs; `maxChunks` bounds adapter calls per video.
 */
export type ChunkPlanOptions = {
    budgetChars: number;
    maxChunks: number;
    overlap: ChunkOverlapPolicy;
};

/**
 * Overlap can shrink to this floor before the planner truncates coverage.
 */
const OVERLAP_SHRINK_FLOOR_SEC = 30;

/**
 * Line-aligned overlapping chunk planning for promo transcript analysis;
 * static API only (`ChunkPlanner.buildChunkPlan`, etc.).
 */
export class ChunkPlanner {
    /**
     * Joins timed lines into the exact user-message body for the LLM.
     *
     * @param lines - Rows of `[sec] text` transcript lines
     * @param startIdx - First inclusive line index
     * @param endIdx - Last inclusive line index
     * @returns Newline-joined transcript slice
     */
    private static sliceLines(
        lines: readonly TimedLine[],
        startIdx: number,
        endIdx: number,
    ): string {
        const parts: string[] = [];
        for (let i = startIdx; i <= endIdx; i++) {
            const row = lines[i];
            if (row !== undefined) {
                parts.push(row.line);
            }
        }
        return parts.join('\n');
    }

    /**
     * Character length of a line slice (including internal newlines).
     *
     * @param lines - All timed lines
     * @param startIdx - First inclusive index
     * @param endIdx - Last inclusive index
     * @returns UTF-16 length of joined text
     */
    private static sliceCharLen(
        lines: readonly TimedLine[],
        startIdx: number,
        endIdx: number,
    ): number {
        if (endIdx < startIdx) {
            return 0;
        }
        let n = 0;
        for (let i = startIdx; i <= endIdx; i++) {
            const row = lines[i];
            if (row !== undefined) {
                n += row.line.length;
                if (i < endIdx) {
                    n += 1;
                }
            }
        }
        return n;
    }

    /**
     * Finds the largest `endIdx >= startIdx` such that the slice fits in
     * `budgetChars`.
     *
     * @param lines - Timed lines
     * @param startIdx - Chunk start line
     * @param budgetChars - Max UTF-16 length for joined slice
     * @returns Last inclusive line index
     */
    private static findEndIdxForBudget(
        lines: readonly TimedLine[],
        startIdx: number,
        budgetChars: number,
    ): number {
        if (lines.length === 0 || startIdx >= lines.length) {
            return startIdx - 1;
        }
        let endIdx = startIdx;
        let len = ChunkPlanner.sliceCharLen(lines, startIdx, endIdx);
        if (len > budgetChars) {
            return startIdx;
        }
        while (endIdx + 1 < lines.length) {
            const nextLen = ChunkPlanner.sliceCharLen(
                lines,
                startIdx,
                endIdx + 1,
            );
            if (nextLen > budgetChars) {
                break;
            }
            endIdx = endIdx + 1;
            len = nextLen;
        }
        return endIdx;
    }

    /**
     * Next chunk start line index for overlap: earliest line in
     * `[startIdx..endIdx]` within `overlapSec` seconds of `lines[endIdx].sec`.
     *
     * @param lines - Timed lines
     * @param startIdx - Current chunk first line
     * @param endIdx - Current chunk last line
     * @param overlapSec - Overlap window in seconds
     * @returns First line index of the next chunk
     */
    private static nextChunkStartIdx(
        lines: readonly TimedLine[],
        startIdx: number,
        endIdx: number,
        overlapSec: number,
    ): number {
        const endLine = lines[endIdx];
        if (endLine === undefined) {
            return endIdx + 1;
        }
        const anchorSec = endLine.sec;
        let k = startIdx;
        while (k < endIdx && anchorSec - lines[k].sec > overlapSec) {
            k = k + 1;
        }
        return k;
    }

    /**
     * One pass of chunk emission for a fixed overlap in seconds.
     *
     * @param lines - Parsed timed transcript lines
     * @param budgetChars - Adapter UTF-16 budget per chunk
     * @param overlapSec - Tail/head overlap between adjacent chunks
     * @returns Planned chunk rows before global index renumbering
     */
    private static tryPlan(
        lines: readonly TimedLine[],
        budgetChars: number,
        overlapSec: number,
    ): ChunkPlanItem[] {
        const out: ChunkPlanItem[] = [];
        let startIdx = 0;
        let index = 0;
        while (startIdx < lines.length) {
            let endIdx = ChunkPlanner.findEndIdxForBudget(
                lines,
                startIdx,
                budgetChars,
            );
            if (endIdx < startIdx) {
                endIdx = startIdx;
            }
            const oneLineLen = ChunkPlanner.sliceCharLen(
                lines,
                startIdx,
                startIdx,
            );
            if (oneLineLen > budgetChars) {
                const s0 = lines[startIdx].sec;
                const text = ChunkPlanner.sliceLines(lines, startIdx, startIdx);
                out.push({
                    index,
                    startSec: s0,
                    endSec: s0,
                    text,
                    chars: text.length,
                    lineStartIndex: startIdx,
                    lineEndIndex: startIdx,
                });
                index = index + 1;
                startIdx = startIdx + 1;
                continue;
            }

            const sFirst = lines[startIdx].sec;
            const sLast = lines[endIdx].sec;
            const text = ChunkPlanner.sliceLines(lines, startIdx, endIdx);
            out.push({
                index,
                startSec: sFirst,
                endSec: sLast,
                text,
                chars: text.length,
                lineStartIndex: startIdx,
                lineEndIndex: endIdx,
            });
            index = index + 1;

            if (endIdx >= lines.length - 1) {
                break;
            }

            let nextStart = ChunkPlanner.nextChunkStartIdx(
                lines,
                startIdx,
                endIdx,
                overlapSec,
            );
            if (nextStart <= startIdx) {
                nextStart = endIdx + 1;
            }
            startIdx = nextStart;
        }
        return out;
    }

    /**
     * Builds a deterministic overlapping chunk plan (overlap shrinks when the
     * plan would exceed `maxChunks`).
     *
     * @param lines - Timed transcript lines (`[sec] text` per row)
     * @param options - Budget, chunk cap, and overlap policy
     * @returns Chunk plan and coverage metadata
     */
    static buildChunkPlan(
        lines: readonly TimedLine[],
        options: ChunkPlanOptions,
    ): ChunkPlan {
        const { budgetChars, maxChunks, overlap } = options;
        if (lines.length === 0 || budgetChars <= 0) {
            return {
                chunks: [],
                overlapSec: OVERLAP_SHRINK_FLOOR_SEC,
                partialCoverage: false,
                plannedChunkCount: 0,
                coverageFraction: 0,
            };
        }

        const totalChars = ChunkPlanner.sliceCharLen(
            lines,
            0,
            lines.length - 1,
        );
        const firstSec = lines[0].sec;
        const lastSec = lines[lines.length - 1].sec;
        const durationSec = Math.max(lastSec - firstSec, 1e-6);
        const charsPerSec = totalChars / durationSec;

        const maxOverlapChars = Math.floor(budgetChars * 0.5);
        let overlapSec: number;
        if (overlap.kind === 'fixed') {
            // Keep the exact requested window (so a promo block up to that
            // length lands whole in one chunk); only shrink it if it would
            // consume more than half the budget and stall forward progress.
            overlapSec = overlap.sec;
            if (overlapSec * charsPerSec > maxOverlapChars) {
                overlapSec = Math.max(
                    OVERLAP_SHRINK_FLOOR_SEC,
                    maxOverlapChars / Math.max(charsPerSec, 1e-6),
                );
            }
        } else {
            overlapSec = Math.min(
                overlap.ceilingSec,
                Math.max(
                    overlap.floorSec,
                    (budgetChars * overlap.fraction) /
                        Math.max(charsPerSec, 1e-6),
                ),
            );
            const overlapChars = Math.min(
                maxOverlapChars,
                overlapSec * charsPerSec,
            );
            overlapSec = Math.min(
                overlap.ceilingSec,
                Math.max(
                    overlap.floorSec,
                    overlapChars / Math.max(charsPerSec, 1e-6),
                ),
            );
        }

        let chunks = ChunkPlanner.tryPlan(lines, budgetChars, overlapSec);
        let partialCoverage = false;

        while (
            chunks.length > maxChunks &&
            overlapSec > OVERLAP_SHRINK_FLOOR_SEC
        ) {
            overlapSec = Math.max(OVERLAP_SHRINK_FLOOR_SEC, overlapSec * 0.75);
            chunks = ChunkPlanner.tryPlan(lines, budgetChars, overlapSec);
        }

        if (chunks.length > maxChunks) {
            chunks = chunks.slice(0, maxChunks);
            partialCoverage = true;
        }

        chunks.forEach((c, i) => {
            c.index = i;
        });

        let coverageFraction = 1;
        if (partialCoverage && chunks.length > 0) {
            const lastLine = Math.max(...chunks.map((c) => c.lineEndIndex));
            const coveredLen = ChunkPlanner.sliceCharLen(lines, 0, lastLine);
            coverageFraction = Math.min(
                1,
                coveredLen / Math.max(totalChars, 1),
            );
        }

        return {
            chunks,
            overlapSec,
            partialCoverage,
            plannedChunkCount: chunks.length,
            coverageFraction,
        };
    }
}
