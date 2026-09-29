/**
 * @file Builds the promo-detection benchmark README by scoring recorded model
 * samples against the corpus reference blocks and ranking the results.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
    benchmarkMessageSha256,
    buildBenchmarkMessages,
    type BenchmarkPreflight,
    BENCHMARK_OUTPUT_LIMIT_POLICY,
    BENCHMARK_REPEAT_COUNT,
    DIRECT_API_HARNESS,
    loadCorpusManifest,
    runBenchmarkPreflight,
} from './promo-benchmark-core';
import { PROMO_BENCHMARK_MODELS } from './promo-benchmark-models';
import {
    benchmarkRunKey,
    type BenchmarkPrediction,
    type BenchmarkSample,
    parseBenchmarkSample,
} from './promo-benchmark-run';

const BENCHMARK_README_RELATIVE_PATH = 'benchmarks/promo-detection/README.md';
const HISTORICAL_RUN_RELATIVE_PATH = 'benchmarks/promo-detection/runs/codex-agent-v1-prompt-v4-max';
const HISTORICAL_MANIFEST_RELATIVE_PATH = 'benchmarks/promo-detection/corpus/manifest-v1.json';
const MATCH_IOU_THRESHOLD = 0.5;

/**
 * Closed time interval in seconds, used for both reference and prediction blocks once any optional end is resolved.
 */
interface ClosedBlock {
    /**
     * Interval start, in seconds.
     */
    startSec: number;

    /**
     * Interval end, in seconds.
     */
    endSec: number;
}

/**
 * One matched pair between a reference block and a prediction block, produced by `bestBlockMatches`.
 */
interface BlockMatch {
    /**
     * Index of the matched block within the reference block list.
     */
    referenceIndex: number;

    /**
     * Index of the matched block within the prediction block list.
     */
    predictionIndex: number;

    /**
     * Intersection-over-union between the matched reference and prediction intervals.
     */
    iou: number;
}

/**
 * Candidate matching accumulated while `bestBlockMatches` searches for the highest-scoring assignment.
 */
interface MatchSelection {
    /**
     * Matched reference/prediction pairs chosen so far.
     */
    matches: BlockMatch[];

    /**
     * Sum of the IoU of every match in `matches`, used to break ties between selections of equal size.
     */
    totalIou: number;
}

/**
 * Aggregated scoring metrics for one model across the active corpus. The optional fields are only set once every
 * sample for the model is valid.
 */
interface ActiveMetrics {
    /**
     * Number of samples found on disk for this model; can be less than the full matrix size.
     */
    sampleCount: number;

    /**
     * Number of samples that passed sample-level validation.
     */
    validCount: number;

    /**
     * Count of reference blocks matched to a prediction (true positives), set once `validCount` covers every sample.
     */
    matchedBlockCount?: number;

    /**
     * Total reference blocks across the corpus, set once `validCount` covers every sample.
     */
    referenceBlockCount?: number;

    /**
     * Predicted blocks with no matching reference (false positives), set once `validCount` covers every sample.
     */
    extraBlockCount?: number;

    /**
     * Matched blocks divided by (matched + missed) reference blocks.
     */
    blockRecall?: number;

    /**
     * Matched blocks divided by (matched + extra) predicted blocks.
     */
    blockPrecision?: number;

    /**
     * Harmonic mean of `blockRecall` and `blockPrecision`.
     */
    blockF1?: number;

    /**
     * Average IoU of matched blocks over the total reference block count.
     */
    referenceIou?: number;

    /**
     * Mean absolute error between matched prediction and reference boundaries, in seconds.
     */
    boundaryMaeSec?: number;

    /**
     * Videos where every repeat run agreed on whether promo was present.
     */
    classificationStableVideos: number;

    /**
     * Videos where every repeat run agreed on the number of promo blocks.
     */
    blockCountStableVideos: number;

    /**
     * Median sample latency across the model's recorded samples, in milliseconds.
     */
    latencyP50Ms?: number;

    /**
     * Number of samples that reported token usage.
     */
    tokenSampleCount: number;

    /**
     * Sum of `totalTokens` across samples that reported usage.
     */
    totalTokens: number;

    /**
     * Sum of reported cost across samples, in US dollars; set only when at least one sample reported cost.
     */
    totalCostUsd?: number;
}

/**
 * One leaderboard row: a model paired with its aggregated metrics and, once ranked, its position.
 */
interface ActiveRow {
    /**
     * Benchmarked model descriptor this row reports on.
     */
    model: (typeof PROMO_BENCHMARK_MODELS)[number];

    /**
     * Aggregated scoring metrics for this model.
     */
    metrics: ActiveMetrics;

    /**
     * 1-based rank among complete rows, assigned by `rankRows`; unset for rows with incomplete metrics.
     */
    rank?: number;
}

/**
 * Summary of the archived corpus-v1 historical run, shown unranked in the report.
 */
interface HistoricalSummary {
    /**
     * Number of historical samples counted as valid.
     */
    validCount: number;

