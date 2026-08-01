import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { parseLlmPromoResponse } from '@/background/openrouter/parse-llm-promo-response';

import {
    benchmarkMessageSha256,
    buildBenchmarkMessages,
    buildBenchmarkRequestBody,
    calculateUsageCostUsd,
    callBenchmarkModel,
    type BenchmarkCallResult,
    type BenchmarkErrorKind,
    type BenchmarkPreflight,
    type BenchmarkUsage,
    BENCHMARK_OUTPUT_LIMIT_POLICY,
    BENCHMARK_REPEAT_COUNT,
    DIRECT_API_HARNESS,
} from './promo-benchmark-core';
import {
    BENCHMARK_REASONING_LEVELS,
    type BenchmarkReasoning,
} from './promo-benchmark-models';

export type BenchmarkPrediction =
    | { hasPromo: false }
    | {
          hasPromo: true;
          promoBlocks: Array<{
              startSec: number;
              endSec?: number;
              confidence?: string;
          }>;
      };

export type BenchmarkSampleErrorKind =
    | BenchmarkErrorKind
    | 'prediction_invalid'
    | 'telemetry_missing';

export type BenchmarkSample = {
    schemaVersion: 2;
    runKey: string;
    corpusId: string;
    corpusManifestSha256: string;
    harness: typeof DIRECT_API_HARNESS;
    model: string;
    reasoning: BenchmarkReasoning;
    repeat: number;
    videoId: string;
    languageCode: string;
    transcriptHash: string;
    fixtureSha256: string;
    promptVersion: string;
    promptSha256: string;
    messageSha256: string;
    outputLimitPolicy: typeof BENCHMARK_OUTPUT_LIMIT_POLICY;
    requestConfigSha256: string;
    streamed: boolean;
    valid: boolean;
    rawAssistant?: string;
    prediction?: BenchmarkPrediction;
    finishReason?: string;
    errorKind?: BenchmarkSampleErrorKind;
    httpStatus?: number;
    usage?: BenchmarkUsage;
    ttftMs?: number;
    latencyMs: number;
    outputTokensPerSecond?: number;
    costUsd?: number;
};

export type BenchmarkRunProgress = {
    completed: number;
    pending: number;
    total: number;
    model: string;
    videoId: string;
    repeat: number;
    valid?: boolean;
    resumed: boolean;
};

