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

const BENCHMARK_README_RELATIVE_PATH =
    'benchmarks/promo-detection/README.md';
const HISTORICAL_RUN_RELATIVE_PATH =
    'benchmarks/promo-detection/runs/codex-agent-v1-prompt-v4-max';
const HISTORICAL_MANIFEST_RELATIVE_PATH =
    'benchmarks/promo-detection/corpus/manifest-v1.json';
const MATCH_IOU_THRESHOLD = 0.5;

type ClosedBlock = {
    startSec: number;
    endSec: number;
};

type BlockMatch = {
    referenceIndex: number;
    predictionIndex: number;
    iou: number;
};

type MatchSelection = {
    matches: BlockMatch[];
    totalIou: number;
};

type ActiveMetrics = {
    sampleCount: number;
    validCount: number;
    matchedBlockCount?: number;
    referenceBlockCount?: number;
    extraBlockCount?: number;
    blockRecall?: number;
    blockPrecision?: number;
    blockF1?: number;
    referenceIou?: number;
    boundaryMaeSec?: number;
    classificationStableVideos: number;
    blockCountStableVideos: number;
    latencyP50Ms?: number;
    tokenSampleCount: number;
    totalTokens: number;
    totalCostUsd?: number;
};

type ActiveRow = {
    model: (typeof PROMO_BENCHMARK_MODELS)[number];
    metrics: ActiveMetrics;
    rank?: number;
};

type HistoricalSummary = {
    validCount: number;
    classificationStableVideos: number;
    blockCountStableVideos: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJson(filePath: string): unknown {
    try {
        return JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    } catch {
        throw new Error(`Benchmark artifact is malformed: ${filePath}.`);
    }
}

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
        value.runKey !== benchmarkRunKey('default') ||
        value.corpusId !== preflight.manifest.corpusId ||
        value.corpusManifestSha256 !== preflight.manifestSha256 ||
        value.harness !== DIRECT_API_HARNESS ||
        value.model !== model ||
        value.reasoning !== 'default' ||
        value.videoId !== videoId ||
        value.repeat !== repeat ||
        value.transcriptHash !== transcriptHash ||
        value.fixtureSha256 !== fixtureSha256 ||
        value.languageCode !== languageCode ||
        value.promptVersion !== preflight.promptVersion ||
        value.promptSha256 !== preflight.promptSha256 ||
        value.messageSha256 !== messageSha256 ||
        value.outputLimitPolicy !== BENCHMARK_OUTPUT_LIMIT_POLICY ||
        value.requestConfigSha256 !== preflight.requestConfigSha256
    ) {
        throw new Error('Active sample does not match the leaderboard group.');
    }
    return value;
}

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

function intervalIou(reference: ClosedBlock, prediction: ClosedBlock): number {
    const intersection = Math.max(
        0,
        Math.min(reference.endSec, prediction.endSec) -
            Math.max(reference.startSec, prediction.startSec),
    );
    const union =
        reference.endSec -
        reference.startSec +
        prediction.endSec -
        prediction.startSec -
        intersection;
    return union <= 0 ? 0 : intersection / union;
}

function betterSelection(
    left: MatchSelection,
    right: MatchSelection,
): MatchSelection {
    if (left.matches.length !== right.matches.length) {
        return left.matches.length > right.matches.length ? left : right;
    }
    return left.totalIou >= right.totalIou ? left : right;
}

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
            if (usedPredictions.has(predictionIndex)) {
                continue;
            }
            const iou = intervalIou(
                references[referenceIndex],
                predictions[predictionIndex],
            );
            if (iou < MATCH_IOU_THRESHOLD) {
                continue;
            }
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
        return best;
    };
    return visit(0, new Set()).matches;
}

function predictionBlocks(prediction: BenchmarkPrediction): ClosedBlock[] {
    if (!prediction.hasPromo) {
        return [];
    }
    return prediction.promoBlocks.flatMap((block) =>
        block.endSec === undefined
            ? []
            : [{ startSec: block.startSec, endSec: block.endSec }],
    );
}

