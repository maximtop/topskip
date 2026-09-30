/**
 * @file Drives the promo-detection benchmark matrix: calls each configured model against
 * the benchmark corpus, validates and persists one JSON sample per (model, video, repeat),
 * and resumes a run by skipping samples that already exist on disk.
 */

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

/**
 * Model prediction decoded from an assistant response: either no promo detected, or one
 * or more promo blocks with their time ranges.
 */
export type BenchmarkPrediction = | { hasPromo: false }
    | {
        hasPromo: true;
        promoBlocks: {
            startSec: number;
            endSec?: number | undefined;
            confidence?: string | undefined;
        }[];
    };

/**
 * Reason a benchmark sample failed, extending the call-level error kinds with failures
 * specific to decoding and validating the model's prediction.
 */
export type BenchmarkSampleErrorKind = | BenchmarkErrorKind
    | 'prediction_invalid'
    | 'telemetry_missing';

/**
 * One persisted result of running a single model against a single corpus item and repeat.
 * Written to disk as one JSON file per sample; `schemaVersion` gates the on-disk format.
 */
export interface BenchmarkSample {
    /**
     * On-disk schema version; only `2` is currently accepted.
     */
    schemaVersion: 2;

    /**
     * Identifies the benchmark run configuration (prompt/harness/reasoning combination).
     */
    runKey: string;

    /**
     * Identifier of the corpus the sample was generated from.
     */
    corpusId: string;

    /**
     * SHA-256 of the corpus manifest, pinning the exact corpus content used.
     */
    corpusManifestSha256: string;

    /**
     * Benchmark harness that produced this sample, currently always the direct-API harness.
     */
    harness: typeof DIRECT_API_HARNESS;

    /**
     * Identifier of the model that produced this sample.
     */
    model: string;

    /**
     * Reasoning effort level requested from the model for this sample.
     */
    reasoning: BenchmarkReasoning;

    /**
     * 1-based repeat index of this sample within the run (see `BENCHMARK_REPEAT_COUNT`).
     */
    repeat: number;

    /**
     * Identifier of the corpus video this sample was generated for.
     */
    videoId: string;

    /**
     * Language code of the transcript used for this sample.
     */
    languageCode: string;

    /**
     * Hash of the transcript text that produced the benchmark messages.
     */
    transcriptHash: string;

    /**
     * SHA-256 of the corpus fixture file backing this sample.
     */
    fixtureSha256: string;

    /**
     * Version of the promo-detection prompt used to build the request.
     */
    promptVersion: string;

    /**
     * SHA-256 of the promo-detection prompt text used to build the request.
     */
    promptSha256: string;

    /**
     * SHA-256 of the serialized benchmark messages sent to the model.
     */
    messageSha256: string;

    /**
     * Output token limit policy applied to the request.
     */
    outputLimitPolicy: typeof BENCHMARK_OUTPUT_LIMIT_POLICY;

    /**
     * SHA-256 of the serialized request body configuration, excluding messages.
     */
    requestConfigSha256: string;

    /**
     * Whether the call used streaming; `true` for any failed call whose streaming mode
     * could not be determined.
     */
    streamed: boolean;

    /**
     * Whether the call succeeded and produced a usable prediction and telemetry.
     */
    valid: boolean;

    /**
     * Raw assistant response text, present whenever the call returned a response body.
     */
    rawAssistant?: string;

    /**
     * Decoded model prediction, present only when `valid` is `true`.
     */
    prediction?: BenchmarkPrediction;

    /**
     * Finish reason reported by the model, present only for successful calls.
     */
    finishReason?: string;

    /**
     * Reason the sample is invalid, present only when `valid` is `false`.
     */
    errorKind?: BenchmarkSampleErrorKind;

    /**
     * HTTP status code of a failed call, present only for HTTP-level failures.
     */
    httpStatus?: number;

