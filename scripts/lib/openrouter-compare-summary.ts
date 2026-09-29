/**
 * @file Ranks OpenRouter model comparison rows by alignment quality against human
 * reference labels and estimates request cost from public model pricing.
 */

import type { AlignedBlockMetric } from './promo-reference-compare';
import type { OpenRouterUsage } from '@/background/openrouter/openrouter-client';

/**
 * Public per-token/per-request pricing metadata for an OpenRouter model. Any field
 * is absent when OpenRouter does not report a rate for that dimension.
 */
export interface OpenRouterModelPricing {
    /**
     * USD cost per prompt token.
     */
    prompt?: number;

    /**
     * USD cost per completion token.
     */
    completion?: number;

    /**
     * Flat USD cost added per request, independent of token counts.
     */
    request?: number;

    /**
     * USD cost per web search invocation.
     */
    webSearch?: number;

    /**
     * USD cost per internal reasoning token.
     */
    internalReasoning?: number;

    /**
     * USD cost per cached prompt token read.
     */
    inputCacheRead?: number;

    /**
     * USD cost per prompt token written to cache.
     */
    inputCacheWrite?: number;
}

/**
 * Estimated USD cost of a single request, broken down by pricing dimension.
 */
export interface EstimatedCostBreakdown {
    /**
     * Cost of non-cached prompt tokens.
     */
    promptCostUsd: number;

    /**
     * Cost of completion tokens, excluding internal reasoning tokens when priced separately.
     */
    completionCostUsd: number;

    /**
     * Cost of prompt tokens served from cache.
     */
    cacheReadCostUsd: number;

    /**
     * Cost of prompt tokens written to cache.
     */
    cacheWriteCostUsd: number;

    /**
     * Cost of internal reasoning tokens, when priced separately from completion tokens.
     */
    internalReasoningCostUsd: number;

    /**
     * Flat per-request cost.
     */
    requestCostUsd: number;

    /**
     * Sum of all cost components above.
     */
    totalUsd: number;
}

/**
 * Aggregate alignment quality of a model's predictions against human reference labels.
 */
export interface CompareAlignmentSummary {
    /**
     * Count of predicted blocks matched against human blocks.
     */
    matchedBlocks: number;

    /**
     * Mean intersection-over-union across matched blocks.
     */
    meanIoU: number;

    /**
     * Mean absolute start-time delta (sec) across matched blocks.
     */
    meanAbsStartDeltaSec: number;

    /**
     * Mean absolute end-time delta (sec) across matched blocks.
     */
    meanAbsEndDeltaSec: number;

    /**
     * Largest absolute start-time delta (sec) among matched blocks.
     */
    maxAbsStartDeltaSec: number;

    /**
     * Largest absolute end-time delta (sec) among matched blocks.
     */
    maxAbsEndDeltaSec: number;
}

/**
 * Per-model comparison inputs consumed by {@link rankCompareSummaryRows}.
 */
export interface CompareSummaryRowInput {
    /**
     * Model identifier as reported by OpenRouter.
     */
    model: string;

    /**
     * Request latency in milliseconds.
     */
    ms: number;

    /**
     * Cost in USD reported directly by OpenRouter, when available.
     */
    reportedCost?: number;

    /**
     * Cost in USD estimated from public pricing metadata, used when `reportedCost` is absent.
     */
    estimatedCostUsd?: number;

    /**
     * Per-block alignment metrics against the human reference labels.
     */
    vsHuman: readonly AlignedBlockMetric[];
}

/**
 * Ranked comparison row combining a model's alignment summary with its cost and latency.
 */
export type CompareSummaryRow = CompareAlignmentSummary & {
    /**
     * Model identifier as reported by OpenRouter.
     */
    model: string;

    /**
     * Request latency in milliseconds.
     */
    ms: number;

    /**
     * Cost in USD reported directly by OpenRouter, when available.
     */
    reportedCost?: number;

    /**
     * Cost in USD estimated from public pricing metadata, used when `reportedCost` is absent.
     */
    estimatedCostUsd?: number;
};

/**
 * Coerces OpenRouter's pricing field into a usable rate, rejecting negative or non-numeric values.
 *
 * @param value - Numeric string or number from OpenRouter model metadata
 *
 * @returns Finite non-negative rate, otherwise `undefined`
 */
export function parsePricingNumber(value: unknown): number | undefined {
    let numeric: number;
    if (typeof value === 'number') {
        numeric = value;
    } else if (typeof value === 'string') {
        numeric = Number(value);
    } else {
        numeric = Number.NaN;
    }
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
 *
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
    const completionTokens = pricing.internalReasoning !== undefined
        ? Math.max(usage.completionTokens - reasoningTokens, 0)
        : usage.completionTokens;

    const promptCostUsd = promptTokens * (pricing.prompt ?? 0);
    const completionCostUsd = completionTokens * (pricing.completion ?? 0);
    const cacheReadCostUsd = cachedTokens * (pricing.inputCacheRead ?? 0);
    const cacheWriteCostUsd = cacheWriteTokens * (pricing.inputCacheWrite ?? 0);
    const internalReasoningCostUsd = reasoningTokens * (pricing.internalReasoning ?? 0);
    const requestCostUsd = pricing.request ?? 0;
    const totalUsd = promptCostUsd
        + completionCostUsd
        + cacheReadCostUsd
        + cacheWriteCostUsd
        + internalReasoningCostUsd
        + requestCostUsd;

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
 * Aggregates per-block alignment metrics into mean and max deltas for one model.
 *
 * @param metrics - Human-aligned interval metrics for one model
 *
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

/**
 * Ascending comparator for optional numbers, treating `undefined` as worst (sorts last).
 *
 * @param left - First value to compare
 * @param right - Second value to compare
 *
 * @returns Negative if `left` sorts first, positive if `right` sorts first, otherwise `0`
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
 * Picks the cost used for ranking, preferring OpenRouter's reported cost over the estimate.
 *
 * @param row - Ranked comparison row
 *
 * @returns Reported cost when present, otherwise the estimated cost, or `undefined` if neither exists
 */
function effectiveCost(row: CompareSummaryRow): number | undefined {
    return row.reportedCost ?? row.estimatedCostUsd;
}

/**
 * Sorts models by human alignment quality. Primary key is overlap quality,
 * then boundary precision, then lower cost and latency as tie-breakers.
 *
 * @param rows - Successful model rows with `vsHuman`
 *
 * @returns Ranked summaries, best first
 */
export function rankCompareSummaryRows(
    rows: readonly CompareSummaryRowInput[],
): CompareSummaryRow[] {
    const ranked: CompareSummaryRow[] = [];
    for (const row of rows) {
        const summary = summarizeVsHumanMetrics(row.vsHuman);
        if (summary !== undefined) {
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
