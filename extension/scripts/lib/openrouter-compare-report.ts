import {
    parseReferenceBundleJson,
    type AlignedBlockMetric,
    type ReferenceBundle,
} from './promo-reference-compare';

export type CompareBlock = {
    startSec: number;
    endSec?: number;
    confidence?: string;
};

export type CompareUsagePromptTokensDetails = {
    cachedTokens?: number;
    cacheWriteTokens?: number;
    audioTokens?: number;
    videoTokens?: number;
};

export type CompareUsageCompletionTokensDetails = {
    reasoningTokens?: number;
    audioTokens?: number;
    imageTokens?: number;
};

export type CompareUsageCostDetails = {
    upstreamInferenceCost?: number;
    upstreamInferencePromptCost?: number;
    upstreamInferenceCompletionsCost?: number;
};

export type CompareUsage = {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    promptTokensDetails?: CompareUsagePromptTokensDetails;
    completionTokensDetails?: CompareUsageCompletionTokensDetails;
    cost?: number;
    isByok?: boolean;
    costDetails?: CompareUsageCostDetails;
};

export type ComparePricing = {
    prompt?: number;
    completion?: number;
    request?: number;
    webSearch?: number;
    internalReasoning?: number;
    inputCacheRead?: number;
    inputCacheWrite?: number;
};

export type CompareCostAnalysis = {
    reportedCost?: number;
    estimatedCostUsd?: number;
    promptCostUsd?: number;
    completionCostUsd?: number;
    cacheReadCostUsd?: number;
    cacheWriteCostUsd?: number;
    internalReasoningCostUsd?: number;
    requestCostUsd?: number;
};

export type CompareSource = {
    fixture?: string;
    reference?: string | null;
    out?: string | null;
};

export type CompareRow = {
    model: string;
    responseModel?: string;
    ms: number;
    ok: boolean;
    error?: string;
    usage?: CompareUsage;
    pricing?: ComparePricing;
    costAnalysis?: CompareCostAnalysis;
    blocks?: CompareBlock[];
    vsHuman?: AlignedBlockMetric[];
    vsHumanNote?: string;
};

export type CompareReport = {
    generatedAt?: string;
    source?: CompareSource;
    presetCount: number;
    rows: CompareRow[];
    reference?: ReferenceBundle;
    firstRunVsHuman?: AlignedBlockMetric[];
    firstRunVsHumanNote?: string;
};

type MetricSummary = {
    matchedBlocks: number;
    avgIou?: number;
    avgAbsStartDelta?: number;
    avgAbsEndDelta?: number;
};

type CostKind = 'reported' | 'estimated' | 'none';

type CostInfo = {
    effectiveCost?: number;
    reportedCost?: number;
    estimatedCostUsd?: number;
    kind: CostKind;
};

type RankedRow = {
    row: CompareRow;
    summary: MetricSummary;
    cost: CostInfo;
};

type LaneRole = 'human' | 'baseline' | 'model';

type LaneSegment = {
    startSec: number;
    endSec: number;
    className: string;
};

type RenderLane = {
    role: LaneRole;
    model?: string;
    label: string;
    note: string;
    segments: LaneSegment[];
    confidence?: string;
    showHumanShadow?: boolean;
};