    /**
     * Videos where every repeat run agreed on whether promo was present.
     */
    classificationStableVideos: number;

    /**
     * Videos where every repeat run agreed on the number of promo blocks.
     */
    blockCountStableVideos: number;
}

/**
 * Narrows a value to a non-null, non-array object so its properties can be read safely.
 *
 * @param value - Value to check.
 *
 * @returns Whether `value` is a plain object (not `null` and not an array).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Reads and parses a JSON file from disk.
 *
 * @param filePath - Path to the JSON file to read.
 *
 * @returns Parsed JSON contents.
 *
 * @throws {Error} When `filePath` cannot be read or does not contain valid JSON.
 */
function parseJson(filePath: string): unknown {
    try {
        return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    } catch {
        throw new Error(`Benchmark artifact is malformed: ${filePath}.`);
    }
}

/**
 * Reads one recorded sample file and confirms it belongs to the expected leaderboard group before returning it.
 *
 * @param filePath - Path to the sample JSON file.
 * @param preflight - Preflight context describing the expected corpus, prompt and request configuration.
 * @param model - Model id the sample is expected to have been generated with.
 * @param videoId - Video id the sample is expected to cover.
 * @param repeat - Repeat number the sample is expected to record.
 * @param transcriptHash - Expected transcript hash for the video.
 * @param fixtureSha256 - Expected fixture digest for the video.
 * @param languageCode - Expected language code for the video.
 * @param messageSha256 - Expected digest of the benchmark messages sent for this sample.
 *
 * @returns Parsed sample, or `undefined` when no sample file exists at `filePath`.
 *
 * @throws {Error} When the sample file exists but does not match the expected leaderboard group.
 */
function parseActiveSample(
    filePath: string,
    preflight: BenchmarkPreflight,
    model: string,
    videoId: string,
    repeat: number,
    transcriptHash: string,
    fixtureSha256: string,
    languageCode: string,
    messageSha256: string,
): BenchmarkSample | undefined {
    if (!existsSync(filePath)) {
        return undefined;
    }
    const value = parseBenchmarkSample(parseJson(filePath));
    if (
        value.runKey !== benchmarkRunKey('default')
        || value.corpusId !== preflight.manifest.corpusId
        || value.corpusManifestSha256 !== preflight.manifestSha256
        || value.harness !== DIRECT_API_HARNESS
        || value.model !== model
        || value.reasoning !== 'default'
        || value.videoId !== videoId
        || value.repeat !== repeat
        || value.transcriptHash !== transcriptHash
        || value.fixtureSha256 !== fixtureSha256
        || value.languageCode !== languageCode
        || value.promptVersion !== preflight.promptVersion
        || value.promptSha256 !== preflight.promptSha256
        || value.messageSha256 !== messageSha256
        || value.outputLimitPolicy !== BENCHMARK_OUTPUT_LIMIT_POLICY
        || value.requestConfigSha256 !== preflight.requestConfigSha256
    ) {
        throw new Error('Active sample does not match the leaderboard group.');
    }
    return value;
}

/**
 * Builds the on-disk path of a recorded active-run sample file.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @param model - Model id the sample belongs to.
 * @param videoId - Video id the sample belongs to.
 * @param repeat - Repeat number of the sample.
 *
 * @returns Absolute path to the sample JSON file.
 */
function samplePath(
    repoRoot: string,
    model: string,
    videoId: string,
    repeat: number,
): string {
    return path.resolve(
        repoRoot,
        'benchmarks/promo-detection/runs',
        benchmarkRunKey('default'),
        'samples',
        model,
        `repeat-${String(repeat)}`,
        `${videoId}.json`,
    );
}

/**
 * Intersection-over-union between a reference and a prediction interval.
 *
 * @param reference - Reference interval.
 * @param prediction - Predicted interval.
 *
 * @returns IoU in [0, 1]; 0 when the intervals do not overlap or have zero combined length.
 */
function intervalIou(reference: ClosedBlock, prediction: ClosedBlock): number {
    const intersection = Math.max(
        0,
        Math.min(reference.endSec, prediction.endSec)
            - Math.max(reference.startSec, prediction.startSec),
    );
    const union = reference.endSec
        - reference.startSec
        + prediction.endSec
        - prediction.startSec
        - intersection;
    return union <= 0 ? 0 : intersection / union;
}

/**
 * Picks the better of two candidate block matchings: more matches wins, ties break on total IoU.
 *
 * @param left - First candidate matching.
 * @param right - Second candidate matching.
 *
 * @returns Whichever of `left`/`right` has more matches, or the higher total IoU when tied.
 */
function betterSelection(
    left: MatchSelection,
    right: MatchSelection,
): MatchSelection {
    if (left.matches.length !== right.matches.length) {
        return left.matches.length > right.matches.length ? left : right;
    }
    return left.totalIou >= right.totalIou ? left : right;
}

