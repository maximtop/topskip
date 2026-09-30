#!/usr/bin/env node

/**
 * @file Maintainer-only: same merged transcript → every built-in OpenRouter
 * preset. Reads `OPENROUTER_API_KEY` from `.env` (extension root) or the
 * process environment (shell wins if both set). Never bundled.
 *
 * Cost: one `chat/completions` call per preset (see openrouter.ai/models).
 * N calls per fixture run — opt-in only; not used during normal playback.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Command, Option } from 'commander';
import { config as loadDotEnv } from 'dotenv';

import {
    callOpenRouterChat,
    type CallOpenRouterChatParams,
} from '@/background/openrouter/openrouter-client';
import { parseLlmPromoResponse } from '@/background/openrouter/parse-llm-promo-response';
import { PROMO_DETECTION_SYSTEM_PROMPT } from '@/background/openrouter/promo-detection-system-prompt';
import { OPENROUTER_BUILTIN_MODEL_SLUGS } from '@/shared/openrouter-model-presets';

import {
    estimateCostFromUsageAndPricing,
    parsePricingNumber,
    rankCompareSummaryRows,
    summarizeVsHumanMetrics,
    type OpenRouterModelPricing,
} from './lib/openrouter-compare-summary';
import {
    compareHumanAlignedBlocks,
    parseReferenceBundleJson,
    type AlignedBlockMetric,
    type ReferenceBundle,
} from './lib/promo-reference-compare';

/**
 * Loads `.env` from the extension package root when the file exists. Existing
 * `process.env` entries are not overwritten (exported shell values win).
 */
function loadExtensionDotEnv(): void {
    const extensionRoot = path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
    );
    loadDotEnv({ path: path.resolve(extensionRoot, '.env') });
}

loadExtensionDotEnv();

/**
 * Drops leading `--` tokens (pnpm / tsx / dotenv wrappers sometimes insert one
 * before forwarded flags). Without this, Commander treats `--` as “end of
 * options” and ignores `--fixture`.
 *
 * @param argv - Typically `process.argv.slice(2)`
 *
 * @returns Arguments for {@link Command.parseAsync} with `{ from: 'user' }`
 */
function normalizeForwardedCliArgs(argv: readonly string[]): string[] {
    let i = 0;
    while (i < argv.length && argv[i] === '--') {
        i += 1;
    }
    return argv.slice(i);
}

/**
 * One promo block as predicted by a model.
 */
interface PredictedBlock {
    /**
     * Predicted block start time in seconds.
     */
    startSec: number;

    /**
     * Predicted block end time in seconds, when the model reported one.
     */
    endSec?: number | undefined;

    /**
     * Model-reported confidence label for this block, when reported.
     */
    confidence?: string | undefined;
}

/**
 * One preset's outcome for the fixture: request timing, raw usage/pricing
 * from OpenRouter, and (when a reference bundle was given) alignment against
 * human-labeled blocks.
 */
interface Row {
    /**
     * OpenRouter model slug requested.
     */
    model: string;

    /**
     * Model slug OpenRouter actually served the request with, when reported.
     */
    responseModel?: string | undefined;

    /**
     * Wall-clock request duration in milliseconds.
     */
    ms: number;

    /**
     * Whether the request succeeded and its response parsed as valid JSON.
     */
    ok: boolean;

    /**
     * Failure message; set only when `ok` is false.
     */
    error?: string | undefined;