type ExpectedSample = {
    runKey: string;
    corpusId: string;
    corpusManifestSha256: string;
    model: string;
    reasoning: BenchmarkReasoning;
    repeat: number;
    videoId: string;
    languageCode: string;
    transcriptHash: string;
    fixtureSha256: string;
    promptVersion: string;
    promptSha256: string;
    messageSha256: string;
    outputLimitPolicy: typeof BENCHMARK_OUTPUT_LIMIT_POLICY;
    requestConfigSha256: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isBenchmarkUsage(value: unknown): value is BenchmarkUsage {
    return (
        isRecord(value) &&
        Number.isInteger(value.promptTokens) &&
        isNonNegativeNumber(value.promptTokens) &&
        Number.isInteger(value.completionTokens) &&
        isNonNegativeNumber(value.completionTokens) &&
        Number.isInteger(value.totalTokens) &&
        isNonNegativeNumber(value.totalTokens) &&
        Number.isInteger(value.cachedTokens) &&
        isNonNegativeNumber(value.cachedTokens) &&
        Number.isInteger(value.cacheWriteTokens) &&
        isNonNegativeNumber(value.cacheWriteTokens) &&
        Number.isInteger(value.reasoningTokens) &&
        isNonNegativeNumber(value.reasoningTokens)
    );
}

function isBenchmarkPrediction(value: unknown): value is BenchmarkPrediction {
    if (!isRecord(value) || typeof value.hasPromo !== 'boolean') {
        return false;
    }
    if (!value.hasPromo) {
        return true;
    }
    if (!Array.isArray(value.promoBlocks)) {
        return false;
    }
    return value.promoBlocks.every(
        (block) =>
            isRecord(block) &&
            isNonNegativeNumber(block.startSec) &&
            (block.endSec === undefined ||
                (isNonNegativeNumber(block.endSec) &&
                    block.endSec > block.startSec)) &&
            (block.confidence === undefined ||
                typeof block.confidence === 'string'),
    );
}

function isSampleErrorKind(value: unknown): value is BenchmarkSampleErrorKind {
    return (
        value === 'http' ||
        value === 'network' ||
        value === 'timeout' ||
        value === 'response_missing' ||
        value === 'response_too_large' ||
        value === 'stream_invalid' ||
        value === 'stream_truncated' ||
        value === 'prediction_invalid' ||
        value === 'telemetry_missing'
    );
}

function hasValidSamplePayload(value: Record<string, unknown>): boolean {
    if (
        typeof value.streamed !== 'boolean' ||
        typeof value.valid !== 'boolean' ||
        !isNonNegativeNumber(value.latencyMs) ||
        (value.rawAssistant !== undefined &&
            typeof value.rawAssistant !== 'string') ||
        (value.finishReason !== undefined &&
            typeof value.finishReason !== 'string') ||
        (value.usage !== undefined && !isBenchmarkUsage(value.usage)) ||
        (value.ttftMs !== undefined &&
            !isNonNegativeNumber(value.ttftMs)) ||
        (value.outputTokensPerSecond !== undefined &&
            !isNonNegativeNumber(value.outputTokensPerSecond)) ||
        (value.costUsd !== undefined && !isNonNegativeNumber(value.costUsd))
    ) {
        return false;
    }
    if (value.valid) {
        return (
            value.streamed &&
            typeof value.rawAssistant === 'string' &&
            isBenchmarkPrediction(value.prediction) &&
            typeof value.finishReason === 'string' &&
            isBenchmarkUsage(value.usage) &&
            isNonNegativeNumber(value.ttftMs) &&
            isNonNegativeNumber(value.outputTokensPerSecond) &&
            isNonNegativeNumber(value.costUsd) &&
            value.errorKind === undefined &&
            value.httpStatus === undefined
        );
    }
    return (
        isSampleErrorKind(value.errorKind) &&
        value.prediction === undefined &&
        (value.httpStatus === undefined ||
            (Number.isInteger(value.httpStatus) &&
                isNonNegativeNumber(value.httpStatus)))
    );
}

export function parseBenchmarkSample(value: unknown): BenchmarkSample {
    if (
        !isRecord(value) ||
        value.schemaVersion !== 2 ||
        typeof value.runKey !== 'string' ||
        typeof value.corpusId !== 'string' ||
        typeof value.corpusManifestSha256 !== 'string' ||
        value.harness !== DIRECT_API_HARNESS ||
        typeof value.model !== 'string' ||
        !BENCHMARK_REASONING_LEVELS.some(
            (level) => level === value.reasoning,
        ) ||
        !Number.isInteger(value.repeat) ||
        !isNonNegativeNumber(value.repeat) ||
        typeof value.videoId !== 'string' ||
        typeof value.languageCode !== 'string' ||
        typeof value.transcriptHash !== 'string' ||
        typeof value.fixtureSha256 !== 'string' ||
        typeof value.promptVersion !== 'string' ||
        typeof value.promptSha256 !== 'string' ||
        typeof value.messageSha256 !== 'string' ||
        value.outputLimitPolicy !== BENCHMARK_OUTPUT_LIMIT_POLICY ||
        typeof value.requestConfigSha256 !== 'string' ||
        !hasValidSamplePayload(value)
    ) {
        throw new Error('Benchmark sample is incomplete or malformed.');
    }
    return value as BenchmarkSample;
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new Error('Existing benchmark sample is not valid JSON.');
    }
}

function runKey(reasoning: BenchmarkReasoning): string {
    return `direct-api-v3-prompt-v4-${reasoning}-model-default`;
}

