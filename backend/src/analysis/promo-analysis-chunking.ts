import { ChunkPlanner } from '@topskip/common/promo-chunk-planner';
import {
    SERVER_CHUNK_BUDGET_CHARS,
    SERVER_CHUNK_OVERLAP_SEC,
    SERVER_MAX_CHUNKS_PER_VIDEO,
} from '@topskip/common/promo-chunking-config';
import type { CaptionSegment } from '@topskip/common/caption-types';

/**
 * One transcript slice for one model call, with its caption time range.
 */
export type ServerTranscriptChunk = {
    index: number;
    startSec: number;
    endSec: number;
    segments: CaptionSegment[];
};

/**
 * Failure means the plan could not cover the transcript within the chunk cap;
 * contract limits make this unreachable, so callers treat it as an internal
 * error rather than truncating coverage silently.
 */
export type ServerChunkPlanResult =
    | { ok: true; chunks: ServerTranscriptChunk[] }
    | { ok: false };

/**
 * Plans fixed-overlap transcript chunks whose line format matches the
 * adapter's prompt lines, so the char budget maps 1:1 to prompt size.
 *
 * @param segments - Canonical transcript segments (already validated).
 * @returns Chunk slices, or `ok: false` when coverage would be partial.
 */
export function buildServerTranscriptChunks(
    segments: readonly CaptionSegment[],
): ServerChunkPlanResult {
    const lines = segments.map((segment) => ({
        sec: segment.startSec,
        line: `[${String(segment.startSec)}] ${segment.text}`,
    }));
    const plan = ChunkPlanner.buildChunkPlan(lines, {
        budgetChars: SERVER_CHUNK_BUDGET_CHARS,
        maxChunks: SERVER_MAX_CHUNKS_PER_VIDEO,
        overlap: { kind: 'fixed', sec: SERVER_CHUNK_OVERLAP_SEC },
    });
    if (plan.chunks.length === 0 || plan.partialCoverage) {
        return { ok: false };
    }
    return {
        ok: true,
        chunks: plan.chunks.map((chunk) => ({
            index: chunk.index,
            startSec: chunk.startSec,
            endSec: chunk.endSec,
            segments: segments.slice(
                chunk.lineStartIndex,
                chunk.lineEndIndex + 1,
            ),
        })),
    };
}