    /**
     * Token usage reported by the model, present whenever the call returned usage data.
     */
    usage?: BenchmarkUsage;

    /**
     * Time to first token in milliseconds, present only for successful streamed calls.
     */
    ttftMs?: number;

    /**
     * Total call latency in milliseconds.
     */
    latencyMs: number;

    /**
     * Output tokens per second, present only for successful calls.
     */
    outputTokensPerSecond?: number;

    /**
     * Estimated cost of the call in USD, present whenever pricing and usage were available.
     */
    costUsd?: number;
}

/**
 * Progress snapshot reported to `runBenchmarkMatrix`'s `onProgress` callback after each
 * planned sample is either resumed from disk or freshly generated.
 */
export interface BenchmarkRunProgress {
    /**
     * Number of samples completed so far, including resumed ones.
     */
    completed: number;

    /**
     * Number of samples still to process.
     */
    pending: number;

    /**
     * Total number of samples planned for the run.
     */
    total: number;

    /**
     * Model identifier of the sample just completed.
     */
    model: string;

    /**
     * Video identifier of the sample just completed.
     */
    videoId: string;

    /**
     * Repeat index of the sample just completed.
     */
    repeat: number;

    /**
     * Whether the completed sample was valid; absent when the sample outcome is unknown.
     */
    valid?: boolean;

    /**
     * Whether this sample was resumed from an existing file rather than freshly generated.
     */
    resumed: boolean;
}

/**
 * Identity and provenance fields a benchmark sample must match to be reused across a resumed
 * run; used to detect a stale on-disk sample from a different corpus, prompt or request config.
 */
interface ExpectedSample {
    /**
     * Identifies the benchmark run configuration (prompt/harness/reasoning combination).
     */
    runKey: string;

    /**
     * Identifier of the corpus the sample must have been generated from.
     */
    corpusId: string;

    /**
     * SHA-256 of the corpus manifest, pinning the exact corpus content expected.
     */
    corpusManifestSha256: string;

    /**
     * Identifier of the model expected to have produced the sample.
     */
    model: string;

    /**
     * Reasoning effort level expected to have been requested from the model.
     */
    reasoning: BenchmarkReasoning;

    /**
     * 1-based repeat index expected for the sample.
     */
    repeat: number;

    /**
     * Identifier of the corpus video expected for the sample.
     */
    videoId: string;

    /**
     * Language code of the transcript expected for the sample.
     */
    languageCode: string;

    /**
     * Hash of the transcript text expected to have produced the benchmark messages.
     */
    transcriptHash: string;

    /**
     * SHA-256 of the corpus fixture file expected to back the sample.
     */
    fixtureSha256: string;

    /**
     * Version of the promo-detection prompt expected to have built the request.
     */
    promptVersion: string;

    /**
     * SHA-256 of the promo-detection prompt text expected to have built the request.
     */
    promptSha256: string;

    /**
     * SHA-256 of the serialized benchmark messages expected to have been sent to the model.
     */
    messageSha256: string;

    /**
     * Output token limit policy expected to have been applied to the request.
     */
    outputLimitPolicy: typeof BENCHMARK_OUTPUT_LIMIT_POLICY;

    /**
     * SHA-256 of the serialized request body configuration expected for the sample.
     */
    requestConfigSha256: string;
}

/**
 * Narrows a value to a plain object (excluding arrays and `null`).
 *
 * @param value - Value to check.
 *
 * @returns Whether `value` is a non-array, non-null object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Narrows a value to a finite number that is zero or greater.
 *
 * @param value - Value to check.
 *
 * @returns Whether `value` is a finite non-negative number.
 */
function isNonNegativeNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Narrows a value to a well-formed `BenchmarkUsage` payload.
 *
 * @param value - Value to check.
 *
 * @returns Whether `value` has all required usage fields as non-negative integers.
 */