function samplePath(
    repoRoot: string,
    expected: ExpectedSample,
): string {
    return path.resolve(
        repoRoot,
        'benchmarks/promo-detection/runs',
        expected.runKey,
        'samples',
        expected.model,
        `repeat-${String(expected.repeat)}`,
        `${expected.videoId}.json`,
    );
}

function readExistingSample(
    filePath: string,
    expected: ExpectedSample,
): BenchmarkSample | undefined {
    if (!existsSync(filePath)) {
        return undefined;
    }
    const sample = parseBenchmarkSample(
        parseJson(readFileSync(filePath, 'utf8')),
    );
    if (
        sample.runKey !== expected.runKey ||
        sample.corpusId !== expected.corpusId ||
        sample.corpusManifestSha256 !== expected.corpusManifestSha256 ||
        sample.model !== expected.model ||
        sample.reasoning !== expected.reasoning ||
        sample.repeat !== expected.repeat ||
        sample.videoId !== expected.videoId ||
        sample.languageCode !== expected.languageCode ||
        sample.transcriptHash !== expected.transcriptHash ||
        sample.fixtureSha256 !== expected.fixtureSha256 ||
        sample.promptVersion !== expected.promptVersion ||
        sample.promptSha256 !== expected.promptSha256 ||
        sample.messageSha256 !== expected.messageSha256 ||
        sample.outputLimitPolicy !== expected.outputLimitPolicy ||
        sample.requestConfigSha256 !== expected.requestConfigSha256
    ) {
        throw new Error('Existing benchmark sample does not match the run.');
    }
    return sample;
}

function predictionFromCall(
    call: BenchmarkCallResult,
    durationSec: number,
): {
    valid: boolean;
    prediction?: BenchmarkPrediction;
    errorKind?: BenchmarkSampleErrorKind;
} {
    if (!call.ok) {
        return { valid: false, errorKind: call.errorKind };
    }
    if (
        !call.streamed ||
        call.finishReason === undefined ||
        call.usage === undefined ||
        call.ttftMs === undefined ||
        call.outputTokensPerSecond === undefined
    ) {
        return { valid: false, errorKind: 'telemetry_missing' };
    }
    const parsed = parseLlmPromoResponse(call.rawAssistant, durationSec);
    if (!parsed.ok) {
        return { valid: false, errorKind: 'prediction_invalid' };
    }
    if (!parsed.hasPromo) {
        return { valid: true, prediction: { hasPromo: false } };
    }
    return {
        valid: true,
        prediction: {
            hasPromo: true,
            promoBlocks: parsed.blocks.map((block) => ({ ...block })),
        },
    };
}

function createSample(options: {
    expected: ExpectedSample;
    durationSec: number;
    call: BenchmarkCallResult;
    costUsd?: number;
}): BenchmarkSample {
    const parsed = predictionFromCall(options.call, options.durationSec);
    const sample: BenchmarkSample = {
        schemaVersion: 2,
        ...options.expected,
        harness: DIRECT_API_HARNESS,
        streamed: options.call.ok ? options.call.streamed : true,
        valid: parsed.valid,
        latencyMs: options.call.latencyMs,
    };
    if (options.call.rawAssistant !== undefined) {
        sample.rawAssistant = options.call.rawAssistant;
    }
    if (parsed.prediction !== undefined) {
        sample.prediction = parsed.prediction;
    }
    if (parsed.errorKind !== undefined) {
        sample.errorKind = parsed.errorKind;
    }
    if (options.call.ok && options.call.finishReason !== undefined) {
        sample.finishReason = options.call.finishReason;
    }
    if (!options.call.ok && options.call.httpStatus !== undefined) {
        sample.httpStatus = options.call.httpStatus;
    }
    if (options.call.usage !== undefined) {
        sample.usage = options.call.usage;
    }
    if (options.call.ttftMs !== undefined) {
        sample.ttftMs = options.call.ttftMs;
    }
    if (
        options.call.ok &&
        options.call.outputTokensPerSecond !== undefined
    ) {
        sample.outputTokensPerSecond = options.call.outputTokensPerSecond;
    }
    if (options.costUsd !== undefined) {
        sample.costUsd = options.costUsd;
    }
    return sample;
}