    /**
     * Token usage reported by OpenRouter for this request, when available.
     */
    usage?: {
        /**
         * Tokens in the request prompt.
         */
        promptTokens: number;

        /**
         * Tokens in the model's completion.
         */
        completionTokens: number;

        /**
         * `promptTokens + completionTokens`, as reported by OpenRouter.
         */
        totalTokens: number;

        /**
         * Breakdown of prompt tokens by cache/media category, when reported.
         */
        promptTokensDetails?: {
            /**
             * Prompt tokens served from cache.
             */
            cachedTokens?: number | undefined;

            /**
             * Prompt tokens written to cache for reuse.
             */
            cacheWriteTokens?: number | undefined;

            /**
             * Prompt tokens attributed to audio input.
             */
            audioTokens?: number | undefined;

            /**
             * Prompt tokens attributed to video input.
             */
            videoTokens?: number | undefined;
        } | undefined;

        /**
         * Breakdown of completion tokens by category, when reported.
         */
        completionTokensDetails?: {
            /**
             * Completion tokens spent on internal reasoning.
             */
            reasoningTokens?: number | undefined;

            /**
             * Completion tokens attributed to audio output.
             */
            audioTokens?: number | undefined;

            /**
             * Completion tokens attributed to image output.
             */
            imageTokens?: number | undefined;
        } | undefined;

        /**
         * Total cost in USD as reported directly by OpenRouter, when present.
         */
        cost?: number | undefined;

        /**
         * Whether this request billed through the caller's own (BYOK) provider key.
         */
        isByok?: boolean | undefined;

        /**
         * Cost breakdown for BYOK requests where the upstream provider bills separately.
         */
        costDetails?: {
            /**
             * Total upstream inference cost in USD.
             */
            upstreamInferenceCost?: number | undefined;

            /**
             * Upstream prompt-processing cost in USD.
             */
            upstreamInferencePromptCost?: number | undefined;

            /**
             * Upstream completion-generation cost in USD.
             */
            upstreamInferenceCompletionsCost?: number | undefined;
        } | undefined;
    } | undefined;

    /**
     * Per-token pricing for this model, fetched from the OpenRouter models list.
     */
    pricing?: OpenRouterModelPricing | undefined;

    /**
     * Cost figures computed locally from `usage` and `pricing`, alongside the reported cost.
     */
    costAnalysis?: {
        /**
         * Cost as reported directly by OpenRouter (same value as `usage.cost`).
         */
        reportedCost?: number | undefined;

        /**
         * Total cost estimated from `usage` and `pricing`.
         */
        estimatedCostUsd?: number | undefined;

        /**
         * Estimated cost attributable to prompt tokens.
         */
        promptCostUsd?: number | undefined;

        /**
         * Estimated cost attributable to completion tokens.
         */
        completionCostUsd?: number | undefined;

        /**
         * Estimated cost attributable to cache reads.
         */
        cacheReadCostUsd?: number | undefined;

        /**
         * Estimated cost attributable to cache writes.
         */
        cacheWriteCostUsd?: number | undefined;

        /**
         * Estimated cost attributable to internal reasoning tokens.
         */
        internalReasoningCostUsd?: number | undefined;

        /**
         * Estimated flat per-request cost.
         */
        requestCostUsd?: number | undefined;
    } | undefined;

    /**
     * Promo blocks the model predicted; empty array when it reported no promo.
     */
    blocks?: PredictedBlock[] | undefined;

    /**
     * Per-block alignment metrics against the reference human blocks, when a reference was given.
     */
    vsHuman?: AlignedBlockMetric[] | undefined;

    /**
     * Note explaining a block-count mismatch against the human reference, when one exists.
     */
    vsHumanNote?: string | undefined;
}

/**
 * Narrows a value to a non-null, non-array object so its fields can be read.
 *
 * @param value - Value to check.
 *
 * @returns Whether the value is a plain object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Extracts a printable message from a caught value of unknown type.
 *
 * @param error - Caught value.
 *
 * @returns The error's message, or its string conversion when it is not an `Error`.
 */
function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * Ascending comparator for optional numbers, sorting `undefined` last so
 * rows with no data settle to the bottom of a ranking instead of the top.
 *
 * @param left - First value.
 * @param right - Second value.
 *
 * @returns Negative, zero, or positive per `Array.prototype.sort` convention.
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
 * Renders the reported or estimated cost of a row for a progress line.
 *
 * @param row - Row to summarize.
 *
 * @returns Cost text, or `undefined` when neither cost figure is available.
 */
function formatProgressCost(row: Row): string | undefined {
    const reported = row.usage?.cost;
    if (reported !== undefined) {
        return `cost ${reported.toFixed(5)}`;
    }
    const estimated = row.costAnalysis?.estimatedCostUsd;
    if (estimated !== undefined) {
        return `cost~ ${estimated.toFixed(5)}`;
    }
    return undefined;
}

/**
 * Renders one stderr progress line summarizing a completed request: timing,
 * tokens, cost, and (when a reference exists) alignment metrics.
 *
 * @param row - Row to summarize.
 *
 * @returns Comma-separated progress line.
 */