function isBenchmarkUsage(value: unknown): value is BenchmarkUsage {
    return (
        isRecord(value)
        && Number.isInteger(value.promptTokens)
        && isNonNegativeNumber(value.promptTokens)
        && Number.isInteger(value.completionTokens)
        && isNonNegativeNumber(value.completionTokens)
        && Number.isInteger(value.totalTokens)
        && isNonNegativeNumber(value.totalTokens)
        && Number.isInteger(value.cachedTokens)
        && isNonNegativeNumber(value.cachedTokens)
        && Number.isInteger(value.cacheWriteTokens)
        && isNonNegativeNumber(value.cacheWriteTokens)
        && Number.isInteger(value.reasoningTokens)
        && isNonNegativeNumber(value.reasoningTokens)
    );
}

/**
 * Narrows a value to a well-formed `BenchmarkPrediction` payload.
 *
 * @param value - Value to check.
 *
 * @returns Whether `value` is a valid no-promo prediction or a promo prediction whose
 * blocks all have a non-negative start, and, when present, an end after the start and a
 * string confidence.
 */
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
        (block) => isRecord(block)
            && isNonNegativeNumber(block.startSec)
            && (block.endSec === undefined
                || (isNonNegativeNumber(block.endSec)
                    && block.endSec > block.startSec))
            && (block.confidence === undefined
                || typeof block.confidence === 'string'),
    );
}

/**
 * Narrows a value to one of the known `BenchmarkSampleErrorKind` string literals.
 *
 * @param value - Value to check.
 *
 * @returns Whether `value` is a recognized sample error kind.
 */
function isSampleErrorKind(value: unknown): value is BenchmarkSampleErrorKind {
    return (
        value === 'http'
        || value === 'network'
        || value === 'timeout'
        || value === 'response_missing'
        || value === 'response_too_large'
        || value === 'stream_invalid'
        || value === 'stream_truncated'
        || value === 'prediction_invalid'
        || value === 'telemetry_missing'
    );
}

/**
 * Checks the outcome fields of a candidate sample (streaming/validity/telemetry/error info),
 * without checking the identity fields checked separately by `parseBenchmarkSample`.
 *
 * @param value - Candidate sample object.
 *
 * @returns Whether the outcome fields are internally consistent for a valid or a failed sample.
 */
function hasValidSamplePayload(value: Record<string, unknown>): boolean {
    if (
        typeof value.streamed !== 'boolean'
        || typeof value.valid !== 'boolean'
        || !isNonNegativeNumber(value.latencyMs)
        || (value.rawAssistant !== undefined
            && typeof value.rawAssistant !== 'string')
        || (value.finishReason !== undefined
            && typeof value.finishReason !== 'string')
        || (value.usage !== undefined && !isBenchmarkUsage(value.usage))
        || (value.ttftMs !== undefined
            && !isNonNegativeNumber(value.ttftMs))
        || (value.outputTokensPerSecond !== undefined
            && !isNonNegativeNumber(value.outputTokensPerSecond))
        || (value.costUsd !== undefined && !isNonNegativeNumber(value.costUsd))
    ) {
        return false;
    }
    if (value.valid) {
        return (
            value.streamed
            && typeof value.rawAssistant === 'string'
            && isBenchmarkPrediction(value.prediction)
            && typeof value.finishReason === 'string'
            && isBenchmarkUsage(value.usage)
            && isNonNegativeNumber(value.ttftMs)
            && isNonNegativeNumber(value.outputTokensPerSecond)
            && isNonNegativeNumber(value.costUsd)
            && value.errorKind === undefined
            && value.httpStatus === undefined
        );
    }
    return (
        isSampleErrorKind(value.errorKind)
        && value.prediction === undefined
        && (value.httpStatus === undefined
            || (Number.isInteger(value.httpStatus)
                && isNonNegativeNumber(value.httpStatus)))
    );
}

/**
 * Narrows a value to a well-formed `BenchmarkSample` payload.
 *
 * @param value - Decoded JSON value, typically read from an on-disk sample file.
 *
 * @returns Whether `value` has every required field, correctly typed and internally
 * consistent.
 */