export function writeJsonFileOnce(filePath: string, value: unknown): void {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const descriptor = openSync(filePath, 'wx', 0o644);
    try {
        writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    } finally {
        closeSync(descriptor);
    }
}

export function benchmarkRunKey(reasoning: BenchmarkReasoning): string {
    return runKey(reasoning);
}

export async function runBenchmarkMatrix(options: {
    repoRoot: string;
    preflight: BenchmarkPreflight;
    baseUrl: string;
    apiKey: string;
    fetchFunction?: typeof fetch;
    onProgress?: (progress: BenchmarkRunProgress) => void;
}): Promise<{ completed: number; resumed: number; total: number }> {
    const key = runKey(options.preflight.reasoning);
    const planned: Array<{
        filePath: string;
        expected: ExpectedSample;
        item: BenchmarkPreflight['manifest']['items'][number];
        model: BenchmarkPreflight['models'][number];
        messages: ReturnType<typeof buildBenchmarkMessages>;
        existing?: BenchmarkSample;
    }> = [];
    for (let repeat = 1; repeat <= BENCHMARK_REPEAT_COUNT; repeat += 1) {
        for (const item of options.preflight.manifest.items) {
            const messages = buildBenchmarkMessages(
                options.preflight.corpusRoot,
                item,
            );
            const messageSha256 = benchmarkMessageSha256(messages);
            for (const model of options.preflight.models) {
                const expected: ExpectedSample = {
                    runKey: key,
                    corpusId: options.preflight.manifest.corpusId,
                    corpusManifestSha256:
                        options.preflight.manifestSha256,
                    model: model.id,
                    reasoning: options.preflight.reasoning,
                    repeat,
                    videoId: item.videoId,
                    languageCode: item.languageCode,
                    transcriptHash: item.transcriptHash,
                    fixtureSha256: item.fixtureSha256,
                    promptVersion: options.preflight.promptVersion,
                    promptSha256: options.preflight.promptSha256,
                    messageSha256,
                    outputLimitPolicy: BENCHMARK_OUTPUT_LIMIT_POLICY,
                    requestConfigSha256:
                        options.preflight.requestConfigSha256,
                };
                const filePath = samplePath(options.repoRoot, expected);
                planned.push({
                    filePath,
                    expected,
                    item,
                    model,
                    messages,
                    existing: readExistingSample(filePath, expected),
                });
            }
        }
    }
    let completed = 0;
    let resumed = 0;
    for (const entry of planned) {
        if (entry.existing !== undefined) {
            completed += 1;
            resumed += 1;
            options.onProgress?.({
                completed,
                pending: planned.length - completed,
                total: planned.length,
                model: entry.model.id,
                videoId: entry.item.videoId,
                repeat: entry.expected.repeat,
                valid: entry.existing.valid,
                resumed: true,
            });
            continue;
        }
        const body = buildBenchmarkRequestBody({
            model: entry.model.id,
            messages: entry.messages,
            reasoning: options.preflight.reasoning,
        });
        const call = await callBenchmarkModel({
            baseUrl: options.baseUrl,
            apiKey: options.apiKey,
            body,
            fetchFunction: options.fetchFunction,
        });
        const costUsd =
            call.usage === undefined
                ? undefined
                : calculateUsageCostUsd(call.usage, entry.model.pricing);
        const sample = createSample({
            expected: entry.expected,
            durationSec: entry.item.videoDurationSec,
            call,
            costUsd,
        });
        writeJsonFileOnce(entry.filePath, sample);
        completed += 1;
        options.onProgress?.({
            completed,
            pending: planned.length - completed,
            total: planned.length,
            model: entry.model.id,
            videoId: entry.item.videoId,
            repeat: entry.expected.repeat,
            valid: sample.valid,
            resumed: false,
        });
    }
    return { completed, resumed, total: planned.length };
}