type HtmlOptions = {
    title?: string;
    sourceLabel?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function expectFiniteNumber(value: unknown, path: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${path} must be a finite number`);
    }
    return value;
}

function parseOptionalFiniteNumber(
    value: unknown,
    path: string,
): number | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    return expectFiniteNumber(value, path);
}

function parseOptionalString(value: unknown, path: string): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }
    if (typeof value !== 'string') {
        throw new Error(`${path} must be a string`);
    }
    return value;
}

function parseOptionalNullableString(
    value: unknown,
    path: string,
): string | null | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (value === null || typeof value === 'string') {
        return value;
    }
    throw new Error(`${path} must be a string or null`);
}

function parseUsagePromptTokensDetails(
    value: unknown,
    path: string,
): CompareUsagePromptTokensDetails | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const details: CompareUsagePromptTokensDetails = {
        cachedTokens: parseOptionalFiniteNumber(
            value.cachedTokens,
            `${path}.cachedTokens`,
        ),
        cacheWriteTokens: parseOptionalFiniteNumber(
            value.cacheWriteTokens,
            `${path}.cacheWriteTokens`,
        ),
        audioTokens: parseOptionalFiniteNumber(
            value.audioTokens,
            `${path}.audioTokens`,
        ),
        videoTokens: parseOptionalFiniteNumber(
            value.videoTokens,
            `${path}.videoTokens`,
        ),
    };
    return Object.values(details).some((item) => item !== undefined)
        ? details
        : undefined;
}

function parseUsageCompletionTokensDetails(
    value: unknown,
    path: string,
): CompareUsageCompletionTokensDetails | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const details: CompareUsageCompletionTokensDetails = {
        reasoningTokens: parseOptionalFiniteNumber(
            value.reasoningTokens,
            `${path}.reasoningTokens`,
        ),
        audioTokens: parseOptionalFiniteNumber(
            value.audioTokens,
            `${path}.audioTokens`,
        ),
        imageTokens: parseOptionalFiniteNumber(
            value.imageTokens,
            `${path}.imageTokens`,
        ),
    };
    return Object.values(details).some((item) => item !== undefined)
        ? details
        : undefined;
}

function parseUsageCostDetails(
    value: unknown,
    path: string,
): CompareUsageCostDetails | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const details: CompareUsageCostDetails = {
        upstreamInferenceCost: parseOptionalFiniteNumber(
            value.upstreamInferenceCost,
            `${path}.upstreamInferenceCost`,
        ),
        upstreamInferencePromptCost: parseOptionalFiniteNumber(
            value.upstreamInferencePromptCost,
            `${path}.upstreamInferencePromptCost`,
        ),
        upstreamInferenceCompletionsCost: parseOptionalFiniteNumber(
            value.upstreamInferenceCompletionsCost,
            `${path}.upstreamInferenceCompletionsCost`,
        ),
    };
    return Object.values(details).some((item) => item !== undefined)
        ? details
        : undefined;
}

function parseCompareUsage(
    value: unknown,
    path: string,
): CompareUsage | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const promptTokens = expectFiniteNumber(
        value.promptTokens,
        `${path}.promptTokens`,
    );
    const completionTokens = expectFiniteNumber(
        value.completionTokens,
        `${path}.completionTokens`,
    );
    const totalTokens = expectFiniteNumber(
        value.totalTokens,
        `${path}.totalTokens`,
    );
    const isByok = value.isByok;
    if (isByok !== undefined && typeof isByok !== 'boolean') {
        throw new Error(`${path}.isByok must be a boolean`);
    }
    return {
        promptTokens,
        completionTokens,
        totalTokens,
        promptTokensDetails: parseUsagePromptTokensDetails(
            value.promptTokensDetails,
            `${path}.promptTokensDetails`,
        ),
        completionTokensDetails: parseUsageCompletionTokensDetails(
            value.completionTokensDetails,
            `${path}.completionTokensDetails`,
        ),
        cost: parseOptionalFiniteNumber(value.cost, `${path}.cost`),
        isByok,
        costDetails: parseUsageCostDetails(
            value.costDetails,
            `${path}.costDetails`,
        ),
    };
}

function parseComparePricing(
    value: unknown,
    path: string,
): ComparePricing | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const pricing: ComparePricing = {
        prompt: parseOptionalFiniteNumber(value.prompt, `${path}.prompt`),
        completion: parseOptionalFiniteNumber(
            value.completion,
            `${path}.completion`,
        ),
        request: parseOptionalFiniteNumber(value.request, `${path}.request`),
        webSearch: parseOptionalFiniteNumber(
            value.webSearch,
            `${path}.webSearch`,
        ),
        internalReasoning: parseOptionalFiniteNumber(
            value.internalReasoning,
            `${path}.internalReasoning`,
        ),
        inputCacheRead: parseOptionalFiniteNumber(
            value.inputCacheRead,
            `${path}.inputCacheRead`,
        ),
        inputCacheWrite: parseOptionalFiniteNumber(
            value.inputCacheWrite,
            `${path}.inputCacheWrite`,
        ),
    };
    return Object.values(pricing).some((item) => item !== undefined)
        ? pricing
        : undefined;
}

function parseCompareCostAnalysis(
    value: unknown,
    path: string,
): CompareCostAnalysis | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const analysis: CompareCostAnalysis = {
        reportedCost: parseOptionalFiniteNumber(
            value.reportedCost,
            `${path}.reportedCost`,
        ),
        estimatedCostUsd: parseOptionalFiniteNumber(
            value.estimatedCostUsd,
            `${path}.estimatedCostUsd`,
        ),
        promptCostUsd: parseOptionalFiniteNumber(
            value.promptCostUsd,
            `${path}.promptCostUsd`,
        ),
        completionCostUsd: parseOptionalFiniteNumber(
            value.completionCostUsd,
            `${path}.completionCostUsd`,
        ),
        cacheReadCostUsd: parseOptionalFiniteNumber(
            value.cacheReadCostUsd,
            `${path}.cacheReadCostUsd`,
        ),
        cacheWriteCostUsd: parseOptionalFiniteNumber(
            value.cacheWriteCostUsd,
            `${path}.cacheWriteCostUsd`,
        ),
        internalReasoningCostUsd: parseOptionalFiniteNumber(
            value.internalReasoningCostUsd,
            `${path}.internalReasoningCostUsd`,
        ),
        requestCostUsd: parseOptionalFiniteNumber(
            value.requestCostUsd,
            `${path}.requestCostUsd`,
        ),
    };
    return Object.values(analysis).some((item) => item !== undefined)
        ? analysis
        : undefined;
}

function parseCompareSource(
    value: unknown,
    path: string,
): CompareSource | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const source: CompareSource = {
        fixture: parseOptionalString(value.fixture, `${path}.fixture`),
        reference: parseOptionalNullableString(
            value.reference,
            `${path}.reference`,
        ),
        out: parseOptionalNullableString(value.out, `${path}.out`),
    };
    return Object.values(source).some((item) => item !== undefined)
        ? source
        : undefined;
}

function parseCompareBlock(value: unknown, path: string): CompareBlock {
    if (!isRecord(value)) {
        throw new Error(`${path} must be an object`);
    }
    const startSec = value.startSec;
    const endSec = value.endSec;
    const confidence = value.confidence;
    if (typeof startSec !== 'number' || !Number.isFinite(startSec)) {
        throw new Error(`${path}.startSec must be a finite number`);
    }
    if (endSec !== undefined) {
        const invalidEnd =
            typeof endSec !== 'number' ||
            !Number.isFinite(endSec) ||
            endSec <= startSec;
        if (invalidEnd) {
            throw new Error(`${path}.endSec is invalid`);
        }
    }
    if (confidence !== undefined && typeof confidence !== 'string') {
        throw new Error(`${path}.confidence must be a string`);
    }
    return { startSec, endSec, confidence };
}

function parseAlignedMetric(value: unknown, path: string): AlignedBlockMetric {
    if (!isRecord(value)) {
        throw new Error(`${path} must be an object`);
    }
    const id = value.id;
    const humanStartSec = value.humanStartSec;
    const humanEndSec = value.humanEndSec;
    const predStartSec = value.predStartSec;
    const predEndSec = value.predEndSec;
    const predEndAssumed = value.predEndAssumed;
    const startDeltaSec = value.startDeltaSec;
    const endDeltaSec = value.endDeltaSec;
    const iouWithHuman = value.iouWithHuman;
    if (typeof id !== 'string' || id.length === 0) {
        throw new Error(`${path}.id must be a non-empty string`);
    }
    if (typeof predEndAssumed !== 'boolean') {
        throw new Error(`${path}.predEndAssumed must be a boolean`);
    }
    return {
        id,
        humanStartSec: expectFiniteNumber(
            humanStartSec,
            `${path}.humanStartSec`,
        ),
        humanEndSec: expectFiniteNumber(humanEndSec, `${path}.humanEndSec`),
        predStartSec: expectFiniteNumber(predStartSec, `${path}.predStartSec`),
        predEndSec: expectFiniteNumber(predEndSec, `${path}.predEndSec`),
        predEndAssumed,
        startDeltaSec: expectFiniteNumber(
            startDeltaSec,
            `${path}.startDeltaSec`,
        ),
        endDeltaSec: expectFiniteNumber(endDeltaSec, `${path}.endDeltaSec`),
        iouWithHuman: expectFiniteNumber(iouWithHuman, `${path}.iouWithHuman`),
    };
}

function parseCompareRow(value: unknown, index: number): CompareRow {
    if (!isRecord(value)) {
        throw new Error(`rows[${String(index)}] must be an object`);
    }
    const model = value.model;
    const responseModel = value.responseModel;
    const ms = value.ms;
    const ok = value.ok;
    const error = value.error;
    const vsHumanNote = value.vsHumanNote;
    if (typeof model !== 'string' || model.length === 0) {
        throw new Error(`rows[${String(index)}].model must be a string`);
    }
    if (responseModel !== undefined && typeof responseModel !== 'string') {
        throw new Error(
            `rows[${String(index)}].responseModel must be a string`,
        );
    }
    if (typeof ms !== 'number' || !Number.isFinite(ms)) {
        throw new Error(`rows[${String(index)}].ms must be a finite number`);
    }
    if (typeof ok !== 'boolean') {
        throw new Error(`rows[${String(index)}].ok must be a boolean`);
    }
    if (error !== undefined && typeof error !== 'string') {
        throw new Error(`rows[${String(index)}].error must be a string`);
    }
    if (vsHumanNote !== undefined && typeof vsHumanNote !== 'string') {
        throw new Error(`rows[${String(index)}].vsHumanNote must be a string`);
    }
    return {
        model,
        responseModel,
        ms,
        ok,
        error,
        usage: parseCompareUsage(value.usage, `rows[${String(index)}].usage`),
        pricing: parseComparePricing(
            value.pricing,
            `rows[${String(index)}].pricing`,
        ),
        costAnalysis: parseCompareCostAnalysis(
            value.costAnalysis,
            `rows[${String(index)}].costAnalysis`,
        ),
        blocks: Array.isArray(value.blocks)
            ? value.blocks.map((item, blockIndex) =>
                  parseCompareBlock(
                      item,
                      `rows[${String(index)}].blocks[${String(blockIndex)}]`,
                  ),
              )
            : undefined,
        vsHuman: Array.isArray(value.vsHuman)
            ? value.vsHuman.map((item, metricIndex) =>
                  parseAlignedMetric(
                      item,
                      `rows[${String(index)}].vsHuman[${String(metricIndex)}]`,
                  ),
              )
            : undefined,
        vsHumanNote,
    };
}

function readBalancedJsonObject(
    rawText: string,
    startIndex: number,
): string | undefined {
    let depth = 0;
    let inString = false;
    let isEscaped = false;
    for (let i = startIndex; i < rawText.length; i += 1) {
        const ch = rawText[i];
        if (inString) {
            if (isEscaped) {
                isEscaped = false;
            } else if (ch === '\\') {
                isEscaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }
        if (ch === '"') {
            inString = true;
            continue;
        }
        if (ch === '{') {
            depth += 1;
            continue;
        }
        if (ch === '}') {
            depth -= 1;
            if (depth === 0) {
                return rawText.slice(startIndex, i + 1);
            }
        }
    }
    return undefined;
}

export function extractJsonObjectFromMixedLog(rawText: string): string {
    let index = rawText.indexOf('{');
    while (index !== -1) {
        const candidate = readBalancedJsonObject(rawText, index);
        if (candidate !== undefined) {
            try {
                const parsed = JSON.parse(candidate) as unknown;
                if (
                    isRecord(parsed) &&
                    typeof parsed.presetCount === 'number' &&
                    Array.isArray(parsed.rows)
                ) {
                    return candidate;
                }
            } catch {
                // Keep scanning until the actual JSON payload is found.
            }
        }
        index = rawText.indexOf('{', index + 1);
    }
    throw new Error('Could not find a valid compare-presets JSON object');
}

export function parseOpenRouterComparePresetsLog(
    rawText: string,
): CompareReport {
    const jsonText = extractJsonObjectFromMixedLog(rawText);
    const parsed = JSON.parse(jsonText) as unknown;
    if (!isRecord(parsed)) {
        throw new Error('Compare report root must be an object');
    }
    const generatedAt = parsed.generatedAt;
    if (generatedAt !== undefined && typeof generatedAt !== 'string') {
        throw new Error('generatedAt must be a string');
    }
    const presetCount = parsed.presetCount;
    if (typeof presetCount !== 'number' || !Number.isFinite(presetCount)) {
        throw new Error('presetCount must be a finite number');
    }
    if (!Array.isArray(parsed.rows)) {
        throw new Error('rows must be an array');
    }
    const firstRunVsHumanNote = parsed.firstRunVsHumanNote;
    if (
        firstRunVsHumanNote !== undefined &&
        typeof firstRunVsHumanNote !== 'string'
    ) {
        throw new Error('firstRunVsHumanNote must be a string');
    }
    return {
        generatedAt,
        source: parseCompareSource(parsed.source, 'source'),
        presetCount,
        rows: parsed.rows.map((item, index) => parseCompareRow(item, index)),
        reference:
            parsed.reference === undefined
                ? undefined
                : parseReferenceBundleJson(JSON.stringify(parsed.reference)),
        firstRunVsHuman: Array.isArray(parsed.firstRunVsHuman)
            ? parsed.firstRunVsHuman.map((item, index) =>
                  parseAlignedMetric(item, `firstRunVsHuman[${String(index)}]`),
              )
            : undefined,
        firstRunVsHumanNote,
    };
}

function average(values: readonly number[]): number | undefined {
    if (values.length === 0) {
        return undefined;
    }
    const total = values.reduce((sum, value) => sum + value, 0);
    return total / values.length;
}

function summarizeMetrics(
    metrics: readonly AlignedBlockMetric[] | undefined,
): MetricSummary {
    if (metrics === undefined || metrics.length === 0) {
        return { matchedBlocks: 0 };
    }
    return {
        matchedBlocks: metrics.length,
        avgIou: average(metrics.map((metric) => metric.iouWithHuman)),
        avgAbsStartDelta: average(
            metrics.map((metric) => Math.abs(metric.startDeltaSec)),
        ),
        avgAbsEndDelta: average(
            metrics.map((metric) => Math.abs(metric.endDeltaSec)),
        ),
    };
}

function compareOptionalDesc(a?: number, b?: number): number {
    if (a === undefined && b === undefined) {
        return 0;
    }
    if (a === undefined) {
        return 1;
    }
    if (b === undefined) {
        return -1;
    }
    return b - a;
}

function compareOptionalAsc(a?: number, b?: number): number {
    if (a === undefined && b === undefined) {
        return 0;
    }
    if (a === undefined) {
        return 1;
    }
    if (b === undefined) {
        return -1;
    }
    return a - b;
}

function buildCostInfo(row: CompareRow): CostInfo {
    const reportedCost = row.usage?.cost ?? row.costAnalysis?.reportedCost;
    const estimatedCostUsd = row.costAnalysis?.estimatedCostUsd;
    if (reportedCost !== undefined) {
        return {
            effectiveCost: reportedCost,
            reportedCost,
            estimatedCostUsd,
            kind: 'reported',
        };
    }
    if (estimatedCostUsd !== undefined) {
        return {
            effectiveCost: estimatedCostUsd,
            estimatedCostUsd,
            kind: 'estimated',
        };
    }
    return { kind: 'none' };
}

function buildRankedRows(rows: readonly CompareRow[]): RankedRow[] {
    return rows
        .map((row) => ({
            row,
            summary: summarizeMetrics(row.vsHuman),
            cost: buildCostInfo(row),
        }))
        .sort((left, right) => {
            const bySuccess = Number(right.row.ok) - Number(left.row.ok);
            if (bySuccess !== 0) {
                return bySuccess;
            }
            const byIou = compareOptionalDesc(
                left.summary.avgIou,
                right.summary.avgIou,
            );
            if (byIou !== 0) {
                return byIou;
            }
            const byStart = compareOptionalAsc(
                left.summary.avgAbsStartDelta,
                right.summary.avgAbsStartDelta,
            );
            if (byStart !== 0) {
                return byStart;
            }
            const byCost = compareOptionalAsc(
                left.cost.effectiveCost,
                right.cost.effectiveCost,
            );
            if (byCost !== 0) {
                return byCost;
            }
            const byLatency = left.row.ms - right.row.ms;
            if (byLatency !== 0) {
                return byLatency;
            }
            return left.row.model.localeCompare(right.row.model);
        });
}

function escapeHtml(text: string): string {
    return text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
}

function formatNumber(value: number, digits: number): string {
    const fixed = value.toFixed(digits);
    return fixed.replace(/(?:\.0+|(?:(\.\d*?)0+))$/, '$1');
}

function formatUsd(value: number): string {
    const digits = value >= 1 ? 2 : value >= 0.1 ? 3 : value >= 0.01 ? 4 : 5;
    return `$${formatNumber(value, digits)}`;
}

function formatCompactInteger(value: number): string {
    if (value >= 1000) {
        return `${formatNumber(value / 1000, 1)}k`;
    }
    return String(Math.round(value));
}

function formatPercent(value: number): string {
    return `${formatNumber(value * 100, 1)}%`;
}

function formatSeconds(value: number): string {
    return `${formatNumber(value, 2)}s`;
}

function formatDelta(value: number): string {
    if (value === 0) {
        return '0s';
    }
    const sign = value > 0 ? '+' : '-';
    return `${sign}${formatNumber(Math.abs(value), 2)}s`;
}

function formatClock(seconds: number): string {
    const sign = seconds < 0 ? '-' : '';
    const abs = Math.abs(seconds);
    const hours = Math.floor(abs / 3600);
    const minutes = Math.floor((abs % 3600) / 60);
    const secs = formatNumber(abs % 60, 1).padStart(4, '0');
    if (hours > 0) {
        return [
            sign,
            String(hours),
            ':',
            String(minutes).padStart(2, '0'),
            ':',
            secs,
        ].join('');
    }
    return `${sign}${String(minutes).padStart(2, '0')}:${secs}`;
}

function formatMs(ms: number): string {
    if (ms < 1000) {
        return `${String(Math.round(ms))} ms`;
    }
    return `${formatNumber(ms / 1000, 2)} s`;
}

function formatGeneratedAt(value: string): string {
    const match = value.match(
        /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?Z$/,
    );
    if (match === null) {
        return value;
    }
    return `${match[1]} ${match[2]} UTC`;
}

function joinDefined(parts: Array<string | undefined>): string {
    return parts
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join(' | ');
}

function buildUsageMainLabel(usage: CompareUsage | undefined): string {
    if (usage === undefined) {
        return 'n/a';
    }
    return (
        `${formatCompactInteger(usage.promptTokens)}/` +
        `${formatCompactInteger(usage.completionTokens)}`
    );
}

function buildUsageNote(usage: CompareUsage | undefined): string {
    if (usage === undefined) {
        return 'No token usage in this log';
    }
    const reasoningTokens = usage.completionTokensDetails?.reasoningTokens;
    return joinDefined([
        `${formatCompactInteger(usage.totalTokens)} total`,
        reasoningTokens !== undefined && reasoningTokens > 0
            ? `${formatCompactInteger(reasoningTokens)} reasoning`
            : undefined,
        usage.isByok === true ? 'BYOK' : undefined,
    ]);
}

function buildModelNote(item: RankedRow): string {
    const responseLabel =
        item.row.responseModel !== undefined &&
        item.row.responseModel !== item.row.model
            ? `response ${item.row.responseModel}`
            : undefined;
    const confidenceLabel =
        item.row.blocks
            ?.map((block) => block.confidence)
            .filter((value): value is string => value !== undefined)
            .join(', ') || undefined;
    return joinDefined([
        responseLabel,
        item.row.error,
        item.row.vsHumanNote,
        item.row.error === undefined && item.row.vsHumanNote === undefined
            ? confidenceLabel
            : undefined,
    ]);
}

function buildCostDisplay(item: RankedRow): string {
    return item.cost.effectiveCost === undefined
        ? 'n/a'
        : formatUsd(item.cost.effectiveCost);
}

function buildCostNote(item: RankedRow): string {
    if (item.cost.kind === 'none') {
        return 'Unavailable in this log';
    }
    return joinDefined([
        item.cost.kind,
        item.cost.kind === 'reported' &&
        item.cost.estimatedCostUsd !== undefined &&
        item.cost.estimatedCostUsd !== item.cost.reportedCost
            ? `est ${formatUsd(item.cost.estimatedCostUsd)}`
            : undefined,
    ]);
}

function buildCostCoverageLabel(rankedRows: readonly RankedRow[]): string {
    const withCost = rankedRows.filter(
        (item) => item.cost.effectiveCost !== undefined,
    ).length;
    return `${String(withCost)}/${String(rankedRows.length)} with cost`;
}

function buildRowSearchText(item: RankedRow): string {
    return [
        item.row.model,
        item.row.responseModel,
        item.row.error,
        item.row.vsHumanNote,
    ]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join(' ')
        .toLowerCase();
}

function buildTimelineNote(item: RankedRow): string {
    return joinDefined([
        item.summary.avgIou !== undefined
            ? `avg IoU ${formatPercent(item.summary.avgIou)}`
            : undefined,
        item.cost.effectiveCost !== undefined
            ? buildCostDisplay(item)
            : undefined,
        formatMs(item.row.ms),
    ]);
}

function buildFocusMetricNote(
    metric: AlignedBlockMetric | undefined,
    item: RankedRow,
): string {
    if (metric === undefined) {
        return item.row.vsHumanNote ?? 'No aligned metric';
    }
    return joinDefined([
        `IoU ${formatPercent(metric.iouWithHuman)}`,
        `start ${formatDelta(metric.startDeltaSec)}`,
        `end ${formatDelta(metric.endDeltaSec)}`,
        item.cost.effectiveCost !== undefined
            ? buildCostDisplay(item)
            : undefined,
    ]);
}

function metricClass(iou?: number): string {
    if (iou === undefined) {
        return 'metric-neutral';
    }
    if (iou >= 0.95) {
        return 'metric-excellent';
    }
    if (iou >= 0.85) {
        return 'metric-good';
    }
    if (iou >= 0.7) {
        return 'metric-fair';
    }
    return 'metric-weak';
}

function rangeEnd(startSec: number, endSec?: number): number {
    if (endSec !== undefined && endSec > startSec) {
        return endSec;
    }
    return startSec + 0.2;
}

function ratioWithin(
    value: number,
    domainStart: number,
    domainEnd: number,
): number {
    const width = domainEnd - domainStart;
    if (width <= 0) {
        return 0;
    }
    const ratio = ((value - domainStart) / width) * 100;
    return Math.max(0, Math.min(100, ratio));
}

function styleForRange(
    startSec: number,
    endSec: number,
    domainStart: number,
    domainEnd: number,
): string {
    const left = ratioWithin(startSec, domainStart, domainEnd);
    const right = ratioWithin(endSec, domainStart, domainEnd);
    const width = Math.max(0.8, right - left);
    return `left:${formatNumber(left, 3)}%;width:${formatNumber(width, 3)}%;`;
}

function renderStatCard(eyebrow: string, value: string, note: string): string {
    return [
        '<article class="stat-card">',
        `<div class="eyebrow">${escapeHtml(eyebrow)}</div>`,
        `<div class="stat-value">${escapeHtml(value)}</div>`,
        `<div class="stat-note">${escapeHtml(note)}</div>`,
        '</article>',
    ].join('\n');
}

function renderHighlights(
    report: CompareReport,
    rankedRows: readonly RankedRow[],
): string {
    const scoredRows = rankedRows.filter(
        (item) => item.row.ok && item.summary.avgIou !== undefined,
    );
    const bestOverlap = scoredRows[0];
    const fastest = [...rankedRows]
        .filter((item) => item.row.ok)
        .sort((left, right) => left.row.ms - right.row.ms)[0];
    const cheapest = [...rankedRows]
        .filter((item) => item.row.ok && item.cost.effectiveCost !== undefined)
        .sort((left, right) => {
            const byCost = compareOptionalAsc(
                left.cost.effectiveCost,
                right.cost.effectiveCost,
            );
            if (byCost !== 0) {
                return byCost;
            }
            const byIou = compareOptionalDesc(
                left.summary.avgIou,
                right.summary.avgIou,
            );
            if (byIou !== 0) {
                return byIou;
            }
            return left.row.ms - right.row.ms;
        })[0];
    const tightestStart = [...scoredRows].sort((left, right) => {
        const byStart = compareOptionalAsc(
            left.summary.avgAbsStartDelta,
            right.summary.avgAbsStartDelta,
        );
        if (byStart !== 0) {
            return byStart;
        }
        return left.row.ms - right.row.ms;
    })[0];
    const baselineSummary = summarizeMetrics(report.firstRunVsHuman);

    return [
        bestOverlap === undefined
            ? renderStatCard(
                  'Best overlap',
                  'n/a',
                  'No human reference metrics',
              )
            : renderStatCard(
                  'Best overlap',
                  bestOverlap.row.model,
                  joinDefined([
                      `avg IoU ${formatPercent(bestOverlap.summary.avgIou ?? 0)}`,
                      bestOverlap.cost.effectiveCost !== undefined
                          ? buildCostDisplay(bestOverlap)
                          : undefined,
                      `latency ${formatMs(bestOverlap.row.ms)}`,
                  ]),
              ),
        fastest === undefined
            ? renderStatCard(
                  'Fastest response',
                  'n/a',
                  'No successful model call',
              )
            : renderStatCard(
                  'Fastest response',
                  fastest.row.model,
                  joinDefined([
                      `completed in ${formatMs(fastest.row.ms)}`,
                      fastest.cost.effectiveCost !== undefined
                          ? buildCostDisplay(fastest)
                          : 'cost n/a',
                  ]),
              ),
        cheapest === undefined
            ? renderStatCard(
                  'Cheapest response',
                  'n/a',
                  'No cost data in this log',
              )
            : renderStatCard(
                  'Cheapest response',
                  cheapest.row.model,
                  joinDefined([
                      buildCostDisplay(cheapest),
                      cheapest.cost.kind,
                      `latency ${formatMs(cheapest.row.ms)}`,
                  ]),
              ),
        tightestStart === undefined
            ? renderStatCard(
                  'Smallest start drift',
                  'n/a',
                  'No human reference',
              )
            : renderStatCard(
                  'Smallest start drift',
                  tightestStart.row.model,
                  `avg |start delta| ${formatSeconds(
                      tightestStart.summary.avgAbsStartDelta ?? 0,
                  )}`,
              ),
        baselineSummary.avgIou === undefined ||
        report.reference?.firstRunModel === undefined
            ? renderStatCard(
                  'Original first run',
                  'not included',
                  'Reference bundle has no baseline comparison',
              )
            : renderStatCard(
                  'Original first run',
                  report.reference.firstRunModel.model,
                  joinDefined([
                      `avg IoU ${formatPercent(baselineSummary.avgIou)}`,
                      `avg |start delta| ${formatSeconds(
                          baselineSummary.avgAbsStartDelta ?? 0,
                      )}`,
                  ]),
              ),
    ].join('\n');
}

function renderControls(rankedRows: readonly RankedRow[]): string {
    const successfulCount = rankedRows.filter((item) => item.row.ok).length;
    return [
        '<section class="panel controls-panel">',
        '<div class="panel-head">',
        '<h2>Controls</h2>',
        '<p>Sort, search, and filter the table and timelines.</p>',
        '</div>',
        '<div class="controls-grid">',
        '<label class="control-field">',
        '<span>Search models</span>',
        '<input id="report-search" type="search" ',
        'placeholder="gpt-5, gemini, claude">',
        '</label>',
        '<label class="control-field">',
        '<span>Sort by</span>',
        '<select id="report-sort">',
        '<option value="alignment">Alignment rank</option>',
        '<option value="cost">Lowest cost</option>',
        '<option value="latency">Fastest response</option>',
        '<option value="iou">Highest IoU</option>',
        '<option value="start-delta">Smallest start drift</option>',
        '<option value="end-delta">Smallest end drift</option>',
        '<option value="model">Model name</option>',
        '</select>',
        '</label>',
        '<label class="control-toggle">',
        '<input id="report-successful-only" type="checkbox">',
        '<span>Successful only</span>',
        '</label>',
        '<label class="control-toggle">',
        '<input id="report-cost-only" type="checkbox">',
        '<span>Cost data only</span>',
        '</label>',
        '<button id="report-reset" class="ghost-button" type="button">',
        'Reset',
        '</button>',
        '<div id="report-results" class="controls-meta">',
        `${String(rankedRows.length)} models | ` +
            `${String(successfulCount)} successful | ` +
            `${escapeHtml(buildCostCoverageLabel(rankedRows))}`,
        '</div>',
        '</div>',
        '</section>',
    ].join('\n');
}

function renderLeaderboard(rankedRows: readonly RankedRow[]): string {
    const rows = rankedRows
        .map((item, index) => {
            const blockCount = item.row.blocks?.length ?? 0;
            const metricTone = metricClass(item.summary.avgIou);
            const iouLabel =
                item.summary.avgIou === undefined
                    ? 'n/a'
                    : formatPercent(item.summary.avgIou);
            const startLabel =
                item.summary.avgAbsStartDelta === undefined
                    ? 'n/a'
                    : formatSeconds(item.summary.avgAbsStartDelta);
            const endLabel =
                item.summary.avgAbsEndDelta === undefined
                    ? 'n/a'
                    : formatSeconds(item.summary.avgAbsEndDelta);
            return [
                '<tr class="leaderboard-row"',
                ` data-model="${escapeHtml(item.row.model)}"`,
                ` data-search-text="${escapeHtml(buildRowSearchText(item))}"`,
                ` data-ok="${String(item.row.ok)}"`,
                ` data-has-cost="${String(item.cost.effectiveCost !== undefined)}"`,
                ` data-default-rank="${String(index + 1)}"`,
                ` data-latency-ms="${String(item.row.ms)}"`,
                ` data-avg-iou="${String(item.summary.avgIou ?? '')}"`,
                ` data-avg-start-delta="${String(
                    item.summary.avgAbsStartDelta ?? '',
                )}"`,
                ` data-avg-end-delta="${String(item.summary.avgAbsEndDelta ?? '')}"`,
                ` data-effective-cost="${String(item.cost.effectiveCost ?? '')}">`,
                `<td data-rank>${String(index + 1)}</td>`,
                [
                    '<td>',
                    `<div class="model-name">${escapeHtml(item.row.model)}</div>`,
                    `<div class="subtle">${escapeHtml(buildModelNote(item))}</div>`,
                    '</td>',
                ].join(''),
                `<td>${escapeHtml(formatMs(item.row.ms))}</td>`,
                [
                    '<td>',
                    `<div class="cell-main">${escapeHtml(buildCostDisplay(item))}</div>`,
                    `<div class="subtle">${escapeHtml(buildCostNote(item))}</div>`,
                    '</td>',
                ].join(''),
                `<td><span class="score ${metricTone}">${escapeHtml(iouLabel)}` +
                    '</span></td>',
                `<td>${escapeHtml(startLabel)}</td>`,
                `<td>${escapeHtml(endLabel)}</td>`,
                [
                    '<td>',
                    `<div class="cell-main">${escapeHtml(
                        buildUsageMainLabel(item.row.usage),
                    )}</div>`,
                    `<div class="subtle">${escapeHtml(
                        buildUsageNote(item.row.usage),
                    )}</div>`,
                    '</td>',
                ].join(''),
                `<td>${String(blockCount)}</td>`,
                '</tr>',
            ].join('\n');
        })
        .join('\n');

    return [
        '<section class="panel">',
        '<div class="panel-head">',
        '<h2>Leaderboard</h2>',
        '<p>Interactive sort/filter controls update this table and the lanes.</p>',
        '</div>',
        '<div class="table-wrap">',
        '<table>',
        '<thead>',
        '<tr>',
        '<th>#</th>',
        '<th>Model</th>',
        '<th>Latency</th>',
        '<th>Cost</th>',
        '<th>Avg IoU</th>',
        '<th>Avg |start delta|</th>',
        '<th>Avg |end delta|</th>',
        '<th>Tokens</th>',
        '<th>Blocks</th>',
        '</tr>',
        '</thead>',
        `<tbody id="leaderboard-body">${rows}</tbody>`,
        '</table>',
        '</div>',
        '<p id="leaderboard-empty" class="empty-state" hidden>',
        'No models match the current filters.',
        '</p>',
        '</section>',
    ].join('\n');
}