function isValidBenchmarkSample(value: unknown): value is BenchmarkSample {
    return (
        isRecord(value)
        && value.schemaVersion === 2
        && typeof value.runKey === 'string'
        && typeof value.corpusId === 'string'
        && typeof value.corpusManifestSha256 === 'string'
        && value.harness === DIRECT_API_HARNESS
        && typeof value.model === 'string'
        && BENCHMARK_REASONING_LEVELS.some(
            (level) => level === value.reasoning,
        )
        && Number.isInteger(value.repeat)
        && isNonNegativeNumber(value.repeat)
        && typeof value.videoId === 'string'
        && typeof value.languageCode === 'string'
        && typeof value.transcriptHash === 'string'
        && typeof value.fixtureSha256 === 'string'
        && typeof value.promptVersion === 'string'
        && typeof value.promptSha256 === 'string'
        && typeof value.messageSha256 === 'string'
        && value.outputLimitPolicy === BENCHMARK_OUTPUT_LIMIT_POLICY
        && typeof value.requestConfigSha256 === 'string'
        && hasValidSamplePayload(value)
    );
}

/**
 * Validates and narrows an arbitrary JSON value into a well-formed `BenchmarkSample`.
 *
 * @param value - Decoded JSON value, typically read from an on-disk sample file.
 *
 * @returns The value, narrowed to `BenchmarkSample`.
 *
 * @throws {Error} When any required field is missing, malformed or internally inconsistent.
 */
export function parseBenchmarkSample(value: unknown): BenchmarkSample {
    if (!isValidBenchmarkSample(value)) {
        throw new Error('Benchmark sample is incomplete or malformed.');
    }
    return value;
}

/**
 * Parses JSON text read from an existing sample file on disk.
 *
 * @param text - Raw file contents.
 *
 * @returns The decoded JSON value.
 *
 * @throws {Error} When `text` is not valid JSON.
 */
function parseJson(text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new Error('Existing benchmark sample is not valid JSON.');
    }
}

/**
 * Builds the run key identifying the current harness/prompt/reasoning configuration.
 *
 * @param reasoning - Reasoning effort level requested for the run.
 *
 * @returns The run key string.
 */
function runKey(reasoning: BenchmarkReasoning): string {
    return `direct-api-v3-prompt-v4-${reasoning}-model-default`;
}

/**
 * Resolves the on-disk path for a sample's JSON file.
 *
 * @param repoRoot - Absolute path to the repository root.
 * @param expected - Identity fields of the sample the path is being resolved for.
 *
 * @returns Absolute path to the sample's JSON file.
 */
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

/**
 * Reads and validates a previously written sample file, if one exists, so a resumed run
 * can skip regenerating it.
 *
 * @param filePath - Absolute path to the sample's JSON file.
 * @param expected - Identity fields the existing sample must match to be reused.
 *
 * @returns The existing sample, or `undefined` when no file exists at `filePath`.
 *
 * @throws {Error} When a file exists at `filePath` but its identity fields do not match `expected`.
 */
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
        sample.runKey !== expected.runKey
        || sample.corpusId !== expected.corpusId
        || sample.corpusManifestSha256 !== expected.corpusManifestSha256
        || sample.model !== expected.model
        || sample.reasoning !== expected.reasoning
        || sample.repeat !== expected.repeat
        || sample.videoId !== expected.videoId
        || sample.languageCode !== expected.languageCode
        || sample.transcriptHash !== expected.transcriptHash
        || sample.fixtureSha256 !== expected.fixtureSha256
        || sample.promptVersion !== expected.promptVersion
        || sample.promptSha256 !== expected.promptSha256
        || sample.messageSha256 !== expected.messageSha256
        || sample.outputLimitPolicy !== expected.outputLimitPolicy
        || sample.requestConfigSha256 !== expected.requestConfigSha256
    ) {
        throw new Error('Existing benchmark sample does not match the run.');
    }
    return sample;
}

