/**
 * @file Pure helpers to compare model promo blocks to human-annotated
 * intervals (IoU, start/end deltas). Used by the maintainer compare CLI.
 */

/**
 * Human-annotated reference block for a promo segment, as recorded in the reference fixture JSON.
 */
export interface HumanRefBlock {
    /**
     * Stable identifier for this reference block, matched by index against `firstRunModel.blocks`.
     */
    id: string;

    /**
     * Reference start time in seconds, as annotated by a human reviewer.
     */
    startSec: number;

    /**
     * Reference end time in seconds, as annotated by a human reviewer.
     */
    endSec: number;

    /**
     * Optional caption snippet at window start (for reviewers)
     */
    startCue?: string;

    /**
     * Optional caption snippet at window end
     */
    endCue?: string;
}

/**
 * Model-predicted promo block, as recorded under `firstRunModel.blocks` in the reference fixture JSON.
 */
export interface ReferencePredBlock {
    /**
     * Predicted start time in seconds.
     */
    startSec: number;

    /**
     * Predicted end time in seconds. Absent when the model did not report an end boundary.
     */
    endSec?: number | undefined;
}

/**
 * Parsed reference fixture for one video: human annotations plus an optional first model run to compare against.
 */
export interface ReferenceBundle {
    /**
     * Video identifier, when present in the fixture.
     */
    videoId?: string | undefined;

    /**
     * Human-annotated reference blocks for this video, in timeline order.
     */
    humanBlocks: HumanRefBlock[];

    /**
     * Optional first model run recorded for comparison against the human blocks.
     */
    firstRunModel?: {
        /**
         * Identifier of the model that produced this run.
         */
        model: string;

        /**
         * Predicted blocks from this model run, in timeline order.
         */
        blocks: ReferencePredBlock[];
    } | undefined;
}

/**
 * Per-block comparison of one model prediction against its aligned human-annotated reference.
 */
export interface AlignedBlockMetric {
    /**
     * Identifier of the human reference block this row was aligned to.
     */
    id: string;

    /**
     * Human-annotated start time in seconds.
     */
    humanStartSec: number;

    /**
     * Human-annotated end time in seconds.
     */
    humanEndSec: number;

    /**
     * Predicted start time in seconds.
     */
    predStartSec: number;

    /**
     * Predicted end time in seconds; falls back to the human end time when the prediction omitted it.
     */
    predEndSec: number;

    /**
     * Whether `predEndSec` was assumed from the human block because the prediction had no `endSec`.
     */
    predEndAssumed: boolean;

    /**
     * Predicted minus human start time, in seconds.
     */
    startDeltaSec: number;

    /**
     * Predicted minus human end time, in seconds.
     */
    endDeltaSec: number;

    /**
     * Intersection-over-union between the predicted and human intervals.
     */
    iouWithHuman: number;
}

/**
 * Intersection-over-union for two closed intervals on the real line.
 *
 * @param a0 - Interval A start (sec)
 * @param a1 - Interval A end (sec), strictly after a0
 * @param b0 - Interval B start
 * @param b1 - Interval B end, strictly after b0
 *
 * @returns IoU in [0, 1]
 */
export function intervalIoU(
    a0: number,
    a1: number,
    b0: number,
    b1: number,
): number {
    const inter = Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
    const lenA = a1 - a0;
    const lenB = b1 - b0;
    const union = lenA + lenB - inter;
    if (union <= 0) {
        return 0;
    }
    return inter / union;
}

/**
 * Aligns by index: pairs human[i] with pred[i] up to the shorter list length.
 * When a predicted block has no `endSec`, uses the human block’s end for
 * metrics so start skew and overlap are still visible (flagged as assumed).
 *
 * @param human - Ordered reference windows
 * @param pred - Model blocks in timeline order
 *
 * @returns One metric row per aligned index
 */
export function compareHumanAlignedBlocks(
    human: readonly HumanRefBlock[],
    pred: readonly ReferencePredBlock[],
): AlignedBlockMetric[] {
    const n = Math.min(human.length, pred.length);
    const out: AlignedBlockMetric[] = [];
    for (let i = 0; i < n; i += 1) {
        // n = min(human.length, pred.length), so both indices are in range.
        const h = human[i]!;
        const p = pred[i]!;
        const assumed = p.endSec === undefined;
        const pe = assumed ? h.endSec : p.endSec;
        const predEnd = pe ?? h.endSec;
        out.push({
            id: h.id,
            humanStartSec: h.startSec,
            humanEndSec: h.endSec,
            predStartSec: p.startSec,
            predEndSec: predEnd,
            predEndAssumed: assumed,
            startDeltaSec: p.startSec - h.startSec,
            endDeltaSec: predEnd - h.endSec,
            iouWithHuman: intervalIoU(
                h.startSec,
                h.endSec,
                p.startSec,
                predEnd,
            ),
        });
    }
    return out;
}