function renderLane(
    lane: RenderLane,
    domainStart: number,
    domainEnd: number,
    variant: 'timeline' | 'focus',
    humanStyle?: string,
): string {
    const laneClass = variant === 'timeline' ? 'timeline-lane' : 'focus-lane';
    const trackClass =
        variant === 'timeline'
            ? 'timeline-track'
            : 'timeline-track timeline-track-focus';
    const modelAttr =
        lane.model === undefined
            ? ''
            : ` data-model="${escapeHtml(lane.model)}"`;
    return [
        `<div class="${laneClass}" data-role="${lane.role}"${modelAttr}>`,
        '<div class="timeline-meta">',
        `<div class="model-name">${escapeHtml(lane.label)}</div>`,
        `<div class="subtle">${escapeHtml(lane.note)}</div>`,
        '</div>',
        `<div class="${trackClass}">`,
        variant === 'focus' &&
        lane.showHumanShadow === true &&
        humanStyle !== undefined
            ? `<div class="human-shadow" style="${humanStyle}"></div>`
            : '',
        lane.segments
            .map(
                (segment) =>
                    `<div class="${segment.className}" style="${styleForRange(
                        segment.startSec,
                        segment.endSec,
                        domainStart,
                        domainEnd,
                    )}"></div>`,
            )
            .join(''),
        '</div>',
        variant === 'focus' && lane.confidence !== undefined
            ? `<div class="confidence-pill">${escapeHtml(lane.confidence)}</div>`
            : '',
        '</div>',
    ].join('\n');
}