/**
 * Derives the sample's validity, prediction and error kind from a completed model call.
 *
 * @param call - Result of the model call.
 * @param durationSec - Duration of the source video in seconds, used to validate predicted blocks.
 *
 * @returns Validity plus, depending on outcome, a decoded prediction or an error kind.
 */
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
        !call.streamed
        || call.finishReason === undefined
        || call.usage === undefined
        || call.ttftMs === undefined
        || call.outputTokensPerSecond === undefined
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

/**
 * Assembles a complete `BenchmarkSample` from a call's identity, outcome and cost, omitting
 * any optional field whose source value is `undefined`.
 *
 * @param options - Sample identity, the completed call, and its estimated cost.
 * @param options.expected - Identity fields to stamp onto the sample.
 * @param options.durationSec - Duration of the source video in seconds.
 * @param options.call - Result of the model call.
 * @param options.costUsd - Estimated cost of the call in USD, when computable.
 *
 * @returns The assembled sample.
 */
function createSample(options: {
    expected: ExpectedSample;
    durationSec: number;
    call: BenchmarkCallResult;
    costUsd?: number | undefined;
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
        options.call.ok
        && options.call.outputTokensPerSecond !== undefined
    ) {
        sample.outputTokensPerSecond = options.call.outputTokensPerSecond;
    }
    if (options.costUsd !== undefined) {
        sample.costUsd = options.costUsd;
    }
    return sample;
}

/**
 * Writes JSON to `filePath`, creating parent directories as needed and refusing to
 * overwrite a file that already exists.
 *
 * @param filePath - Absolute path to write.
 * @param value - Value to serialize as pretty-printed JSON.
 */
export function writeJsonFileOnce(filePath: string, value: unknown): void {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const descriptor = openSync(filePath, 'wx', 0o644);
    try {
        writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    } finally {
        closeSync(descriptor);
    }
}

/**
 * Public accessor for the run key of the current harness/prompt/reasoning configuration.
 *
 * @param reasoning - Reasoning effort level requested for the run.
 *
 * @returns The run key string.
 */
export function benchmarkRunKey(reasoning: BenchmarkReasoning): string {
    return runKey(reasoning);
}

/**
 * Runs the full benchmark matrix (every model x every corpus item x every repeat),
 * resuming from any samples already written to disk and writing a new sample file for
 * each remaining combination.
 *
 * @param options - Run configuration, credentials and progress callback.
 * @param options.repoRoot - Absolute path to the repository root, used to resolve sample paths.
 * @param options.preflight - Preflight result describing the corpus, models and prompt to use.
 * @param options.baseUrl - Base URL of the model API.
 * @param options.apiKey - API key used to authenticate model calls.
 * @param options.fetchFunction - Fetch implementation override, mainly for tests.
 * @param options.onProgress - Callback invoked after each sample is resumed or completed.
 *
 * @returns Counts of completed, resumed and total planned samples.
 */
export async function runBenchmarkMatrix(options: {
    repoRoot: string;
    preflight: BenchmarkPreflight;
    baseUrl: string;
    apiKey: string;
    fetchFunction?: typeof fetch;
    onProgress?: (progress: BenchmarkRunProgress) => void;
}): Promise<{ completed: number; resumed: number; total: number }> {
    const key = runKey(options.preflight.reasoning);
    const planned: {
        filePath: string;
        expected: ExpectedSample;
        item: BenchmarkPreflight['manifest']['items'][number];
        model: BenchmarkPreflight['models'][number];
        messages: ReturnType<typeof buildBenchmarkMessages>;
        existing?: BenchmarkSample | undefined;
    }[] = [];
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
        } else {
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
            const costUsd = call.usage === undefined
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
    }
    return { completed, resumed, total: planned.length };
}