function formatProgressLine(row: Row): string {
    const parts = [`${row.ms} ms`];
    if (row.usage !== undefined) {
        const tokenSummary = `tokens ${String(row.usage.promptTokens)}/${
            String(row.usage.completionTokens)}`;
        parts.push(tokenSummary);
    }
    const cost = formatProgressCost(row);
    if (cost !== undefined) {
        parts.push(cost);
    }
    const summary = row.vsHuman !== undefined
        ? summarizeVsHumanMetrics(row.vsHuman)
        : undefined;
    if (summary !== undefined) {
        parts.push(`meanIoU ${summary.meanIoU.toFixed(4)}`);
        parts.push(`|start| ${summary.meanAbsStartDeltaSec.toFixed(2)}s`);
    }
    if (row.vsHumanNote !== undefined) {
        parts.push(row.vsHumanNote);
    }
    return parts.join(', ');
}

/**
 * Parses one OpenRouter models-list entry's `pricing` field, discarding it
 * when none of the known rate fields are present.
 *
 * @param value - Raw `pricing` field from the OpenRouter models response.
 *
 * @returns Parsed pricing, or `undefined` when no rate field was present.
 */
function normalizePricing(value: unknown): OpenRouterModelPricing | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const pricing: OpenRouterModelPricing = {
        prompt: parsePricingNumber(value.prompt),
        completion: parsePricingNumber(value.completion),
        request: parsePricingNumber(value.request),
        webSearch: parsePricingNumber(value.web_search),
        internalReasoning: parsePricingNumber(value.internal_reasoning),
        inputCacheRead: parsePricingNumber(value.input_cache_read),
        inputCacheWrite: parsePricingNumber(value.input_cache_write),
    };
    if (
        pricing.prompt === undefined
        && pricing.completion === undefined
        && pricing.request === undefined
        && pricing.webSearch === undefined
        && pricing.internalReasoning === undefined
        && pricing.inputCacheRead === undefined
        && pricing.inputCacheWrite === undefined
    ) {
        return undefined;
    }
    return pricing;
}

/**
 * Fetches OpenRouter's public models list and indexes pricing by both the
 * model id and its canonical slug, so a response's `responseModel` (which
 * may be either form) resolves to the same pricing.
 *
 * @returns Map of model id/canonical slug to pricing.
 *
 * @throws {Error} When the request fails, the response is not JSON, or its shape is unexpected.
 */
async function fetchOpenRouterPricingMap(): Promise<
    Map<string, OpenRouterModelPricing>
> {
    const res = await fetch('https://openrouter.ai/api/v1/models');
    const text = await res.text();
    if (!res.ok) {
        const status = String(res.status);
        throw new Error(`OpenRouter models HTTP ${status}: ${text}`);
    }
    let json: unknown;
    try {
        json = JSON.parse(text) as unknown;
    } catch {
        throw new Error('OpenRouter models response was not JSON');
    }
    if (!isRecord(json) || !Array.isArray(json.data)) {
        throw new Error('OpenRouter models response shape invalid');
    }

    const pricingMap = new Map<string, OpenRouterModelPricing>();
    for (const item of json.data) {
        if (isRecord(item) && typeof item.id === 'string') {
            const pricing = normalizePricing(item.pricing);
            if (pricing !== undefined) {
                pricingMap.set(item.id, pricing);
                if (typeof item.canonical_slug === 'string') {
                    pricingMap.set(item.canonical_slug, pricing);
                }
            }
        }
    }
    return pricingMap;
}

/**
 * Passes a fixture through unchanged when it already carries the
 * `videoId=`/`language=` headers; otherwise synthesizes them.
 *
 * @param fixturePath - UTF-8: timed `[sec] text` lines or full user body
 * @param videoId - Synthetic id for the user message prefix
 * @param language - Language code for the user message prefix
 *
 * @returns User message string passed to OpenRouter
 */
function buildUserContent(
    fixturePath: string,
    videoId: string,
    language: string,
): string {
    const raw = readFileSync(fixturePath, 'utf8').trimEnd();
    if (raw.startsWith('videoId=')) {
        return raw;
    }
    return [`videoId=${videoId}`, `language=${language}`, '', raw].join('\n');
}

const program = new Command();

const REASONING_EFFORT_LEVELS = [
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
] as const;

/**
 * Reads CLI options, calls each preset model once, prints JSON to stdout.
 *
 * @returns Promise that settles when the comparison run finishes
 */