function renderTimeline(
    report: CompareReport,
    rankedRows: readonly RankedRow[],
): string {
    const humanBlocks = report.reference?.humanBlocks ?? [];
    const baselineBlocks = report.reference?.firstRunModel?.blocks ?? [];
    const allEnds = [
        ...humanBlocks.map((block) => block.endSec),
        ...baselineBlocks.map((block) =>
            rangeEnd(block.startSec, block.endSec),
        ),
        ...rankedRows.flatMap((item) =>
            (item.row.blocks ?? []).map((block) =>
                rangeEnd(block.startSec, block.endSec),
            ),
        ),
    ];
    const domainEnd = Math.max(1, ...allEnds);

    const staticLanes: string[] = [];
    if (humanBlocks.length > 0) {
        staticLanes.push(
            renderLane(
                {
                    role: 'human',
                    label: 'Human reference',
                    note: `${String(humanBlocks.length)} labeled promo blocks`,
                    segments: humanBlocks.map((block) => ({
                        startSec: block.startSec,
                        endSec: block.endSec,
                        className: 'segment-human',
                    })),
                },
                0,
                domainEnd,
                'timeline',
            ),
        );
    }
    if (
        baselineBlocks.length > 0 &&
        report.reference?.firstRunModel !== undefined
    ) {
        staticLanes.push(
            renderLane(
                {
                    role: 'baseline',
                    label: `First run: ${report.reference.firstRunModel.model}`,
                    note:
                        report.firstRunVsHuman === undefined
                            ? 'Baseline only'
                            : `avg IoU ${formatPercent(
                                  summarizeMetrics(report.firstRunVsHuman)
                                      .avgIou ?? 0,
                              )}`,
                    segments: baselineBlocks.map((block) => ({
                        startSec: block.startSec,
                        endSec: rangeEnd(block.startSec, block.endSec),
                        className: 'segment-baseline',
                    })),
                },
                0,
                domainEnd,
                'timeline',
            ),
        );
    }

    const modelLanes = rankedRows
        .map((item) =>
            renderLane(
                {
                    role: 'model',
                    model: item.row.model,
                    label: item.row.model,
                    note: buildTimelineNote(item),
                    segments: (item.row.blocks ?? []).map((block) => ({
                        startSec: block.startSec,
                        endSec: rangeEnd(block.startSec, block.endSec),
                        className: `segment ${metricClass(item.summary.avgIou)}`,
                    })),
                },
                0,
                domainEnd,
                'timeline',
            ),
        )
        .join('\n');

    return [
        '<section class="panel">',
        '<div class="panel-head">',
        '<h2>Full timeline</h2>',
        '<p>All predicted promo windows on one shared scale.</p>',
        '</div>',
        '<div class="timeline-axis">',
        `<span>00:00.0</span><span>${escapeHtml(formatClock(domainEnd))}</span>`,
        '</div>',
        staticLanes.join('\n'),
        '<div id="timeline-model-lanes">',
        modelLanes,
        '</div>',
        '</section>',
    ].join('\n');
}