/**
 * Finds the highest-scoring one-to-one assignment between reference and prediction blocks, considering only pairs
 * at or above `MATCH_IOU_THRESHOLD`. Searches exhaustively over reference indices via recursion.
 *
 * @param references - Reference blocks for one video.
 * @param predictions - Predicted blocks for the same video.
 *
 * @returns The matched reference/prediction pairs chosen by the best-scoring assignment.
 */
function bestBlockMatches(
    references: readonly ClosedBlock[],
    predictions: readonly ClosedBlock[],
): BlockMatch[] {
    const visit = (
        referenceIndex: number,
        usedPredictions: Set<number>,
    ): MatchSelection => {
        if (referenceIndex >= references.length) {
            return { matches: [], totalIou: 0 };
        }
        let best = visit(referenceIndex + 1, usedPredictions);
        for (
            let predictionIndex = 0;
            predictionIndex < predictions.length;
            predictionIndex += 1
        ) {
            if (!usedPredictions.has(predictionIndex)) {
                const iou = intervalIou(
                    references[referenceIndex],
                    predictions[predictionIndex],
                );
                if (iou >= MATCH_IOU_THRESHOLD) {
                    usedPredictions.add(predictionIndex);
                    const tail = visit(referenceIndex + 1, usedPredictions);
                    usedPredictions.delete(predictionIndex);
                    const candidate: MatchSelection = {
                        matches: [
                            { referenceIndex, predictionIndex, iou },
                            ...tail.matches,
                        ],
                        totalIou: iou + tail.totalIou,
                    };
                    best = betterSelection(best, candidate);
                }
            }
        }
        return best;
    };
    return visit(0, new Set()).matches;
}

/**
 * Extracts closed intervals from a prediction, dropping any promo block whose `endSec` was not reported.
 *
 * @param prediction - Model prediction to read blocks from.
 *
 * @returns Closed blocks with both bounds present; empty when the prediction has no promo.
 */
function predictionBlocks(prediction: BenchmarkPrediction): ClosedBlock[] {
    if (!prediction.hasPromo) {
        return [];
    }
    return prediction.promoBlocks.flatMap((block) => (block.endSec === undefined
        ? []
        : [{ startSec: block.startSec, endSec: block.endSec }]));
}

/**
 * F1 score for a binary classification count, treating a zero denominator (no positives or negatives at all) as
 * a perfect score.
 *
 * @param truePositive - Number of true positives.
 * @param falsePositive - Number of false positives.
 * @param falseNegative - Number of false negatives.
 *
 * @returns F1 score in [0, 1].
 */
function classF1(
    truePositive: number,
    falsePositive: number,
    falseNegative: number,
): number {
    const denominator = 2 * truePositive + falsePositive + falseNegative;
    return denominator === 0 ? 1 : (2 * truePositive) / denominator;
}

/**
 * Median of a list of numbers.
 *
 * @param values - Values to summarize.
 *
 * @returns The median, or `undefined` when `values` is empty.
 */