async function runPresetComparison(): Promise<void> {
    const opts = program.opts<{
        fixture: string;
        videoId: string;
        language: string;
        models?: string;
        reasoningEffort?: CallOpenRouterChatParams['reasoningEffort'];
        reference?: string;
        out?: string;
        progress: boolean;
    }>();
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    if (!apiKey) {
        console.error(
            'Missing OPENROUTER_API_KEY (add .env or export in shell; '
                + 'never commit keys).',
        );
        process.exit(1);
    }

    const userContent = buildUserContent(
        opts.fixture,
        opts.videoId,
        opts.language,
    );
    const messages = [
        { role: 'system' as const, content: PROMO_DETECTION_SYSTEM_PROMPT },
        { role: 'user' as const, content: userContent },
    ];
    const models = opts.models === undefined
        ? OPENROUTER_BUILTIN_MODEL_SLUGS
        : opts.models
            .split(',')
            .map((model) => model.trim())
            .filter((model) => model.length > 0);
    if (models.length === 0) {
        throw new Error('--models must contain at least one model slug');
    }

    let reference: ReferenceBundle | undefined;
    let firstRunVsHuman: AlignedBlockMetric[] | undefined;
    let firstRunVsHumanNote: string | undefined;
    let humanBlocks: ReferenceBundle['humanBlocks'] | undefined;
    if (opts.reference !== undefined && opts.reference.length > 0) {
        const refPath = path.resolve(process.cwd(), opts.reference);
        const refText = readFileSync(refPath, 'utf8');
        reference = parseReferenceBundleJson(refText);
        humanBlocks = reference.humanBlocks;
        const fr = reference.firstRunModel;
        if (fr !== undefined) {
            firstRunVsHuman = compareHumanAlignedBlocks(humanBlocks, fr.blocks);
            if (humanBlocks.length !== fr.blocks.length) {
                firstRunVsHumanNote = `humanBlocks=${String(humanBlocks.length)} vs `
                    + `firstRunModel.blocks=${String(fr.blocks.length)}`;
            }
        }
    }

    let pricingMap = new Map<string, OpenRouterModelPricing>();
    if (opts.progress) {
        console.error(
            `Comparing ${String(models.length)} `
                + `presets for ${opts.fixture}`,
        );
        if (humanBlocks !== undefined) {
            console.error(
                `Loaded ${String(humanBlocks.length)} human `
                    + `reference block(s) from ${opts.reference}`,
            );
        }
        console.error('Fetching OpenRouter model pricing metadata...');
    }
    try {
        pricingMap = await fetchOpenRouterPricingMap();
        if (opts.progress) {
            console.error(
                `Loaded pricing for ${String(pricingMap.size)} `
                    + 'model ids/canonical slugs.',
            );
        }
    } catch (error) {
        console.error(`Pricing lookup failed: ${getErrorMessage(error)}`);
    }

    const rows: Row[] = [];
    for (const [index, model] of models.entries()) {
        if (opts.progress) {
            const progressLabel = `[${String(index + 1)}/`
                + `${String(models.length)}] ${model}...`;
            console.error(progressLabel);
        }
        const t0 = performance.now();
        const chat = await callOpenRouterChat({
            apiKey,
            model,
            messages,
            reasoningEffort: opts.reasoningEffort,
        });
        const ms = Math.round(performance.now() - t0);
        const pricingModel = chat.ok ? (chat.responseModel ?? model) : model;
        const pricing = pricingMap.get(pricingModel) ?? pricingMap.get(model);

        if (!chat.ok) {
            const row = {

                model,
                ms,
                ok: false,
                error: chat.error,
                pricing,
            };
            rows.push(row);
            console.error(
                `[${String(index + 1)}/`
                    + `${String(models.length)}] `
                    + `${model} failed: ${chat.error}`,
            );
        } else {
            const costBreakdown = chat.usage !== undefined && pricing !== undefined
                ? estimateCostFromUsageAndPricing(chat.usage, pricing)
                : undefined;
            const parsed = parseLlmPromoResponse(chat.rawContent, undefined);
            if (!parsed.ok) {
                const row = {
                    model,
                    responseModel: chat.responseModel,
                    ms,
                    ok: false,
                    error: parsed.error,
                    usage: chat.usage,
                    pricing,
                    costAnalysis:
                        chat.usage?.cost !== undefined
                        || costBreakdown !== undefined
                            ? {
                                reportedCost: chat.usage?.cost,
                                estimatedCostUsd: costBreakdown?.totalUsd,
                                promptCostUsd: costBreakdown?.promptCostUsd,
                                completionCostUsd:
                                      costBreakdown?.completionCostUsd,
                                cacheReadCostUsd: costBreakdown?.cacheReadCostUsd,
                                cacheWriteCostUsd:
                                      costBreakdown?.cacheWriteCostUsd,
                                internalReasoningCostUsd:
                                      costBreakdown?.internalReasoningCostUsd,
                                requestCostUsd: costBreakdown?.requestCostUsd,
                            }
                            : undefined,
                } satisfies Row;
                rows.push(row);
                console.error(
                    `[${String(index + 1)}/`
                        + `${String(models.length)}] `
                        + `${model} parse failed: ${parsed.error}`,
                );
            } else if (!parsed.hasPromo) {
                const row = {
                    model,
                    responseModel: chat.responseModel,
                    ms,
                    ok: true,
                    usage: chat.usage,
                    pricing,
                    costAnalysis:
                        chat.usage?.cost !== undefined
                        || costBreakdown !== undefined
                            ? {
                                reportedCost: chat.usage?.cost,
                                estimatedCostUsd: costBreakdown?.totalUsd,
                                promptCostUsd: costBreakdown?.promptCostUsd,
                                completionCostUsd:
                                      costBreakdown?.completionCostUsd,
                                cacheReadCostUsd: costBreakdown?.cacheReadCostUsd,
                                cacheWriteCostUsd:
                                      costBreakdown?.cacheWriteCostUsd,
                                internalReasoningCostUsd:
                                      costBreakdown?.internalReasoningCostUsd,
                                requestCostUsd: costBreakdown?.requestCostUsd,
                            }
                            : undefined,
                    blocks: [],
                    vsHuman: humanBlocks !== undefined ? [] : undefined,
                    vsHumanNote:
                        humanBlocks !== undefined
                            ? `humanBlocks=${String(humanBlocks.length)} vs predicted=0`
                            : undefined,
                } satisfies Row;
                rows.push(row);
                if (opts.progress) {
                    const progressLabel = `[${String(index + 1)}/`
                        + `${String(models.length)}] `
                        + `${model} done: ${formatProgressLine(row)}`;
                    console.error(progressLabel);
                }
            } else {
                const blocks = parsed.blocks.map((b) => ({
                    startSec: b.startSec,
                    endSec: b.endSec,
                    confidence: b.confidence,
                }));
                const vsHuman = humanBlocks !== undefined
                    ? compareHumanAlignedBlocks(humanBlocks, blocks)
                    : undefined;
                const row = {
                    model,
                    responseModel: chat.responseModel,
                    ms,
                    ok: true,
                    usage: chat.usage,
                    pricing,
                    costAnalysis:
                        chat.usage?.cost !== undefined || costBreakdown !== undefined
                            ? {
                                reportedCost: chat.usage?.cost,
                                estimatedCostUsd: costBreakdown?.totalUsd,
                                promptCostUsd: costBreakdown?.promptCostUsd,
                                completionCostUsd: costBreakdown?.completionCostUsd,
                                cacheReadCostUsd: costBreakdown?.cacheReadCostUsd,
                                cacheWriteCostUsd: costBreakdown?.cacheWriteCostUsd,
                                internalReasoningCostUsd:
                                      costBreakdown?.internalReasoningCostUsd,
                                requestCostUsd: costBreakdown?.requestCostUsd,
                            }
                            : undefined,
                    blocks,
                    vsHuman,
                    vsHumanNote:
                        humanBlocks !== undefined
                        && humanBlocks.length !== blocks.length
                            ? `humanBlocks=${String(humanBlocks.length)} `
                              + `vs predicted=${String(blocks.length)}`
                            : undefined,
                } satisfies Row;
                rows.push(row);
                if (opts.progress) {
                    const progressLabel = `[${String(index + 1)}/`
                        + `${String(models.length)}] `
                        + `${model} done: ${formatProgressLine(row)}`;
                    console.error(progressLabel);
                }
            }
        }
    }

    const successfulRows = rows.filter((row) => row.ok);
    const rankedByReportedCost = successfulRows
        .map((row) => ({
            model: row.model,
            ms: row.ms,
            reportedCost: row.usage?.cost,
            estimatedCostUsd: row.costAnalysis?.estimatedCostUsd,
            meanIoU: summarizeVsHumanMetrics(row.vsHuman ?? [])?.meanIoU,
            meanAbsStartDeltaSec: summarizeVsHumanMetrics(row.vsHuman ?? [])
                ?.meanAbsStartDeltaSec,
        }))
        .sort((left, right) => {
            const costCmp = compareOptionalAscending(
                left.reportedCost ?? left.estimatedCostUsd,
                right.reportedCost ?? right.estimatedCostUsd,
            );
            if (costCmp !== 0) {
                return costCmp;
            }
            const iouCmp = compareOptionalAscending(
                right.meanIoU,
                left.meanIoU,
            );
            if (iouCmp !== 0) {
                return iouCmp;
            }
            return left.ms - right.ms;
        });

    const rankedByAlignment = rankCompareSummaryRows(
        rows
            .filter(
                (row): row is Row & { vsHuman: AlignedBlockMetric[] } => row.ok
                    && row.vsHuman !== undefined
                    && row.vsHuman.length > 0,
            )
            .map((row) => ({
                model: row.model,
                ms: row.ms,
                reportedCost: row.usage?.cost,
                estimatedCostUsd: row.costAnalysis?.estimatedCostUsd,
                vsHuman: row.vsHuman,
            })),
    );

    const summary: Record<string, unknown> = {
        successfulCount: successfulRows.length,
        fastestSuccessful:
            successfulRows.length > 0
                ? [...successfulRows].sort(
                    (left, right) => left.ms - right.ms,
                )[0]
                : undefined,
        cheapestSuccessful: rankedByReportedCost[0],
        rankedByReportedCost,
    };
    if (rankedByAlignment.length > 0) {
        const [bestAlignment] = rankedByAlignment;
        summary.bestAlignment = bestAlignment;
        summary.rankedByAlignment = rankedByAlignment;
    }

    const out: Record<string, unknown> = {
        generatedAt: new Date().toISOString(),
        source: {
            fixture: opts.fixture,
            reference: opts.reference ?? null,
            out: opts.out ?? null,
        },
        presetCount: rows.length,
        rows,
        summary,
    };
    if (reference !== undefined) {
        out.reference = reference;
    }
    if (firstRunVsHuman !== undefined) {
        out.firstRunVsHuman = firstRunVsHuman;
    }
    if (firstRunVsHumanNote !== undefined) {
        out.firstRunVsHumanNote = firstRunVsHumanNote;
    }

    const outText = JSON.stringify(out, null, 2);
    if (opts.out !== undefined && opts.out.length > 0) {
        const outPath = path.resolve(process.cwd(), opts.out);
        mkdirSync(path.dirname(outPath), { recursive: true });
        writeFileSync(outPath, outText, 'utf8');
        console.error(`Saved comparison report to ${outPath}`);
    }
    console.log(outText);
}