function renderFocusCard(
    report: CompareReport,
    rankedRows: readonly RankedRow[],
    blockIndex: number,
): string {
    const human = report.reference?.humanBlocks[blockIndex];
    if (human === undefined) {
        return '';
    }
    const staticLanes: RenderLane[] = [
        {
            role: 'human',
            label: 'Human reference',
            note: joinDefined([
                `${formatClock(human.startSec)} to ${formatClock(human.endSec)}`,
                human.startCue,
                human.endCue,
            ]),
            segments: [
                {
                    startSec: human.startSec,
                    endSec: human.endSec,
                    className: 'segment-human',
                },
            ],
        },
    ];

    const baselineMetric = report.firstRunVsHuman?.[blockIndex];
    const baselineBlock = report.reference?.firstRunModel?.blocks[blockIndex];
    if (baselineBlock !== undefined) {
        staticLanes.push({
            role: 'baseline',
            label: `First run: ${report.reference?.firstRunModel?.model ?? 'n/a'}`,
            note:
                baselineMetric === undefined
                    ? 'No aligned metric'
                    : joinDefined([
                          `IoU ${formatPercent(baselineMetric.iouWithHuman)}`,
                          `start ${formatDelta(baselineMetric.startDeltaSec)}`,
                          `end ${formatDelta(baselineMetric.endDeltaSec)}`,
                      ]),
            segments: [
                {
                    startSec:
                        baselineMetric?.predStartSec ?? baselineBlock.startSec,
                    endSec:
                        baselineMetric?.predEndSec ??
                        rangeEnd(baselineBlock.startSec, baselineBlock.endSec),
                    className: `segment ${metricClass(baselineMetric?.iouWithHuman)}`,
                },
            ],
            showHumanShadow: true,
        });
    }

    const modelLanes: RenderLane[] = [];
    for (const item of rankedRows) {
        const metric = item.row.vsHuman?.[blockIndex];
        const block = item.row.blocks?.[blockIndex];
        if (block === undefined) {
            continue;
        }
        modelLanes.push({
            role: 'model',
            model: item.row.model,
            label: item.row.model,
            note: buildFocusMetricNote(metric, item),
            segments: [
                {
                    startSec: metric?.predStartSec ?? block.startSec,
                    endSec:
                        metric?.predEndSec ??
                        rangeEnd(block.startSec, block.endSec),
                    className: `segment ${metricClass(metric?.iouWithHuman)}`,
                },
            ],
            confidence: block.confidence,
            showHumanShadow: true,
        });
    }

    const starts = [...staticLanes, ...modelLanes].flatMap((lane) =>
        lane.segments.map((segment) => segment.startSec),
    );
    const ends = [...staticLanes, ...modelLanes].flatMap((lane) =>
        lane.segments.map((segment) => segment.endSec),
    );
    const minSec = Math.min(...starts);
    const maxSec = Math.max(...ends);
    const pad = Math.max(4, (maxSec - minSec) * 0.12);
    const domainStart = Math.max(0, minSec - pad);
    const domainEnd = maxSec + pad;
    const humanStyle = styleForRange(
        human.startSec,
        human.endSec,
        domainStart,
        domainEnd,
    );

    return [
        '<article class="focus-card">',
        '<div class="panel-head">',
        `<h3>Block ${String(blockIndex + 1)}: ${escapeHtml(human.id)}</h3>`,
        `<p>${escapeHtml(
            `${formatClock(domainStart)} to ${formatClock(domainEnd)}`,
        )}</p>`,
        '</div>',
        '<div class="timeline-axis">',
        `<span>${escapeHtml(formatClock(domainStart))}</span>`,
        `<span>${escapeHtml(formatClock(domainEnd))}</span>`,
        '</div>',
        staticLanes
            .map((lane) =>
                renderLane(lane, domainStart, domainEnd, 'focus', humanStyle),
            )
            .join('\n'),
        '<div class="focus-model-lanes">',
        modelLanes
            .map((lane) =>
                renderLane(lane, domainStart, domainEnd, 'focus', humanStyle),
            )
            .join('\n'),
        '</div>',
        '</article>',
    ].join('\n');
}