/**
 * Narrows a value to a non-null, non-array object so its properties can be read safely.
 *
 * @param x - Value to check.
 *
 * @returns Whether `x` is a plain object (not `null` and not an array).
 */
function isRecord(x: unknown): x is Record<string, unknown> {
    return x !== null && typeof x === 'object' && !Array.isArray(x);
}

/**
 * Parses and validates one element of the `humanBlocks` array from the reference fixture JSON.
 *
 * @param item - One element of `humanBlocks` in the JSON file
 * @param index - 0-based index for error messages
 *
 * @returns Parsed human block
 *
 * @throws {Error} When `item` is not an object, or its `id`/`startSec`/`endSec` fields are missing or invalid.
 */
function parseHumanBlock(item: unknown, index: number): HumanRefBlock {
    if (!isRecord(item)) {
        throw new Error(`humanBlocks[${String(index)}] must be an object`);
    }
    const { id } = item;
    const { startSec } = item;
    const { endSec } = item;
    if (typeof id !== 'string' || id.length === 0) {
        throw new Error(
            `humanBlocks[${String(index)}].id must be a non-empty string`,
        );
    }
    if (typeof startSec !== 'number' || typeof endSec !== 'number') {
        throw new Error(
            `humanBlocks[${String(index)}] needs numeric startSec and endSec`,
        );
    }
    if (
        !Number.isFinite(startSec)
        || !Number.isFinite(endSec)
        || endSec <= startSec
    ) {
        throw new Error(`humanBlocks[${String(index)}] has invalid start/end`);
    }
    const { startCue } = item;
    const { endCue } = item;
    const out: HumanRefBlock = { id, startSec, endSec };
    if (typeof startCue === 'string') {
        out.startCue = startCue;
    }
    if (typeof endCue === 'string') {
        out.endCue = endCue;
    }
    return out;
}

/**
 * Parses and validates one block under `firstRunModel.blocks` from the reference fixture JSON.
 *
 * @param item - One block under firstRunModel.blocks
 * @param index - Index for error messages
 *
 * @returns Parsed predicted block
 *
 * @throws {Error} When `item` is not an object, or its `startSec`/`endSec` fields are missing or invalid.
 */
function parsePredBlock(item: unknown, index: number): ReferencePredBlock {
    if (!isRecord(item)) {
        throw new Error(
            `firstRunModel.blocks[${String(index)}] must be an object`,
        );
    }
    const { startSec } = item;
    const { endSec } = item;
    if (typeof startSec !== 'number' || !Number.isFinite(startSec)) {
        throw new Error(
            `firstRunModel.blocks[${String(index)}].startSec must be a finite number`,
        );
    }
    if (endSec !== undefined) {
        const badEnd = typeof endSec !== 'number'
            || !Number.isFinite(endSec)
            || endSec <= startSec;
        if (badEnd) {
            throw new Error(
                `firstRunModel.blocks[${String(index)}].endSec is invalid`,
            );
        }
    }
    return { startSec, endSec };
}

/**
 * Parses and validates a reference fixture JSON document into a `ReferenceBundle`.
 *
 * @param jsonText - UTF-8 JSON matching the promo reference fixture shape
 *
 * @returns Parsed bundle
 *
 * @throws {Error} When `jsonText` is not valid JSON, or the parsed document does not match the fixture shape.
 */
export function parseReferenceBundleJson(jsonText: string): ReferenceBundle {
    let raw: unknown;
    try {
        raw = JSON.parse(jsonText) as unknown;
    } catch {
        throw new Error('reference file is not valid JSON');
    }
    if (!isRecord(raw)) {
        throw new Error('reference JSON root must be an object');
    }
    const { videoId } = raw;
    if (videoId !== undefined && typeof videoId !== 'string') {
        throw new Error('videoId must be a string when present');
    }
    const hb = raw.humanBlocks;
    if (!Array.isArray(hb) || hb.length === 0) {
        throw new Error('humanBlocks must be a non-empty array');
    }
    const humanBlocks = hb.map((item, i) => parseHumanBlock(item, i));

    let firstRunModel: ReferenceBundle['firstRunModel'];
    const fr = raw.firstRunModel;
    if (fr !== undefined) {
        if (!isRecord(fr)) {
            throw new Error('firstRunModel must be an object');
        }
        const { model } = fr;
        const blocksRaw = fr.blocks;
        if (typeof model !== 'string' || !Array.isArray(blocksRaw)) {
            throw new Error(
                'firstRunModel needs string model and blocks array',
            );
        }
        const blocks = blocksRaw.map((b, i) => parsePredBlock(b, i));
        firstRunModel = { model, blocks };
    }

    return { videoId, humanBlocks, firstRunModel };
}