/**
 * Commander entry: forwards to {@link runPresetComparison}.
 *
 * @returns Promise that settles when the CLI command finishes
 */
async function comparePresetsCliAction(): Promise<void> {
    await runPresetComparison();
}

program
    .name('compare-openrouter-presets')
    .description(
        'Promo detection: one run per built-in OpenRouter preset (maintainers).',
    )
    .requiredOption(
        '-f, --fixture <path>',
        'UTF-8 fixture: timed lines or full user body',
    )
    .option(
        '--video-id <id>',
        'videoId= prefix when fixture is lines only',
        'fixture',
    )
    .option(
        '--language <code>',
        'language= prefix when fixture is lines only',
        'und',
    )
    .option(
        '--models <slugs>',
        'Comma-separated model slugs; defaults to every built-in preset',
    )
    .addOption(
        new Option(
            '--reasoning-effort <level>',
            'OpenRouter reasoning effort for every selected model',
        ).choices([...REASONING_EFFORT_LEVELS]),
    )
    .option(
        '--reference <path>',
        'JSON: humanBlocks + optional firstRunModel (deltas + IoU in output)',
    )
    .option(
        '--out <path>',
        'Write the full JSON report to a file in addition to stdout',
    )
    .option('--no-progress', 'Suppress per-model progress logs on stderr')
    .action(comparePresetsCliAction);

void program.parseAsync(normalizeForwardedCliArgs(process.argv.slice(2)), {
    from: 'user',
});