function renderFocusBlocks(
    report: CompareReport,
    rankedRows: readonly RankedRow[],
): string {
    const count = report.reference?.humanBlocks.length ?? 0;
    const cards = Array.from({ length: count }, (_value, index) =>
        renderFocusCard(report, rankedRows, index),
    ).join('\n');
    return [
        '<section class="panel">',
        '<div class="panel-head">',
        '<h2>Zoomed block views</h2>',
        '<p>Each row is scaled around one human-labeled promo block.</p>',
        '</div>',
        '<div class="focus-grid">',
        cards,
        '</div>',
        '</section>',
    ].join('\n');
}

function renderNotes(report: CompareReport, rankedRows: readonly RankedRow[]) {
    const notes = [
        report.firstRunVsHumanNote,
        ...rankedRows
            .map((item) => `${item.row.model}: ${item.row.vsHumanNote ?? ''}`)
            .filter((note) => !note.endsWith(': ')),
        rankedRows.every((item) => item.cost.effectiveCost === undefined)
            ? 'This log has no cost data. Render a newer compare JSON to use the ' +
              'cost column and cost sorting.'
            : undefined,
    ].filter((note): note is string => note !== undefined);
    if (notes.length === 0) {
        return '';
    }
    return [
        '<section class="panel">',
        '<div class="panel-head">',
        '<h2>Notes</h2>',
        '<p>Shape mismatches and comparison caveats.</p>',
        '</div>',
        '<ul class="notes">',
        notes.map((note) => `<li>${escapeHtml(note)}</li>`).join('\n'),
        '</ul>',
        '</section>',
    ].join('\n');
}