function classF1(
    truePositive: number,
    falsePositive: number,
    falseNegative: number,
): number {
    const denominator =
        2 * truePositive + falsePositive + falseNegative;
    return denominator === 0 ? 1 : (2 * truePositive) / denominator;
}

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
            if (sample === undefined) {
                continue;
            }
            sampleCount += 1;
            videoSamples.push(sample);
            if (sample.costUsd !== undefined) {
                totalCostUsd += sample.costUsd;
                hasCost = true;
            }
            if (!sample.valid || sample.prediction === undefined) {
                continue;
            }
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
                boundaryErrorTotal +=
                    Math.abs(prediction.startSec - reference.startSec) +
                    Math.abs(prediction.endSec - reference.endSec);
                boundaryCount += 2;
            }
            latencies.push(sample.latencyMs);
            if (sample.usage !== undefined) {
                tokenSampleCount += 1;
                totalTokens += sample.usage.totalTokens;
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
                (prediction): prediction is BenchmarkPrediction =>
                    prediction !== undefined,
            );
        if (predictions.length !== BENCHMARK_REPEAT_COUNT) {
            continue;
        }
        if (
            new Set(predictions.map((prediction) => prediction.hasPromo)).size ===
            1
        ) {
            classificationStableVideos += 1;
        }
        const blockCounts = predictions.map((prediction) =>
            prediction.hasPromo ? prediction.promoBlocks.length : 0,
        );
        if (new Set(blockCounts).size === 1) {
            blockCountStableVideos += 1;
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
        metrics.blockRecall =
            blockTruePositive /
            (blockTruePositive + blockFalseNegative);
        metrics.blockPrecision =
            blockTruePositive /
            (blockTruePositive + blockFalsePositive);
        metrics.blockF1 = classF1(
            blockTruePositive,
            blockFalsePositive,
            blockFalseNegative,
        );
        metrics.referenceIou =
            referenceBlockCount === 0
                ? 0
                : referenceIouTotal / referenceBlockCount;
        metrics.boundaryMaeSec =
            boundaryCount === 0
                ? Number.POSITIVE_INFINITY
                : boundaryErrorTotal / boundaryCount;
        metrics.latencyP50Ms = median(latencies);
    }
    return metrics;
}

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

