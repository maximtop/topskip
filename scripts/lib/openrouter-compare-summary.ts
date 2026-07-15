import type { OpenRouterUsage } from '@/background/openrouter/openrouter-client';

import type { AlignedBlockMetric } from './promo-reference-compare';

export type OpenRouterModelPricing = {
    prompt?: number;
    completion?: number;
    request?: number;
    webSearch?: number;
    internalReasoning?: number;
    inputCacheRead?: number;
    inputCacheWrite?: number;
};

export type EstimatedCostBreakdown = {
    promptCostUsd: number;
    completionCostUsd: number;
    cacheReadCostUsd: number;
    cacheWriteCostUsd: number;
    internalReasoningCostUsd: number;
    requestCostUsd: number;
    totalUsd: number;
};

export type CompareAlignmentSummary = {
    matchedBlocks: number;
    meanIoU: number;
    meanAbsStartDeltaSec: number;
    meanAbsEndDeltaSec: number;
    maxAbsStartDeltaSec: number;
    maxAbsEndDeltaSec: number;
};

export type CompareSummaryRowInput = {
    model: string;
    ms: number;
    reportedCost?: number;
    estimatedCostUsd?: number;
    vsHuman: readonly AlignedBlockMetric[];
};

export type CompareSummaryRow = CompareAlignmentSummary & {
    model: string;
    ms: number;
    reportedCost?: number;
    estimatedCostUsd?: number;
};

/**
 * @param value - Numeric string or number from OpenRouter model metadata
 * @returns Finite non-negative rate, otherwise `undefined`
 */
export function parsePricingNumber(value: unknown): number | undefined {
    const numeric =
        typeof value === 'number'
            ? value
            : typeof value === 'string'
              ? Number(value)
              : Number.NaN;
    if (!Number.isFinite(numeric) || numeric < 0) {
        return undefined;
    }
    return numeric;
}

/**
 * Approximates request cost from the public model pricing metadata. Prefer the
 * exact `usage.cost` returned by OpenRouter when available.
 *
 * @param usage - Usage block from the chat response
 * @param pricing - Public per-token model pricing metadata
 * @returns Breakdown in USD or `undefined` when no usable rates exist
 */
export function estimateCostFromUsageAndPricing(
    usage: OpenRouterUsage,
    pricing: OpenRouterModelPricing,
): EstimatedCostBreakdown | undefined {
    const cachedTokens = usage.promptTokensDetails?.cachedTokens ?? 0;
    const cacheWriteTokens = usage.promptTokensDetails?.cacheWriteTokens ?? 0;
    const reasoningTokens = usage.completionTokensDetails?.reasoningTokens ?? 0;

    const promptTokens = Math.max(
        usage.promptTokens - cachedTokens - cacheWriteTokens,
        0,
    );
    const completionTokens =
        pricing.internalReasoning !== undefined
            ? Math.max(usage.completionTokens - reasoningTokens, 0)
            : usage.completionTokens;

    const promptCostUsd = promptTokens * (pricing.prompt ?? 0);
    const completionCostUsd = completionTokens * (pricing.completion ?? 0);
    const cacheReadCostUsd = cachedTokens * (pricing.inputCacheRead ?? 0);
    const cacheWriteCostUsd = cacheWriteTokens * (pricing.inputCacheWrite ?? 0);
    const internalReasoningCostUsd =
        reasoningTokens * (pricing.internalReasoning ?? 0);
    const requestCostUsd = pricing.request ?? 0;
    const totalUsd =
        promptCostUsd +
        completionCostUsd +
        cacheReadCostUsd +
        cacheWriteCostUsd +
        internalReasoningCostUsd +
        requestCostUsd;

    if (totalUsd <= 0) {
        return undefined;
    }
    return {
        promptCostUsd,
        completionCostUsd,
        cacheReadCostUsd,
        cacheWriteCostUsd,
        internalReasoningCostUsd,
        requestCostUsd,
        totalUsd,
    };
}

/**
 * @param metrics - Human-aligned interval metrics for one model
 * @returns Aggregate alignment summary or `undefined` for empty input
 */
export function summarizeVsHumanMetrics(
    metrics: readonly AlignedBlockMetric[],
): CompareAlignmentSummary | undefined {
    if (metrics.length === 0) {
        return undefined;
    }
    let totalIoU = 0;
    let totalAbsStartDelta = 0;
    let totalAbsEndDelta = 0;
    let maxAbsStartDelta = 0;
    let maxAbsEndDelta = 0;

    for (const metric of metrics) {
        const absStartDelta = Math.abs(metric.startDeltaSec);
        const absEndDelta = Math.abs(metric.endDeltaSec);
        totalIoU += metric.iouWithHuman;
        totalAbsStartDelta += absStartDelta;
        totalAbsEndDelta += absEndDelta;
        maxAbsStartDelta = Math.max(maxAbsStartDelta, absStartDelta);
        maxAbsEndDelta = Math.max(maxAbsEndDelta, absEndDelta);
    }

    return {
        matchedBlocks: metrics.length,
        meanIoU: totalIoU / metrics.length,
        meanAbsStartDeltaSec: totalAbsStartDelta / metrics.length,
        meanAbsEndDeltaSec: totalAbsEndDelta / metrics.length,
        maxAbsStartDeltaSec: maxAbsStartDelta,
        maxAbsEndDeltaSec: maxAbsEndDelta,
    };
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

function effectiveCost(row: CompareSummaryRow): number | undefined {
    return row.reportedCost ?? row.estimatedCostUsd;
}

/**
 * Sorts models by human alignment quality. Primary key is overlap quality,
 * then boundary precision, then lower cost and latency as tie-breakers.
 *
 * @param rows - Successful model rows with `vsHuman`
 * @returns Ranked summaries, best first
 */
export function rankCompareSummaryRows(
    rows: readonly CompareSummaryRowInput[],
): CompareSummaryRow[] {
    const ranked: CompareSummaryRow[] = [];
    for (const row of rows) {
        const summary = summarizeVsHumanMetrics(row.vsHuman);
        if (summary === undefined) {
            continue;
        }
        const rankedRow: CompareSummaryRow = {
            model: row.model,
            ms: row.ms,
            ...summary,
        };
        if (row.reportedCost !== undefined) {
            rankedRow.reportedCost = row.reportedCost;
        }
        if (row.estimatedCostUsd !== undefined) {
            rankedRow.estimatedCostUsd = row.estimatedCostUsd;
        }
        ranked.push(rankedRow);
    }

    return ranked.sort((left, right) => {
        if (left.matchedBlocks !== right.matchedBlocks) {
            return right.matchedBlocks - left.matchedBlocks;
        }
        if (left.meanIoU !== right.meanIoU) {
            return right.meanIoU - left.meanIoU;
        }
        if (left.meanAbsStartDeltaSec !== right.meanAbsStartDeltaSec) {
            return left.meanAbsStartDeltaSec - right.meanAbsStartDeltaSec;
        }
        if (left.meanAbsEndDeltaSec !== right.meanAbsEndDeltaSec) {
            return left.meanAbsEndDeltaSec - right.meanAbsEndDeltaSec;
        }
        const costCmp = compareOptionalAscending(
            effectiveCost(left),
            effectiveCost(right),
        );
        if (costCmp !== 0) {
            return costCmp;
        }
        return left.ms - right.ms;
    });
}