function buildStyles(): string {
    return [
        ':root {',
        '  color-scheme: light;',
        '  --bg: #f4efe2;',
        '  --bg-strong: #ebe3d0;',
        '  --panel: rgba(255, 250, 240, 0.88);',
        '  --panel-border: rgba(53, 45, 37, 0.12);',
        '  --ink: #1f1b18;',
        '  --muted: #6f665f;',
        '  --accent: #0b6e6e;',
        '  --accent-soft: #2a9d8f;',
        '  --amber: #b7791f;',
        '  --rose: #b94c5b;',
        '  --shadow: 0 24px 60px rgba(31, 27, 24, 0.09);',
        '}',
        '* { box-sizing: border-box; }',
        '[hidden] { display: none !important; }',
        'body {',
        '  margin: 0;',
        '  min-height: 100vh;',
        '  background:',
        '    radial-gradient(circle at top left, #fff6d9 0, transparent 34%),',
        '    radial-gradient(circle at top right, #d9f1ef 0, transparent 28%),',
        '    linear-gradient(135deg, var(--bg), var(--bg-strong));',
        '  color: var(--ink);',
        '  font-family: "Avenir Next", "Helvetica Neue", sans-serif;',
        '}',
        'main {',
        '  width: min(1440px, calc(100vw - 32px));',
        '  margin: 0 auto;',
        '  padding: 28px 0 56px;',
        '}',
        'h1, h2, h3 {',
        '  margin: 0;',
        '  font-family: "Iowan Old Style", "Palatino Linotype", serif;',
        '  font-weight: 700;',
        '  letter-spacing: -0.03em;',
        '}',
        'p { margin: 0; }',
        '.hero {',
        '  display: grid;',
        '  gap: 20px;',
        '  padding: 24px;',
        '  border: 1px solid var(--panel-border);',
        '  border-radius: 28px;',
        '  background: rgba(255, 252, 246, 0.9);',
        '  box-shadow: var(--shadow);',
        '}',
        '.hero-grid {',
        '  display: grid;',
        '  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));',
        '  gap: 14px;',
        '}',
        '.hero-meta {',
        '  display: flex;',
        '  flex-wrap: wrap;',
        '  gap: 10px 18px;',
        '  color: var(--muted);',
        '}',
        '.hero-meta strong { color: var(--ink); }',
        '.stat-card, .panel, .focus-card {',
        '  border: 1px solid var(--panel-border);',
        '  border-radius: 24px;',
        '  background: var(--panel);',
        '  box-shadow: var(--shadow);',
        '}',
        '.stat-card { padding: 18px; }',
        '.panel { margin-top: 20px; padding: 20px; }',
        '.focus-card { padding: 18px; }',
        '.eyebrow {',
        '  color: var(--muted);',
        '  font-size: 0.82rem;',
        '  letter-spacing: 0.12em;',
        '  text-transform: uppercase;',
        '}',
        '.stat-value {',
        '  margin-top: 10px;',
        '  font-size: clamp(1.2rem, 2vw, 2rem);',
        '  line-height: 1.1;',
        '}',
        '.stat-note { margin-top: 8px; color: var(--muted); }',
        '.panel-head {',
        '  display: flex;',
        '  flex-wrap: wrap;',
        '  justify-content: space-between;',
        '  gap: 8px 16px;',
        '  margin-bottom: 16px;',
        '}',
        '.panel-head p { color: var(--muted); }',
        '.controls-grid {',
        '  display: grid;',
        '  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));',
        '  gap: 12px;',
        '  align-items: end;',
        '}',
        '.control-field, .control-toggle {',
        '  display: grid;',
        '  gap: 8px;',
        '}',
        '.control-field span {',
        '  color: var(--muted);',
        '  font-size: 0.82rem;',
        '  letter-spacing: 0.06em;',
        '  text-transform: uppercase;',
        '}',
        '.control-field input, .control-field select {',
        '  width: 100%;',
        '  min-height: 44px;',
        '  padding: 0 14px;',
        '  border: 1px solid rgba(53, 45, 37, 0.16);',
        '  border-radius: 14px;',
        '  background: rgba(255, 255, 255, 0.82);',
        '  color: var(--ink);',
        '}',
        '.control-toggle {',
        '  grid-auto-flow: column;',
        '  justify-content: start;',
        '  align-items: center;',
        '  align-self: center;',
        '  gap: 10px;',
        '  padding-top: 22px;',
        '}',
        '.ghost-button {',
        '  min-height: 44px;',
        '  padding: 0 18px;',
        '  border: 1px solid rgba(53, 45, 37, 0.16);',
        '  border-radius: 14px;',
        '  background: transparent;',
        '  color: var(--ink);',
        '  cursor: pointer;',
        '}',
        '.controls-meta {',
        '  align-self: center;',
        '  color: var(--muted);',
        '  font-size: 0.92rem;',
        '}',
        '.table-wrap { overflow-x: auto; }',
        'table { width: 100%; border-collapse: collapse; }',
        'th, td {',
        '  padding: 12px 10px;',
        '  border-bottom: 1px solid rgba(53, 45, 37, 0.08);',
        '  text-align: left;',
        '  vertical-align: top;',
        '}',
        'thead th {',
        '  color: var(--muted);',
        '  font-size: 0.82rem;',
        '  letter-spacing: 0.08em;',
        '  text-transform: uppercase;',
        '}',
        '.leaderboard-row:hover { background: rgba(255, 255, 255, 0.55); }',
        '.model-name { font-weight: 700; }',
        '.cell-main { font-weight: 700; }',
        '.subtle {',
        '  margin-top: 4px;',
        '  color: var(--muted);',
        '  font-size: 0.92rem;',
        '}',
        '.score {',
        '  display: inline-flex;',
        '  align-items: center;',
        '  min-width: 76px;',
        '  padding: 4px 10px;',
        '  border-radius: 999px;',
        '  font-weight: 700;',
        '}',
        '.metric-neutral { background: rgba(111, 102, 95, 0.14); }',
        '.metric-excellent { background: rgba(11, 110, 110, 0.16); }',
        '.metric-good { background: rgba(42, 157, 143, 0.16); }',
        '.metric-fair { background: rgba(183, 121, 31, 0.16); }',
        '.metric-weak { background: rgba(185, 76, 91, 0.16); }',
        '.timeline-axis {',
        '  display: flex;',
        '  justify-content: space-between;',
        '  margin-bottom: 10px;',
        '  color: var(--muted);',
        '  font-variant-numeric: tabular-nums;',
        '}',
        '.timeline-meta { display: grid; gap: 2px; }',
        '.timeline-lane, .focus-lane {',
        '  display: grid;',
        '  grid-template-columns: minmax(210px, 320px) 1fr auto;',
        '  gap: 12px;',
        '  align-items: center;',
        '  margin-top: 12px;',
        '}',
        '.timeline-track {',
        '  position: relative;',
        '  height: 32px;',
        '  overflow: hidden;',
        '  border-radius: 999px;',
        '  background:',
        '    linear-gradient(',
        '      90deg,',
        '      rgba(31, 27, 24, 0.06),',
        '      rgba(31, 27, 24, 0.02)',
        '    );',
        '}',
        '.timeline-track-focus { height: 34px; }',
        '.segment, .segment-human, .segment-baseline, .human-shadow {',
        '  position: absolute;',
        '  top: 6px;',
        '  height: 20px;',
        '  border-radius: 999px;',
        '}',
        '.segment-human { background: rgba(31, 27, 24, 0.75); }',
        '.segment-baseline { background: rgba(183, 121, 31, 0.7); }',
        '.segment.metric-excellent { background: rgba(11, 110, 110, 0.82); }',
        '.segment.metric-good { background: rgba(42, 157, 143, 0.78); }',
        '.segment.metric-fair { background: rgba(183, 121, 31, 0.78); }',
        '.segment.metric-weak { background: rgba(185, 76, 91, 0.76); }',
        '.segment.metric-neutral { background: rgba(111, 102, 95, 0.72); }',
        '.human-shadow {',
        '  background: rgba(31, 27, 24, 0.08);',
        '  border: 1px dashed rgba(31, 27, 24, 0.35);',
        '}',
        '.focus-grid {',
        '  display: grid;',
        '  grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));',
        '  gap: 16px;',
        '}',
        '.confidence-pill {',
        '  padding: 4px 10px;',
        '  border-radius: 999px;',
        '  background: rgba(11, 110, 110, 0.1);',
        '  color: var(--accent);',
        '  font-size: 0.84rem;',
        '  text-transform: uppercase;',
        '  letter-spacing: 0.08em;',
        '}',
        '.notes {',
        '  margin: 0;',
        '  padding-left: 20px;',
        '  color: var(--muted);',
        '}',
        '.notes li + li { margin-top: 8px; }',
        '.empty-state {',
        '  margin-top: 12px;',
        '  color: var(--muted);',
        '}',
        '@media (max-width: 900px) {',
        '  main { width: min(100vw - 20px, 1440px); padding-top: 18px; }',
        '  .timeline-lane, .focus-lane {',
        '    grid-template-columns: 1fr;',
        '  }',
        '  .control-toggle { padding-top: 0; }',
        '  .confidence-pill { justify-self: start; }',
        '}',
    ].join('\n');
}

