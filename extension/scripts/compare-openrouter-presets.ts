#!/usr/bin/env node
/**
 * Maintainer-only: same merged transcript → every built-in OpenRouter preset
 * (FR-004). Reads `OPENROUTER_API_KEY` from `.env` (extension root) or the
 * process environment (shell wins if both set). Never bundled.
 *
 * Cost: one `chat/completions` call per preset (see openrouter.ai/models).
 * N calls per fixture run — opt-in only; not used during normal playback.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { config as loadDotEnv } from 'dotenv';
import { Command } from 'commander';

import { callOpenRouterChat } from
  '@/background/openrouter/openrouter-client';
import { parseLlmPromoResponse } from
  '@/background/openrouter/parse-llm-promo-response';
import { PROMO_DETECTION_SYSTEM_PROMPT } from
  '@/background/openrouter/promo-detection-system-prompt';
import { OPENROUTER_BUILTIN_MODEL_SLUGS } from
  '@/shared/openrouter-model-presets';

import {
  compareHumanAlignedBlocks,
  parseReferenceBundleJson,
  type AlignedBlockMetric,
  type ReferenceBundle,
} from './lib/promo-reference-compare';
import {
  estimateCostFromUsageAndPricing,
  parsePricingNumber,
  rankCompareSummaryRows,
  summarizeVsHumanMetrics,
  type OpenRouterModelPricing,
} from './lib/openrouter-compare-summary';

/**
 * Loads `.env` from the extension package root when the file exists. Existing
 * `process.env` entries are not overwritten (exported shell values win).
 *
 * @returns void
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
 * @returns Arguments for {@link Command.parseAsync} with `{ from: 'user' }`
 */
function normalizeForwardedCliArgs(argv: readonly string[]): string[] {
  let i = 0;
  while (i < argv.length && argv[i] === '--') {
    i += 1;
  }
  return argv.slice(i);
}

type Row = {
  model: string;
  responseModel?: string;
  ms: number;
  ok: boolean;
  error?: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    promptTokensDetails?: {
      cachedTokens?: number;
      cacheWriteTokens?: number;
      audioTokens?: number;
      videoTokens?: number;
    };
    completionTokensDetails?: {
      reasoningTokens?: number;
      audioTokens?: number;
      imageTokens?: number;
    };
    cost?: number;
    isByok?: boolean;
    costDetails?: {
      upstreamInferenceCost?: number;
      upstreamInferencePromptCost?: number;
      upstreamInferenceCompletionsCost?: number;
    };
  };
  pricing?: OpenRouterModelPricing;
  costAnalysis?: {
    reportedCost?: number;
    estimatedCostUsd?: number;
    promptCostUsd?: number;
    completionCostUsd?: number;
    cacheReadCostUsd?: number;
    cacheWriteCostUsd?: number;
    internalReasoningCostUsd?: number;
    requestCostUsd?: number;
  };
  blocks?: { startSec: number; endSec?: number; confidence?: string }[];
  vsHuman?: AlignedBlockMetric[];
  vsHumanNote?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function formatProgressLine(row: Row): string {
  const parts = [`${row.ms} ms`];
  if (row.usage !== undefined) {
    const tokenSummary =
      `tokens ${String(row.usage.promptTokens)}/` +
      `${String(row.usage.completionTokens)}`;
    parts.push(tokenSummary);
  }
  const cost = formatProgressCost(row);
  if (cost !== undefined) {
    parts.push(cost);
  }
  const summary =
    row.vsHuman !== undefined
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
    pricing.prompt === undefined &&
    pricing.completion === undefined &&
    pricing.request === undefined &&
    pricing.webSearch === undefined &&
    pricing.internalReasoning === undefined &&
    pricing.inputCacheRead === undefined &&
    pricing.inputCacheWrite === undefined
  ) {
    return undefined;
  }
  return pricing;
}

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
    if (!isRecord(item) || typeof item.id !== 'string') {
      continue;
    }
    const pricing = normalizePricing(item.pricing);
    if (pricing === undefined) {
      continue;
    }
    pricingMap.set(item.id, pricing);
    if (typeof item.canonical_slug === 'string') {
      pricingMap.set(item.canonical_slug, pricing);
    }
  }
  return pricingMap;
}