function median(values: readonly number[]): number | undefined {
    if (values.length === 0) {
        return undefined;
    }
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 1) {
        return sorted[middle];
    }
    return (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Reads every recorded sample for one model, matches its predicted blocks against the corpus references, and
 * aggregates the resulting scoring metrics.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @param preflight - Preflight context describing the corpus and the expected sample metadata.
 * @param modelId - Model id to collect samples for.
 *
 * @returns Aggregated metrics for `modelId` across the active corpus.
 */
function collectActiveMetrics(
    repoRoot: string,
    preflight: BenchmarkPreflight,
    modelId: string,
): ActiveMetrics {
    const samplesByVideo = new Map<string, BenchmarkSample[]>();
    let sampleCount = 0;
    let validCount = 0;
    let blockTruePositive = 0;
    let blockFalsePositive = 0;
    let blockFalseNegative = 0;
    let referenceIouTotal = 0;
    let referenceBlockCount = 0;
    let boundaryErrorTotal = 0;
    let boundaryCount = 0;
    let tokenSampleCount = 0;
    let totalTokens = 0;
    let totalCostUsd = 0;
    let hasCost = false;
    const latencies: number[] = [];
    for (const item of preflight.manifest.items) {
        const videoSamples: BenchmarkSample[] = [];
        const messageSha256 = benchmarkMessageSha256(
            buildBenchmarkMessages(preflight.corpusRoot, item),
        );
        for (
            let repeat = 1;
            repeat <= BENCHMARK_REPEAT_COUNT;
            repeat += 1
        ) {
            const sample = parseActiveSample(
                samplePath(repoRoot, modelId, item.videoId, repeat),
                preflight,
                modelId,
                item.videoId,
                repeat,
                item.transcriptHash,
                item.fixtureSha256,
                item.languageCode,
                messageSha256,
            );
            if (sample !== undefined) {
                sampleCount += 1;
                videoSamples.push(sample);
                if (sample.costUsd !== undefined) {
                    totalCostUsd += sample.costUsd;
                    hasCost = true;
                }
                if (sample.valid && sample.prediction !== undefined) {
                    validCount += 1;
                    const references = item.paidPromoBlocks ?? [];
                    const predictions = predictionBlocks(sample.prediction);
                    const matches = bestBlockMatches(references, predictions);
                    blockTruePositive += matches.length;
                    blockFalsePositive += predictions.length - matches.length;
                    blockFalseNegative += references.length - matches.length;
                    referenceBlockCount += references.length;
                    for (const match of matches) {
                        const reference = references[match.referenceIndex];
                        const prediction = predictions[match.predictionIndex];
                        referenceIouTotal += match.iou;
                        boundaryErrorTotal
                            += Math.abs(prediction.startSec - reference.startSec)
                            + Math.abs(prediction.endSec - reference.endSec);
                        boundaryCount += 2;
                    }
                    latencies.push(sample.latencyMs);
                    if (sample.usage !== undefined) {
                        tokenSampleCount += 1;
                        totalTokens += sample.usage.totalTokens;
                    }
                }
            }
        }
        samplesByVideo.set(item.videoId, videoSamples);
    }
    let classificationStableVideos = 0;
    let blockCountStableVideos = 0;
    for (const item of preflight.manifest.items) {
        const samples = samplesByVideo.get(item.videoId) ?? [];
        const predictions = samples
            .filter(
                (sample) => sample.valid && sample.prediction !== undefined,
            )
            .map((sample) => sample.prediction)
            .filter(
                (prediction): prediction is BenchmarkPrediction => prediction !== undefined,
            );
        if (predictions.length === BENCHMARK_REPEAT_COUNT) {
            if (
                new Set(predictions.map((prediction) => prediction.hasPromo)).size
                === 1
            ) {
                classificationStableVideos += 1;
            }
            const blockCounts = predictions.map(
                (prediction) => (prediction.hasPromo ? prediction.promoBlocks.length : 0),
            );
            if (new Set(blockCounts).size === 1) {
                blockCountStableVideos += 1;
            }
        }
    }
    const metrics: ActiveMetrics = {
        sampleCount,
        validCount,
        classificationStableVideos,
        blockCountStableVideos,
        tokenSampleCount,
        totalTokens,
    };
    if (hasCost) {
        metrics.totalCostUsd = totalCostUsd;
    }
    if (validCount === preflight.manifest.itemCount * BENCHMARK_REPEAT_COUNT) {
        metrics.matchedBlockCount = blockTruePositive;
        metrics.referenceBlockCount = referenceBlockCount;
        metrics.extraBlockCount = blockFalsePositive;
        metrics.blockRecall = blockTruePositive
            / (blockTruePositive + blockFalseNegative);
        metrics.blockPrecision = blockTruePositive
            / (blockTruePositive + blockFalsePositive);
        metrics.blockF1 = classF1(
            blockTruePositive,
            blockFalsePositive,
            blockFalseNegative,
        );
        metrics.referenceIou = referenceBlockCount === 0
            ? 0
            : referenceIouTotal / referenceBlockCount;
        metrics.boundaryMaeSec = boundaryCount === 0
            ? Number.POSITIVE_INFINITY
            : boundaryErrorTotal / boundaryCount;
        metrics.latencyP50Ms = median(latencies);
    }
    return metrics;
}

/**
 * Ascending comparator for optional numbers: any value sorts before `undefined`, and two `undefined`s tie.
 *
 * @param left - First value to compare.
 * @param right - Second value to compare.
 *
 * @returns Negative when `left` sorts first, positive when `right` sorts first, 0 when they tie.
 */
function compareOptionalAscending(
    left: number | undefined,
    right: number | undefined,
): number {
    if (left === undefined && right === undefined) {
        return 0;
    }
    if (left === undefined) {
        return 1;
    }
    if (right === undefined) {
        return -1;
    }
    return left - right;
}

/**
 * Ranks rows with complete metrics by quality, repeat stability, cost then latency, assigning each a 1-based
 * `rank`; rows with incomplete metrics keep no rank and are appended afterwards in their original order.
 *
 * @param rows - Rows to rank.
 *
 * @returns Ranked complete rows followed by the unranked incomplete rows.
 */
function rankRows(rows: ActiveRow[]): ActiveRow[] {
    const complete = rows.filter((row) => row.metrics.blockRecall !== undefined);
    complete.sort((left, right) => {
        const quality = (right.metrics.blockRecall ?? 0)
                - (left.metrics.blockRecall ?? 0)
            || (right.metrics.blockF1 ?? 0) - (left.metrics.blockF1 ?? 0)
            || (right.metrics.referenceIou ?? 0)
                - (left.metrics.referenceIou ?? 0)
            || (left.metrics.boundaryMaeSec ?? Number.POSITIVE_INFINITY)
                - (right.metrics.boundaryMaeSec ?? Number.POSITIVE_INFINITY);
        if (quality !== 0) {
            return quality;
        }
        const stability = right.metrics.blockCountStableVideos
            - left.metrics.blockCountStableVideos;
        if (stability !== 0) {
            return stability;
        }
        const cost = compareOptionalAscending(
            left.metrics.totalCostUsd,
            right.metrics.totalCostUsd,
        );
        if (cost !== 0) {
            return cost;
        }
        const latency = compareOptionalAscending(
            left.metrics.latencyP50Ms,
            right.metrics.latencyP50Ms,
        );
        return latency !== 0
            ? latency
            : left.model.id.localeCompare(right.model.id);
    });
    const ranked = complete.map((row, index) => ({ ...row, rank: index + 1 }));
    const incomplete = rows.filter(
        (row) => row.metrics.blockRecall === undefined,
    );
    return [...ranked, ...incomplete];
}

/**
 * Parses and validates one prediction from the archived corpus-v1 historical run.
 *
 * @param value - Parsed JSON value for the prediction.
 *
 * @returns Parsed prediction.
 *
 * @throws {Error} When `value` does not match the expected historical prediction shape.
 */
function parseHistoricalPrediction(value: unknown): BenchmarkPrediction {
    if (!isRecord(value) || typeof value.hasPromo !== 'boolean') {
        throw new Error('Historical prediction is malformed.');
    }
    if (!value.hasPromo) {
        return { hasPromo: false };
    }
    if (!Array.isArray(value.promoBlocks) || value.promoBlocks.length === 0) {
        throw new Error('Historical promo prediction is malformed.');
    }
    const promoBlocks = value.promoBlocks.map((block) => {
        if (
            !isRecord(block)
            || typeof block.startSec !== 'number'
            || !Number.isFinite(block.startSec)
            || (block.endSec !== undefined
                && (typeof block.endSec !== 'number'
                    || !Number.isFinite(block.endSec)))
        ) {
            throw new Error('Historical promo block is malformed.');
        }
        return {
            startSec: block.startSec,
            endSec: block.endSec,
            confidence:
                typeof block.confidence === 'string'
                    ? block.confidence
                    : undefined,
        };
    });
    return { hasPromo: true, promoBlocks };
}

/**
 * Reads the archived corpus-v1 historical run, checks it still matches the pinned run/corpus metadata, and
 * summarizes its repeat stability.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @param promptSha256 - Expected prompt digest the historical run was recorded against.
 *
 * @returns Summary of the historical run's validity and repeat stability.
 *
 * @throws {Error} When the historical run metadata or corpus manifest no longer matches the pinned values.
 */
function historicalSummary(
    repoRoot: string,
    promptSha256: string,
): HistoricalSummary {
    const runValue = parseJson(
        path.resolve(repoRoot, HISTORICAL_RUN_RELATIVE_PATH, 'run.json'),
    );
    if (
        !isRecord(runValue)
        || runValue.schemaVersion !== 1
        || runValue.runId !== 'codex-agent-v1-prompt-v4-max'
        || runValue.corpusId !== 'promo-paid-v1'
        || runValue.harness !== 'Codex agent'
        || runValue.model !== 'gpt-5.6-sol'
        || runValue.reasoning !== 'max'
        || runValue.promptVersion !== '4'
        || runValue.promptSha256 !== promptSha256
        || runValue.repeatCount !== BENCHMARK_REPEAT_COUNT
        || runValue.expectedSampleCount !== 30
    ) {
        throw new Error('Historical run metadata is malformed.');
    }
    const manifestValue = loadCorpusManifest(
        path.resolve(repoRoot, HISTORICAL_MANIFEST_RELATIVE_PATH),
    );
    const englishCount = manifestValue.items.filter(
        (item) => item.languageCode === 'en',
    ).length;
    const russianCount = manifestValue.items.filter(
        (item) => item.languageCode === 'ru',
    ).length;
    if (
        manifestValue.corpusId !== 'promo-paid-v1'
        || manifestValue.itemCount !== 10
        || englishCount !== 5
        || russianCount !== 5
    ) {
        throw new Error('Historical corpus manifest is malformed.');
    }
    let validCount = 0;
    let classificationStableVideos = 0;
    let blockCountStableVideos = 0;
    for (const item of manifestValue.items) {
        const predictions: BenchmarkPrediction[] = [];
        for (
            let repeat = 1;
            repeat <= BENCHMARK_REPEAT_COUNT;
            repeat += 1
        ) {
            const filePath = path.resolve(
                repoRoot,
                HISTORICAL_RUN_RELATIVE_PATH,
                'samples',
                `repeat-${String(repeat)}`,
                `${item.videoId}.json`,
            );
            const prediction = parseHistoricalPrediction(parseJson(filePath));
            predictions.push(prediction);
            validCount += 1;
        }
        if (
            new Set(predictions.map((prediction) => prediction.hasPromo)).size
            === 1
        ) {
            classificationStableVideos += 1;
        }
        const blockCounts = predictions.map((prediction) => (prediction.hasPromo ? prediction.promoBlocks.length : 0));
        if (new Set(blockCounts).size === 1) {
            blockCountStableVideos += 1;
        }
    }
    return {
        validCount,
        classificationStableVideos,
        blockCountStableVideos,
    };
}

/**
 * Formats a fraction as a percentage string for the report table.
 *
 * @param value - Fraction to format, or `undefined` when not available.
 *
 * @returns Percentage rounded to one decimal, or an em dash when `value` is missing or not finite.
 */
function formatPercent(value: number | undefined): string {
    return value === undefined || !Number.isFinite(value)
        ? '—'
        : `${(value * 100).toFixed(1)}%`;
}

/**
 * Formats a millisecond duration as a seconds string for the report table.
 *
 * @param valueMs - Duration in milliseconds, or `undefined` when not available.
 *
 * @returns Duration in seconds rounded to two decimals, or an em dash when `valueMs` is missing.
 */
function formatSeconds(valueMs: number | undefined): string {
    return valueMs === undefined
        ? '—'
        : `${(valueMs / 1_000).toFixed(2)} s`;
}

/**
 * Formats a boundary error in seconds for the report table.
 *
 * @param value - Boundary error in seconds, or `undefined` when not available.
 *
 * @returns Error rounded to two decimals, or an em dash when `value` is missing or not finite.
 */
function formatBoundaryError(value: number | undefined): string {
    return value === undefined || !Number.isFinite(value)
        ? '—'
        : `${value.toFixed(2)} s`;
}

/**
 * Formats the average token count per sample for the report table.
 *
 * @param total - Sum of tokens across samples that reported usage.
 * @param sampleCount - Number of samples that reported usage.
 *
 * @returns Rounded average, locale-formatted, or an em dash when `sampleCount` is 0.
 */
function formatAverageTotalTokens(
    total: number,
    sampleCount: number,
): string {
    return sampleCount === 0
        ? '—'
        : Math.round(total / sampleCount).toLocaleString('en-US');
}

/**
 * Formats the average cost per sample for the report table.
 *
 * @param totalCost - Total observed cost in US dollars, or `undefined` when not available.
 * @param sampleCount - Number of samples the cost was observed over.
 *
 * @returns Cost per task formatted to 4 decimal places, or an em dash when unavailable.
 */
function formatCostPerTask(
    totalCost: number | undefined,
    sampleCount: number,
): string {
    return totalCost === undefined || sampleCount === 0
        ? '—'
        : `$${(totalCost / sampleCount).toFixed(4)}`;
}

/**
 * Formats a "matched / total" reference-block count for the report table.
 *
 * @param matched - Number of matched blocks, or `undefined` when not available.
 * @param referenceCount - Total number of reference blocks, or `undefined` when not available.
 *
 * @returns `"matched/referenceCount"`, or an em dash when either value is missing.
 */
function formatMatchedBlocks(
    matched: number | undefined,
    referenceCount: number | undefined,
): string {
    return matched === undefined || referenceCount === undefined
        ? '—'
        : `${String(matched)}/${String(referenceCount)}`;
}

/**
 * Escapes Markdown table-cell delimiters in a string.
 *
 * @param value - Text to escape.
 *
 * @returns `value` with every `|` escaped so it renders inside a Markdown table cell.
 */
function escapeMarkdown(value: string): string {
    return value.replaceAll('|', '\\|');
}

/**
 * Renders the paid-promo reference timing for one corpus video as report text.
 *
 * @param blocks - Reference blocks for the video, in timeline order.
 * @param referenceNote - Optional note attached to the corpus item; its presence distinguishes an explicit
 * "no paid promo" call-out from a plain "no promo" video.
 *
 * @returns Semicolon-joined `start–end` ranges, or a "no promo" placeholder when `blocks` is empty.
 */
function referenceText(
    blocks: readonly { startSec: number; endSec: number }[],
    referenceNote: string | undefined,
): string {
    if (blocks.length === 0) {
        return referenceNote === undefined ? 'no promo' : 'no paid promo';
    }
    return blocks
        .map((block) => `${String(block.startSec)}–${String(block.endSec)}`)
        .join('; ');
}

/**
 * Looks up the aggregated metrics for one model among the ranked rows.
 *
 * @param rows - Ranked rows to search.
 * @param modelId - Model id to look up.
 *
 * @returns Metrics for the row whose model id matches `modelId`.
 *
 * @throws {Error} When no row in `rows` has a matching model id.
 */
function metricsForModel(
    rows: readonly ActiveRow[],
    modelId: string,
): ActiveMetrics {
    const row = rows.find((candidate) => candidate.model.id === modelId);
    if (row === undefined) {
        throw new Error(`Benchmark model is missing from report: ${modelId}.`);
    }
    return row.metrics;
}

/**
 * Builds the full promo-detection benchmark README markdown: the ranked active-corpus leaderboard, the
 * production-choice call-outs and the archived historical row.
 *
 * @param repoRoot - Absolute path to the repository root.
 *
 * @returns Rendered README markdown.
 */
export function buildBenchmarkReadme(repoRoot: string): string {
    const preflight = runBenchmarkPreflight({
        repoRoot,
        requestedModelIds: [],
        reasoning: 'default',
    });
    const rows = rankRows(
        PROMO_BENCHMARK_MODELS.map((model) => ({
            model,
            metrics: collectActiveMetrics(repoRoot, preflight, model.id),
        })),
    );
    const historical = historicalSummary(repoRoot, preflight.promptSha256);
    const recordedSampleCount = rows.reduce(
        (sum, row) => sum + row.metrics.sampleCount,
        0,
    );
    const recordedCost = rows.reduce(
        (sum, row) => sum + (row.metrics.totalCostUsd ?? 0),
        0,
    );
    const kimiMetrics = metricsForModel(rows, 'kimi-k3');
    const lunaMetrics = metricsForModel(rows, 'gpt-5.6-luna');
    const deepseekV4FlashMetrics = metricsForModel(rows, 'deepseek-v4-flash');
    const deepseekV41FlashMetrics = metricsForModel(
        rows,
        'deepseek-v4.1-flash',
    );
    const sonnetMetrics = metricsForModel(rows, 'sonnet-5');
    const lines = [
        '# Promo-detection benchmark',
        '',
        'This tracked benchmark compares paid-sponsor detection on ten exact',
        'timed transcripts. Self-promotion is outside the active policy.',
        '',
        `Prompt v${preflight.promptVersion}: \`${preflight.promptSha256}\`.`,
        `The default matrix contains ${String(preflight.requestCount)} isolated`,
        'requests. Requests omit `max_tokens`, so each model uses its native',
        'output policy. Average tokens/task uses provider-reported',
        '`total_tokens`.',
        `Recorded ${String(recordedSampleCount)}/${String(
            preflight.requestCount,
        )} samples; observed cost is $${recordedCost.toFixed(2)}.`,
        '',
        '## Results',
        '',
        'Quality rank covers only complete Direct API / corpus v2 rows. It',
        'prioritizes found reference blocks, then Detection F1, time overlap,',
        'and boundary error. Cost and response time are shown explicitly so',
        'the practical trade-off does not depend on hidden weighting.',
        '',
        '- **Found refs**: reference blocks matched at >= 50% time overlap.',
        '- **Extra**: predicted blocks with no matching reference; lower is',
        '  better because every extra block can skip non-paid content.',
        '- **Detection F1**: one percentage balancing missed and extra blocks;',
        '  100% is perfect.',
        '- **Time overlap**: average overlap with reference timing; a missed',
        '  block contributes 0%.',
        '- **Boundary error**: average start/end timestamp error; lower is',
        '  better.',
        '- **Repeat stability**: videos where all three runs agreed on whether',
        '  promo exists and on the number of blocks.',
        '',
        '| Quality rank | Model | Harness | Corpus | Reasoning | Valid runs | Found refs | Extra | '
            + 'Detection F1 | Time overlap | Boundary error | Repeat stability (promo / blocks) | '
            + 'Median response | Cost/task | Avg tokens/task |',
        '| ---: | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |',
    ];
    for (const row of rows) {
        const { metrics } = row;
        lines.push(
            `| ${row.rank === undefined ? '—' : String(row.rank)} | `
                + `${row.model.id} | ${DIRECT_API_HARNESS} | `
                + `${preflight.manifest.corpusId} | default | `
                + `${String(metrics.validCount)}/30 | `
                + `${formatMatchedBlocks(
                    metrics.matchedBlockCount,
                    metrics.referenceBlockCount,
                )} | ${metrics.extraBlockCount === undefined
                    ? '—'
                    : String(metrics.extraBlockCount)} | `
                + `${formatPercent(metrics.blockF1)} | `
                + `${formatPercent(metrics.referenceIou)} | `
                + `${formatBoundaryError(metrics.boundaryMaeSec)} | `
                + `${String(metrics.classificationStableVideos)}/10 / `
                + `${String(metrics.blockCountStableVideos)}/10 | `
                + `${formatSeconds(metrics.latencyP50Ms)} | `
                + `${formatCostPerTask(
                    metrics.totalCostUsd,
                    metrics.sampleCount,
                )} | ${formatAverageTotalTokens(
                    metrics.totalTokens,
                    metrics.tokenSampleCount,
                )} |`,
        );
    }
    lines.push(
        '| archive | gpt-5.6-sol | Codex agent | promo-paid-v1 | max | '
            + `${String(historical.validCount)}/30 | — | — | — | — | — | `
            + `${String(historical.classificationStableVideos)}/10 / `
            + `${String(historical.blockCountStableVideos)}/10 | — | — | — |`,
        '',
        'The archive row stays unranked because corpus v1 has no curated block',
        'references and used a different harness. It is included here only for',
        'visibility.',
    );
    if (recordedSampleCount === preflight.requestCount) {
        lines.push(
            '',
            '## Practical choices',
            '',
            '- **Selected production default: deepseek-v4.1-flash.** '
                + `${formatMatchedBlocks(
                    deepseekV41FlashMetrics.matchedBlockCount,
                    deepseekV41FlashMetrics.referenceBlockCount,
                )} references found,`,
            `  ${String(deepseekV41FlashMetrics.extraBlockCount ?? 0)} extra, `
                + `${formatPercent(
                    deepseekV41FlashMetrics.referenceIou,
                )} time overlap, `
                + `${formatSeconds(
                    deepseekV41FlashMetrics.latencyP50Ms,
                )} observed response, `
                + `${formatCostPerTask(
                    deepseekV41FlashMetrics.totalCostUsd,
                    deepseekV41FlashMetrics.sampleCount,
                )}/task. Replaces deepseek-v4-flash (`
                + `${formatMatchedBlocks(
                    deepseekV4FlashMetrics.matchedBlockCount,
                    deepseekV4FlashMetrics.referenceBlockCount,
                )} found, ${String(
                    deepseekV4FlashMetrics.extraBlockCount ?? 0,
                )} extra, `
                + `${formatCostPerTask(
                    deepseekV4FlashMetrics.totalCostUsd,
                    deepseekV4FlashMetrics.sampleCount,
                )}/task) after production under-detected paid promo on a`
                + ' long (2h18m) Russian interview; on that exact chunk'
                + ' v4.1-flash reproduced the missed blocks in 20/20 repeat'
                + ' runs where v4-flash was inconsistent (3/0/3 blocks across'
                + ' three runs). On this ten-video tracked corpus the two'
                + ' models tie on found refs, while v4.1-flash records'
                + ' slightly more extra blocks and slightly lower repeat'
                + ' stability than v4-flash — a small-sample trade-off'
                + ' accepted for the long-transcript reliability gain.',
            `- **Highest paid-only detection quality: kimi-k3.** ${formatMatchedBlocks(
                kimiMetrics.matchedBlockCount,
                kimiMetrics.referenceBlockCount,
            )} references found,`,
            `  ${String(kimiMetrics.extraBlockCount ?? 0)} extra, `
                + `${formatPercent(kimiMetrics.referenceIou)} time overlap, `
                + `${formatSeconds(kimiMetrics.latencyP50Ms)} response, `
                + `${formatCostPerTask(
                    kimiMetrics.totalCostUsd,
                    kimiMetrics.sampleCount,
                )}/task.`,
            '- **Fast paid-only alternative: sonnet-5.**',
            `  ${formatSeconds(
                sonnetMetrics.latencyP50Ms,
            )} response, but ${formatCostPerTask(
                sonnetMetrics.totalCostUsd,
                sonnetMetrics.sampleCount,
            )}/task and ${String(
                sonnetMetrics.extraBlockCount ?? 0,
            )} extra blocks.`,
            '- **Cheap and fast, but less safe: gpt-5.6-luna.**',
            `  ${formatSeconds(lunaMetrics.latencyP50Ms)} response and `
                + `${formatCostPerTask(
                    lunaMetrics.totalCostUsd,
                    lunaMetrics.sampleCount,
                )}/task, but ${String(
                    lunaMetrics.extraBlockCount ?? 0,
                )} extra blocks.`,
        );
    }
    lines.push(
        '',
        '## Active corpus references',
        '',
        '| Video | Language | Paid-promo reference |',
        '| --- | --- | --- |',
    );
    for (const item of preflight.manifest.items) {
        lines.push(
            `| ${item.videoId} | ${item.languageCode} | `
                + `${escapeMarkdown(
                    referenceText(
                        item.paidPromoBlocks ?? [],
                        item.referenceNote,
                    ),
                )} |`,
        );
    }
    lines.push(
        '',
        '## Commands',
        '',
        '```sh',
        'pnpm benchmark:promo -- --dry-run',
        'pnpm benchmark:promo -- --model glm-5.2',
        'pnpm benchmark:promo',
        'pnpm benchmark:promo -- --report-only',
        '```',
        '',
        'Inference requires `BENCHMARK_LLM_BASE_URL` and',
        '`BENCHMARK_LLM_API_KEY` in the process environment or ignored',
        '`extension/.env`. Samples never contain connection details, keys,',
        'routing metadata, request IDs, or reasoning text.',
        '',
        '> TODO: create a separate self-promotion corpus and prompt version.',
        '> Never merge it into the paid-sponsor leaderboard.',
        '',
    );
    return lines.join('\n');
}

/**
 * Builds the promo-detection benchmark README and writes it to its fixed path in the repository.
 *
 * @param repoRoot - Absolute path to the repository root.
 *
 * @returns Absolute path the README was written to.
 */
export function writeBenchmarkReadme(repoRoot: string): string {
    const readmePath = path.resolve(
        repoRoot,
        BENCHMARK_README_RELATIVE_PATH,
    );
    const text = buildBenchmarkReadme(repoRoot);
    writeFileSync(readmePath, text, 'utf8');
    return readmePath;
}