function buildClientScript(): string {
    return [
        '<script>',
        '(function () {',
        "  const search = document.getElementById('report-search');",
        "  const sort = document.getElementById('report-sort');",
        '  const successfulOnly = document.getElementById(',
        "    'report-successful-only',",
        '  );',
        "  const costOnly = document.getElementById('report-cost-only');",
        "  const reset = document.getElementById('report-reset');",
        "  const results = document.getElementById('report-results');",
        "  const empty = document.getElementById('leaderboard-empty');",
        "  const body = document.getElementById('leaderboard-body');",
        "  const timelineModels = document.getElementById('timeline-model-lanes');",
        '  if (',
        '    search === null ||',
        '    sort === null ||',
        '    successfulOnly === null ||',
        '    costOnly === null ||',
        '    reset === null ||',
        '    results === null ||',
        '    empty === null ||',
        '    body === null',
        '  ) {',
        '    return;',
        '  }',
        '  const rows = Array.from(body.querySelectorAll("tr[data-model]"));',
        '  const focusContainers = Array.from(',
        '    document.querySelectorAll(".focus-model-lanes"),',
        '  );',
        '  function toNumber(raw) {',
        '    if (raw === undefined || raw === "") {',
        '      return undefined;',
        '    }',
        '    const value = Number(raw);',
        '    return Number.isFinite(value) ? value : undefined;',
        '  }',
        '  function compareOptionalAsc(left, right) {',
        '    if (left === undefined && right === undefined) {',
        '      return 0;',
        '    }',
        '    if (left === undefined) {',
        '      return 1;',
        '    }',
        '    if (right === undefined) {',
        '      return -1;',
        '    }',
        '    return left - right;',
        '  }',
        '  function compareOptionalDesc(left, right) {',
        '    if (left === undefined && right === undefined) {',
        '      return 0;',
        '    }',
        '    if (left === undefined) {',
        '      return 1;',
        '    }',
        '    if (right === undefined) {',
        '      return -1;',
        '    }',
        '    return right - left;',
        '  }',
        '  function searchMatches(row) {',
        '    const query = search.value.trim().toLowerCase();',
        '    if (query.length === 0) {',
        '      return true;',
        '    }',
        '    return (row.dataset.searchText || "").includes(query);',
        '  }',
        '  function rowVisible(row) {',
        '    if (!searchMatches(row)) {',
        '      return false;',
        '    }',
        '    if (successfulOnly.checked && row.dataset.ok !== "true") {',
        '      return false;',
        '    }',
        '    if (costOnly.checked && row.dataset.hasCost !== "true") {',
        '      return false;',
        '    }',
        '    return true;',
        '  }',
        '  function sortRows(left, right) {',
        '    const mode = sort.value;',
        '    const leftLatency = toNumber(left.dataset.latencyMs);',
        '    const rightLatency = toNumber(right.dataset.latencyMs);',
        '    const leftCost = toNumber(left.dataset.effectiveCost);',
        '    const rightCost = toNumber(right.dataset.effectiveCost);',
        '    const leftIou = toNumber(left.dataset.avgIou);',
        '    const rightIou = toNumber(right.dataset.avgIou);',
        '    const leftStart = toNumber(left.dataset.avgStartDelta);',
        '    const rightStart = toNumber(right.dataset.avgStartDelta);',
        '    const leftEnd = toNumber(left.dataset.avgEndDelta);',
        '    const rightEnd = toNumber(right.dataset.avgEndDelta);',
        '    if (mode === "cost") {',
        '      return compareOptionalAsc(leftCost, rightCost) ||',
        '        compareOptionalDesc(leftIou, rightIou) ||',
        '        compareOptionalAsc(leftLatency, rightLatency) ||',
        '        (left.dataset.model || "").localeCompare(',
        '          right.dataset.model || "",',
        '        );',
        '    }',
        '    if (mode === "latency") {',
        '      return compareOptionalAsc(leftLatency, rightLatency) ||',
        '        compareOptionalDesc(leftIou, rightIou) ||',
        '        compareOptionalAsc(leftCost, rightCost);',
        '    }',
        '    if (mode === "iou") {',
        '      return compareOptionalDesc(leftIou, rightIou) ||',
        '        compareOptionalAsc(leftStart, rightStart) ||',
        '        compareOptionalAsc(leftCost, rightCost);',
        '    }',
        '    if (mode === "start-delta") {',
        '      return compareOptionalAsc(leftStart, rightStart) ||',
        '        compareOptionalDesc(leftIou, rightIou) ||',
        '        compareOptionalAsc(leftCost, rightCost);',
        '    }',
        '    if (mode === "end-delta") {',
        '      return compareOptionalAsc(leftEnd, rightEnd) ||',
        '        compareOptionalDesc(leftIou, rightIou) ||',
        '        compareOptionalAsc(leftCost, rightCost);',
        '    }',
        '    if (mode === "model") {',
        '      return (left.dataset.model || "").localeCompare(',
        '        right.dataset.model || "",',
        '      );',
        '    }',
        '    return compareOptionalDesc(leftIou, rightIou) ||',
        '      compareOptionalAsc(leftStart, rightStart) ||',
        '      compareOptionalAsc(leftCost, rightCost) ||',
        '      compareOptionalAsc(leftLatency, rightLatency) ||',
        '      compareOptionalAsc(',
        '        toNumber(left.dataset.defaultRank),',
        '        toNumber(right.dataset.defaultRank),',
        '      );',
        '  }',
        '  function reorderModelLanes(container, orderedModels) {',
        '    if (container === null) {',
        '      return;',
        '    }',
        '    const lanes = Array.from(container.querySelectorAll("[data-model]"));',
        '    const laneMap = new Map(',
        '      lanes.map((lane) => [lane.dataset.model, lane]),',
        '    );',
        '    lanes.forEach((lane) => {',
        '      lane.hidden = !orderedModels.includes(lane.dataset.model || "");',
        '    });',
        '    orderedModels.forEach((model) => {',
        '      const lane = laneMap.get(model);',
        '      if (lane !== undefined) {',
        '        lane.hidden = false;',
        '        container.appendChild(lane);',
        '      }',
        '    });',
        '  }',
        '  function apply() {',
        '    const visible = rows.filter(rowVisible).sort(sortRows);',
        '    rows.forEach((row) => { row.hidden = true; });',
        '    visible.forEach((row, index) => {',
        '      row.hidden = false;',
        '      const rankCell = row.querySelector("[data-rank]");',
        '      if (rankCell !== null) {',
        '        rankCell.textContent = String(index + 1);',
        '      }',
        '      body.appendChild(row);',
        '    });',
        '    const orderedModels = visible',
        '      .map((row) => row.dataset.model || "")',
        '      .filter((model) => model.length > 0);',
        '    reorderModelLanes(timelineModels, orderedModels);',
        '    focusContainers.forEach((container) => {',
        '      reorderModelLanes(container, orderedModels);',
        '    });',
        '    empty.hidden = visible.length !== 0;',
        '    const costCount = visible.filter(',
        '      (row) => row.dataset.hasCost === "true",',
        '    ).length;',
        '    results.textContent = `${visible.length} visible | ` +',
        '      `${costCount} with cost | sort ${sort.value}`;',
        '  }',
        '  search.addEventListener("input", apply);',
        '  sort.addEventListener("change", apply);',
        '  successfulOnly.addEventListener("change", apply);',
        '  costOnly.addEventListener("change", apply);',
        '  reset.addEventListener("click", function () {',
        '    search.value = "";',
        '    sort.value = "alignment";',
        '    successfulOnly.checked = false;',
        '    costOnly.checked = false;',
        '    apply();',
        '  });',
        '  apply();',
        '})();',
        '</script>',
    ].join('\n');
}

export function renderOpenRouterCompareHtml(
    report: CompareReport,
    options: HtmlOptions = {},
): string {
    const rankedRows = buildRankedRows(report.rows);
    const successfulCount = rankedRows.filter((item) => item.row.ok).length;
    const title =
        options.title ??
        (report.reference?.videoId === undefined
            ? 'OpenRouter preset comparison'
            : `OpenRouter preset comparison: ${report.reference.videoId}`);
    const sourceLabel = options.sourceLabel ?? 'inline data';
    const heroMeta = [
        `<div><strong>Source:</strong> ${escapeHtml(sourceLabel)}</div>`,
        `<div><strong>Presets:</strong> ${String(report.presetCount)}</div>`,
        `<div><strong>Successful:</strong> ${String(successfulCount)}</div>`,
        `<div><strong>Cost Coverage:</strong> ${escapeHtml(
            buildCostCoverageLabel(rankedRows),
        )}</div>`,
        `<div><strong>Reference:</strong> ${escapeHtml(
            report.reference?.videoId ?? 'not provided',
        )}</div>`,
        report.generatedAt === undefined
            ? ''
            : `<div><strong>Generated:</strong> ${escapeHtml(
                  formatGeneratedAt(report.generatedAt),
              )}</div>`,
        report.source?.fixture === undefined
            ? ''
            : `<div><strong>Fixture:</strong> ${escapeHtml(
                  report.source.fixture,
              )}</div>`,
    ]
        .filter((item) => item.length > 0)
        .join('');

    return [
        '<!doctype html>',
        '<html lang="en">',
        '<head>',
        '<meta charset="utf-8">',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        `<title>${escapeHtml(title)}</title>`,
        `<style>${buildStyles()}</style>`,
        '</head>',
        '<body>',
        '<main>',
        '<section class="hero">',
        `<div class="eyebrow">${escapeHtml(title)}</div>`,
        '<h1>Promo block comparison</h1>',
        `<div class="hero-meta">${heroMeta}</div>`,
        '<div class="hero-grid">',
        renderHighlights(report, rankedRows),
        '</div>',
        '</section>',
        renderControls(rankedRows),
        renderLeaderboard(rankedRows),
        renderTimeline(report, rankedRows),
        renderFocusBlocks(report, rankedRows),
        renderNotes(report, rankedRows),
        buildClientScript(),
        '</main>',
        '</body>',
        '</html>',
    ].join('\n');
}