/**
 * @param fixturePath - UTF-8: timed `[sec] text` lines or full user body
 * @param videoId - Synthetic id for the user message prefix
 * @param language - Language code for the user message prefix
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
  return [
    `videoId=${videoId}`,
    `language=${language}`,
    '',
    raw,
  ].join('\n');
}

const program = new Command();

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
    reference?: string;
    out?: string;
    progress: boolean;
  }>();
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    console.error(
      'Missing OPENROUTER_API_KEY (add extension/.env or export in shell; ' +
        'never commit keys).',
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
        firstRunVsHumanNote =
          `humanBlocks=${String(humanBlocks.length)} vs ` +
          `firstRunModel.blocks=${String(fr.blocks.length)}`;
      }
    }
  }

  let pricingMap = new Map<string, OpenRouterModelPricing>();
  if (opts.progress) {
    console.error(
      `Comparing ${String(OPENROUTER_BUILTIN_MODEL_SLUGS.length)} ` +
        `presets for ${opts.fixture}`,
    );
    if (humanBlocks !== undefined) {
      console.error(
        `Loaded ${String(humanBlocks.length)} human ` +
          `reference block(s) from ${opts.reference}`,
      );
    }
    console.error('Fetching OpenRouter model pricing metadata...');
  }
  try {
    pricingMap = await fetchOpenRouterPricingMap();
    if (opts.progress) {
      console.error(
        `Loaded pricing for ${String(pricingMap.size)} ` +
          'model ids/canonical slugs.',
      );
    }
  } catch (error) {
    console.error(`Pricing lookup failed: ${getErrorMessage(error)}`);
  }

  const rows: Row[] = [];
  for (const [index, model] of OPENROUTER_BUILTIN_MODEL_SLUGS.entries()) {
    if (opts.progress) {
      const progressLabel =
        `[${String(index + 1)}/` +
        `${String(OPENROUTER_BUILTIN_MODEL_SLUGS.length)}] ${model}...`;
      console.error(progressLabel);
    }
    const t0 = performance.now();
    const chat = await callOpenRouterChat({ apiKey, model, messages });
    const ms = Math.round(performance.now() - t0);
    const pricingModel = chat.ok ? (chat.responseModel ?? model) : model;
    const pricing = pricingMap.get(pricingModel) ?? pricingMap.get(model);

    if (!chat.ok) {
      const row = { model, ms, ok: false, error: chat.error, pricing };
      rows.push(row);
      console.error(
        `[${String(index + 1)}/` +
          `${String(OPENROUTER_BUILTIN_MODEL_SLUGS.length)}] ` +
          `${model} failed: ${chat.error}`,
      );
      continue;
    }

    const costBreakdown =
      chat.usage !== undefined && pricing !== undefined
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
      } satisfies Row;
      rows.push(row);
      console.error(
        `[${String(index + 1)}/` +
          `${String(OPENROUTER_BUILTIN_MODEL_SLUGS.length)}] ` +
          `${model} parse failed: ${parsed.error}`,
      );
      continue;
    }
    if (!parsed.hasPromo) {
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
        blocks: [],
        vsHuman: humanBlocks !== undefined ? [] : undefined,
        vsHumanNote:
          humanBlocks !== undefined
            ? `humanBlocks=${String(humanBlocks.length)} vs predicted=0`
            : undefined,
      } satisfies Row;
      rows.push(row);
      if (opts.progress) {
        const progressLabel =
          `[${String(index + 1)}/` +
          `${String(OPENROUTER_BUILTIN_MODEL_SLUGS.length)}] ` +
          `${model} done: ${formatProgressLine(row)}`;
        console.error(
          progressLabel,
        );
      }
      continue;
    }

    const blocks = parsed.blocks.map((b) => ({
      startSec: b.startSec,
      endSec: b.endSec,
      confidence: b.confidence,
    }));
    const vsHuman =
      humanBlocks !== undefined
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
        humanBlocks !== undefined && humanBlocks.length !== blocks.length
          ? `humanBlocks=${String(humanBlocks.length)} ` +
            `vs predicted=${String(blocks.length)}`
          : undefined,
    } satisfies Row;
    rows.push(row);
    if (opts.progress) {
      const progressLabel =
        `[${String(index + 1)}/` +
        `${String(OPENROUTER_BUILTIN_MODEL_SLUGS.length)}] ` +
        `${model} done: ${formatProgressLine(row)}`;
      console.error(
        progressLabel,
      );
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
      meanAbsStartDeltaSec:
        summarizeVsHumanMetrics(row.vsHuman ?? [])?.meanAbsStartDeltaSec,
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
        (row): row is Row & { vsHuman: AlignedBlockMetric[] } =>
          row.ok && row.vsHuman !== undefined && row.vsHuman.length > 0,
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
        ? [...successfulRows]
            .sort((left, right) => left.ms - right.ms)[0]
        : undefined,
    cheapestSuccessful: rankedByReportedCost[0],
    rankedByReportedCost,
  };
  if (rankedByAlignment.length > 0) {
    summary.bestAlignment = rankedByAlignment[0];
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
    '--reference <path>',
    'JSON: humanBlocks + optional firstRunModel (deltas + IoU in output)',
  )
  .option(
    '--out <path>',
    'Write the full JSON report to a file in addition to stdout',
  )
  .option(
    '--no-progress',
    'Suppress per-model progress logs on stderr',
  )
  .action(comparePresetsCliAction);

void program.parseAsync(normalizeForwardedCliArgs(process.argv.slice(2)), {
  from: 'user',
});