function rankRows(rows: ActiveRow[]): ActiveRow[] {
    const complete = rows.filter((row) => row.metrics.blockRecall !== undefined);
    complete.sort((left, right) => {
        const quality =
            (right.metrics.blockRecall ?? 0) -
                (left.metrics.blockRecall ?? 0) ||
            (right.metrics.blockF1 ?? 0) - (left.metrics.blockF1 ?? 0) ||
            (right.metrics.referenceIou ?? 0) -
                (left.metrics.referenceIou ?? 0) ||
            (left.metrics.boundaryMaeSec ?? Number.POSITIVE_INFINITY) -
                (right.metrics.boundaryMaeSec ?? Number.POSITIVE_INFINITY);
        if (quality !== 0) {
            return quality;
        }
        const stability =
            right.metrics.blockCountStableVideos -
            left.metrics.blockCountStableVideos;
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
    complete.forEach((row, index) => {
        row.rank = index + 1;
    });
    const incomplete = rows.filter(
        (row) => row.metrics.blockRecall === undefined,
    );
    return [...complete, ...incomplete];
}

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
            !isRecord(block) ||
            typeof block.startSec !== 'number' ||
            !Number.isFinite(block.startSec) ||
            (block.endSec !== undefined &&
                (typeof block.endSec !== 'number' ||
                    !Number.isFinite(block.endSec)))
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

function historicalSummary(
    repoRoot: string,
    promptSha256: string,
): HistoricalSummary {
    const runValue = parseJson(
        path.resolve(repoRoot, HISTORICAL_RUN_RELATIVE_PATH, 'run.json'),
    );
    if (
        !isRecord(runValue) ||
        runValue.schemaVersion !== 1 ||
        runValue.runId !== 'codex-agent-v1-prompt-v4-max' ||
        runValue.corpusId !== 'promo-paid-v1' ||
        runValue.harness !== 'Codex agent' ||
        runValue.model !== 'gpt-5.6-sol' ||
        runValue.reasoning !== 'max' ||
        runValue.promptVersion !== '4' ||
        runValue.promptSha256 !== promptSha256 ||
        runValue.repeatCount !== BENCHMARK_REPEAT_COUNT ||
        runValue.expectedSampleCount !== 30
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
        manifestValue.corpusId !== 'promo-paid-v1' ||
        manifestValue.itemCount !== 10 ||
        englishCount !== 5 ||
        russianCount !== 5
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
            new Set(predictions.map((prediction) => prediction.hasPromo)).size ===
            1
        ) {
            classificationStableVideos += 1;
        }
        const blockCounts = predictions.map((prediction) =>
            prediction.hasPromo ? prediction.promoBlocks.length : 0,
        );
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

function formatPercent(value: number | undefined): string {
    return value === undefined || !Number.isFinite(value)
        ? '—'
        : `${(value * 100).toFixed(1)}%`;
}

function formatSeconds(valueMs: number | undefined): string {
    return valueMs === undefined
        ? '—'
        : `${(valueMs / 1_000).toFixed(2)} s`;
}

function formatBoundaryError(value: number | undefined): string {
    return value === undefined || !Number.isFinite(value)
        ? '—'
        : `${value.toFixed(2)} s`;
}

function formatAverageTotalTokens(
    total: number,
    sampleCount: number,
): string {
    return sampleCount === 0
        ? '—'
        : Math.round(total / sampleCount).toLocaleString('en-US');
}

function formatCostPerTask(
    totalCost: number | undefined,
    sampleCount: number,
): string {
    return totalCost === undefined || sampleCount === 0
        ? '—'
        : `$${(totalCost / sampleCount).toFixed(4)}`;
}

function formatMatchedBlocks(
    matched: number | undefined,
    referenceCount: number | undefined,
): string {
    return matched === undefined || referenceCount === undefined
        ? '—'
        : `${String(matched)}/${String(referenceCount)}`;
}

function escapeMarkdown(value: string): string {
    return value.replaceAll('|', '\\|');
}

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
    const deepseekFlashMetrics = metricsForModel(
        rows,
        'deepseek-v4-flash',
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
        '| Quality rank | Model | Harness | Corpus | Reasoning | Valid runs | Found refs | Extra | Detection F1 | Time overlap | Boundary error | Repeat stability (promo / blocks) | Median response | Cost/task | Avg tokens/task |',
        '| ---: | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: |',
    ];
    for (const row of rows) {
        const metrics = row.metrics;
        lines.push(
            `| ${row.rank === undefined ? '—' : String(row.rank)} | ` +
                `${row.model.id} | ${DIRECT_API_HARNESS} | ` +
                `${preflight.manifest.corpusId} | default | ` +
                `${String(metrics.validCount)}/30 | ` +
                `${formatMatchedBlocks(
                    metrics.matchedBlockCount,
                    metrics.referenceBlockCount,
                )} | ${metrics.extraBlockCount === undefined
                    ? '—'
                    : String(metrics.extraBlockCount)} | ` +
                `${formatPercent(metrics.blockF1)} | ` +
                `${formatPercent(metrics.referenceIou)} | ` +
                `${formatBoundaryError(metrics.boundaryMaeSec)} | ` +
                `${String(metrics.classificationStableVideos)}/10 / ` +
                `${String(metrics.blockCountStableVideos)}/10 | ` +
                `${formatSeconds(metrics.latencyP50Ms)} | ` +
                `${formatCostPerTask(
                    metrics.totalCostUsd,
                    metrics.sampleCount,
                )} | ${formatAverageTotalTokens(
                    metrics.totalTokens,
                    metrics.tokenSampleCount,
                )} |`,
        );
    }
    lines.push(
        '| archive | gpt-5.6-sol | Codex agent | promo-paid-v1 | max | ' +
            `${String(historical.validCount)}/30 | — | — | — | — | — | ` +
            `${String(historical.classificationStableVideos)}/10 / ` +
            `${String(historical.blockCountStableVideos)}/10 | — | — | — |`,
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
            '- **Selected production default: deepseek-v4-flash.** ' +
                `${formatMatchedBlocks(
                    deepseekFlashMetrics.matchedBlockCount,
                    deepseekFlashMetrics.referenceBlockCount,
                )} references found,`,
            `  ${String(deepseekFlashMetrics.extraBlockCount ?? 0)} extra, ` +
                `${formatPercent(
                    deepseekFlashMetrics.referenceIou,
                )} time overlap, ` +
                `${formatSeconds(
                    deepseekFlashMetrics.latencyP50Ms,
                )} observed response, ` +
                `${formatCostPerTask(
                    deepseekFlashMetrics.totalCostUsd,
                    deepseekFlashMetrics.sampleCount,
                )}/task.`,
            `- **Highest paid-only detection quality: kimi-k3.** ${formatMatchedBlocks(
                kimiMetrics.matchedBlockCount,
                kimiMetrics.referenceBlockCount,
            )} references found,`,
            `  ${String(kimiMetrics.extraBlockCount ?? 0)} extra, ` +
                `${formatPercent(kimiMetrics.referenceIou)} time overlap, ` +
                `${formatSeconds(kimiMetrics.latencyP50Ms)} response, ` +
                `${formatCostPerTask(
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
            `  ${formatSeconds(lunaMetrics.latencyP50Ms)} response and ` +
                `${formatCostPerTask(
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
            `| ${item.videoId} | ${item.languageCode} | ` +
                `${escapeMarkdown(
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

export function writeBenchmarkReadme(repoRoot: string): string {
    const readmePath = path.resolve(
        repoRoot,
        BENCHMARK_README_RELATIVE_PATH,
    );
    const text = buildBenchmarkReadme(repoRoot);
    writeFileSync(readmePath, text, 'utf8');
    return readmePath;
}
