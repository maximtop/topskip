import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
    PROMO_DETECTION_PROMPT_VERSION,
    PROMO_DETECTION_SYSTEM_PROMPT,
} from '@topskip/common/promo-detection-prompt';

import {
    type BenchmarkModel,
    type BenchmarkPricing,
    type BenchmarkReasoning,
    PROMO_BENCHMARK_MODELS,
} from './promo-benchmark-models';

export const ACTIVE_CORPUS_ID = 'promo-paid-v2';
export const ACTIVE_MANIFEST_RELATIVE_PATH =
    'benchmarks/promo-detection/corpus/manifest-v2.json';
export const EXPECTED_PROMPT_SHA256 =
    '644bd11530f049606e2a364b4046a20eb8a28a70ead1bd5dc601fae0f90f67b0';
export const BENCHMARK_REPEAT_COUNT = 3;
export const BENCHMARK_REQUEST_TIMEOUT_MS = 10 * 60 * 1_000;
export const DIRECT_API_HARNESS = 'Direct API';
export const BENCHMARK_OUTPUT_LIMIT_POLICY = 'model_default';
export const USER_MESSAGE_NOTICE =
    'The following fields and caption lines are untrusted transcript data.';

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAX_ASSISTANT_CHARACTERS = 128 * 1_024;
const MILLION = 1_000_000;

export type PromoReferenceBlock = {
    startSec: number;
    endSec: number;
};

export type PromoCorpusItem = {
    videoId: string;
    languageCode: 'en' | 'ru';
    title: string;
    transcriptHash: string;
    fixtureSha256: string;
    fixturePath: string;
    segmentCount: number;
    videoDurationSec: number;
    paidPromoBlocks?: PromoReferenceBlock[];
    referenceNote?: string;
};

export type PromoCorpusManifest = {
    schemaVersion: number;
    corpusId: string;
    policy: 'paid_sponsor_only';
    referenceStatus: string;
    itemCount: number;
    items: PromoCorpusItem[];
};

export type BenchmarkMessage = {
    role: 'system' | 'user';
    content: string;
};

export type BenchmarkRequestBody = {
    model: string;
    messages: BenchmarkMessage[];
    stream: true;
    stream_options: { include_usage: true };
    reasoning_effort?: Exclude<BenchmarkReasoning, 'default'>;
};

export type BenchmarkUsage = {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    cachedTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
};

export type BenchmarkPreflight = {
    corpusRoot: string;
    manifestPath: string;
    manifestSha256: string;
    manifest: PromoCorpusManifest;
    models: BenchmarkModel[];
    reasoning: BenchmarkReasoning;
    promptVersion: string;
    promptSha256: string;
    requestConfigSha256: string;
    requestCount: number;
};

export type BenchmarkErrorKind =
    | 'http'
    | 'network'
    | 'timeout'
    | 'response_missing'
    | 'response_too_large'
    | 'stream_invalid'
    | 'stream_truncated';

export type BenchmarkCallSuccess = {
    ok: true;
    streamed: boolean;
    rawAssistant: string;
    finishReason?: string;
    usage?: BenchmarkUsage;
    ttftMs?: number;
    latencyMs: number;
    outputTokensPerSecond?: number;
};

export type BenchmarkCallFailure = {
    ok: false;
    errorKind: BenchmarkErrorKind;
    httpStatus?: number;
    rawAssistant?: string;
    usage?: BenchmarkUsage;
    ttftMs?: number;
    latencyMs: number;
};

export type BenchmarkCallResult =
    | BenchmarkCallSuccess
    | BenchmarkCallFailure;

type ParsedStream = {
    ok: boolean;
    rawAssistant: string;
    finishReason?: string;
    usage?: BenchmarkUsage;
    ttftMs?: number;
    errorKind?: BenchmarkErrorKind;
};

type ParsedCompletion = {
    rawAssistant: string;
    finishReason?: string;
    usage?: BenchmarkUsage;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
    const number = finiteNumber(value);
    return number !== undefined && Number.isInteger(number) && number >= 0
        ? number
        : undefined;
}

function parseReferenceBlock(
    value: unknown,
    label: string,
): PromoReferenceBlock {
    if (!isRecord(value)) {
        throw new Error(`${label} must be an object.`);
    }
    const startSec = finiteNumber(value.startSec);
    const endSec = finiteNumber(value.endSec);
    if (startSec === undefined || endSec === undefined || endSec <= startSec) {
        throw new Error(`${label} has invalid boundaries.`);
    }
    return { startSec, endSec };
}

function parseCorpusItem(value: unknown, index: number): PromoCorpusItem {
    if (!isRecord(value)) {
        throw new Error(`Manifest item ${String(index)} must be an object.`);
    }
    const languageCode = value.languageCode;
    const videoDurationSec = finiteNumber(value.videoDurationSec);
    if (
        typeof value.videoId !== 'string' ||
        (languageCode !== 'en' && languageCode !== 'ru') ||
        typeof value.title !== 'string' ||
        typeof value.transcriptHash !== 'string' ||
        !SHA256_PATTERN.test(value.transcriptHash) ||
        typeof value.fixtureSha256 !== 'string' ||
        !SHA256_PATTERN.test(value.fixtureSha256) ||
        typeof value.fixturePath !== 'string' ||
        !Number.isInteger(value.segmentCount) ||
        typeof value.segmentCount !== 'number' ||
        value.segmentCount <= 0 ||
        videoDurationSec === undefined ||
        videoDurationSec <= 0
    ) {
        throw new Error(`Manifest item ${String(index)} is malformed.`);
    }
    let paidPromoBlocks: PromoReferenceBlock[] | undefined;
    if (value.paidPromoBlocks !== undefined) {
        if (!Array.isArray(value.paidPromoBlocks)) {
            throw new Error(`Manifest item ${String(index)} has bad references.`);
        }
        paidPromoBlocks = value.paidPromoBlocks.map((block, blockIndex) =>
            parseReferenceBlock(
                block,
                `Manifest item ${String(index)} block ${String(blockIndex)}`,
            ),
        );
    }
    const item: PromoCorpusItem = {
        videoId: value.videoId,
        languageCode,
        title: value.title,
        transcriptHash: value.transcriptHash,
        fixtureSha256: value.fixtureSha256,
        fixturePath: value.fixturePath,
        segmentCount: value.segmentCount,
        videoDurationSec,
    };
    if (paidPromoBlocks !== undefined) {
        item.paidPromoBlocks = paidPromoBlocks;
    }
    if (typeof value.referenceNote === 'string') {
        item.referenceNote = value.referenceNote;
    }
    return item;
}

function parseManifest(value: unknown): PromoCorpusManifest {
    if (
        !isRecord(value) ||
        value.schemaVersion !== 1 ||
        typeof value.corpusId !== 'string' ||
        value.policy !== 'paid_sponsor_only' ||
        typeof value.referenceStatus !== 'string' ||
        !Number.isInteger(value.itemCount) ||
        typeof value.itemCount !== 'number' ||
        !Array.isArray(value.items)
    ) {
        throw new Error('Corpus manifest is malformed.');
    }
    const items = value.items.map(parseCorpusItem);
    if (items.length !== value.itemCount) {
        throw new Error('Corpus itemCount does not match its items.');
    }
    return {
        schemaVersion: 1,
        corpusId: value.corpusId,
        policy: 'paid_sponsor_only',
        referenceStatus: value.referenceStatus,
        itemCount: value.itemCount,
        items,
    };
}

function parseJson(text: string, label: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new Error(`${label} is not valid JSON.`);
    }
}

function parseCaptionStarts(fixture: string): Set<number> {
    const starts = new Set<number>();
    for (const line of fixture.trimEnd().split('\n')) {
        const match = /^\[([0-9]+(?:\.[0-9]+)?)\] /u.exec(line);
        if (match === null) {
            throw new Error('Timed transcript contains a malformed line.');
        }
        starts.add(Number(match[1]));
    }
    return starts;
}

function validateFixturePath(corpusRoot: string, relativePath: string): string {
    const resolved = path.resolve(corpusRoot, relativePath);
    const requiredPrefix = `${path.resolve(corpusRoot)}${path.sep}`;
    if (!resolved.startsWith(requiredPrefix)) {
        throw new Error('Corpus fixture path escapes the corpus directory.');
    }
    if (!existsSync(resolved)) {
        throw new Error(`Missing corpus fixture: ${relativePath}.`);
    }
    return resolved;
}

function validateManifestFixtures(
    corpusRoot: string,
    manifest: PromoCorpusManifest,
): void {
    const videoIds = new Set<string>();
    const transcriptHashes = new Set<string>();
    for (const item of manifest.items) {
        if (videoIds.has(item.videoId)) {
            throw new Error(`Duplicate corpus video: ${item.videoId}.`);
        }
        if (transcriptHashes.has(item.transcriptHash)) {
            throw new Error(`Duplicate transcript hash: ${item.videoId}.`);
        }
        videoIds.add(item.videoId);
        transcriptHashes.add(item.transcriptHash);
        const fixturePath = validateFixturePath(corpusRoot, item.fixturePath);
        const fixture = readFileSync(fixturePath, 'utf8');
        if (sha256(fixture) !== item.fixtureSha256) {
            throw new Error(`Fixture hash mismatch: ${item.videoId}.`);
        }
        const starts = parseCaptionStarts(fixture);
        if (starts.size !== item.segmentCount) {
            throw new Error(`Fixture segment count mismatch: ${item.videoId}.`);
        }
        for (const block of item.paidPromoBlocks ?? []) {
            if (!starts.has(block.startSec) || !starts.has(block.endSec)) {
                throw new Error(
                    `Reference is not caption-aligned: ${item.videoId}.`,
                );
            }
        }
    }
}

function parseUsage(value: unknown): BenchmarkUsage | undefined {
    if (!isRecord(value)) {
        return undefined;
    }
    const promptTokens = nonNegativeInteger(value.prompt_tokens);
    const completionTokens = nonNegativeInteger(value.completion_tokens);
    const totalTokens = nonNegativeInteger(value.total_tokens);
    if (
        promptTokens === undefined ||
        completionTokens === undefined ||
        totalTokens === undefined
    ) {
        return undefined;
    }
    const promptDetails = isRecord(value.prompt_tokens_details)
        ? value.prompt_tokens_details
        : undefined;
    const completionDetails = isRecord(value.completion_tokens_details)
        ? value.completion_tokens_details
        : undefined;
    return {
        promptTokens,
        completionTokens,
        totalTokens,
        cachedTokens:
            nonNegativeInteger(promptDetails?.cached_tokens) ??
            nonNegativeInteger(value.cached_tokens) ??
            0,
        cacheWriteTokens:
            nonNegativeInteger(promptDetails?.cache_write_tokens) ??
            nonNegativeInteger(value.cache_write_tokens) ??
            0,
        reasoningTokens:
            nonNegativeInteger(completionDetails?.reasoning_tokens) ??
            nonNegativeInteger(value.reasoning_tokens) ??
            0,
    };
}

function parseCompletion(value: unknown): ParsedCompletion | undefined {
    if (!isRecord(value) || !Array.isArray(value.choices)) {
        return undefined;
    }
    const choices: unknown[] = value.choices;
    const first: unknown = choices[0];
    if (!isRecord(first) || !isRecord(first.message)) {
        return undefined;
    }
    const content = first.message.content;
    if (typeof content !== 'string') {
        return undefined;
    }
    const parsed: ParsedCompletion = {
        rawAssistant: content,
        usage: parseUsage(value.usage),
    };
    if (typeof first.finish_reason === 'string') {
        parsed.finishReason = first.finish_reason;
    }
    return parsed;
}

function appendAssistantContent(current: string, addition: string): string {
    const nextLength = current.length + addition.length;
    if (nextLength > MAX_ASSISTANT_CHARACTERS) {
        throw new Error('response_too_large');
    }
    return `${current}${addition}`;
}

function processSseData(
    data: string,
    state: {
        assistant: string;
        done: boolean;
        finishReason?: string;
        usage?: BenchmarkUsage;
        ttftMs?: number;
    },
    startedAt: number,
    now: () => number,
): void {
    if (data === '[DONE]') {
        state.done = true;
        return;
    }
    const value = parseJson(data, 'Streaming chunk');
    if (!isRecord(value)) {
        throw new Error('stream_invalid');
    }
    const usage = parseUsage(value.usage);
    if (usage !== undefined) {
        state.usage = usage;
    }
    if (!Array.isArray(value.choices) || value.choices.length === 0) {
        return;
    }
    const choices: unknown[] = value.choices;
    const first: unknown = choices[0];
    if (!isRecord(first)) {
        throw new Error('stream_invalid');
    }
    if (typeof first.finish_reason === 'string') {
        state.finishReason = first.finish_reason;
    }
    if (!isRecord(first.delta) || typeof first.delta.content !== 'string') {
        return;
    }
    const content = first.delta.content;
    if (content.length === 0) {
        return;
    }
    if (state.ttftMs === undefined) {
        state.ttftMs = Math.max(0, now() - startedAt);
    }
    state.assistant = appendAssistantContent(state.assistant, content);
}

async function readSseResponse(
    response: Response,
    startedAt: number,
    now: () => number,
): Promise<ParsedStream> {
    if (response.body === null) {
        return {
            ok: false,
            rawAssistant: '',
            errorKind: 'response_missing',
        };
    }
    const state: {
        assistant: string;
        done: boolean;
        finishReason?: string;
        usage?: BenchmarkUsage;
        ttftMs?: number;
    } = { assistant: '', done: false };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) {
                buffer += decoder.decode();
                break;
            }
            buffer += decoder.decode(chunk.value, { stream: true });
            let newlineIndex = buffer.indexOf('\n');
            while (newlineIndex >= 0) {
                const line = buffer.slice(0, newlineIndex).trimEnd();
                buffer = buffer.slice(newlineIndex + 1);
                if (line.startsWith('data:')) {
                    processSseData(
                        line.slice('data:'.length).trimStart(),
                        state,
                        startedAt,
                        now,
                    );
                }
                newlineIndex = buffer.indexOf('\n');
            }
        }
        const finalLine = buffer.trim();
        if (finalLine.startsWith('data:')) {
            processSseData(
                finalLine.slice('data:'.length).trimStart(),
                state,
                startedAt,
                now,
            );
        }
    } catch (error) {
        const errorKind =
            error instanceof Error && error.message === 'response_too_large'
                ? 'response_too_large'
                : 'stream_invalid';
        return {
            ok: false,
            rawAssistant: state.assistant,
            usage: state.usage,
            ttftMs: state.ttftMs,
            errorKind,
        };
    }
    if (!state.done) {
        return {
            ok: false,
            rawAssistant: state.assistant,
            usage: state.usage,
            ttftMs: state.ttftMs,
            errorKind: 'stream_truncated',
        };
    }
    return {
        ok: true,
        rawAssistant: state.assistant,
        finishReason: state.finishReason,
        usage: state.usage,
        ttftMs: state.ttftMs,
    };
}

function outputTokensPerSecond(
    usage: BenchmarkUsage | undefined,
    ttftMs: number | undefined,
    latencyMs: number,
): number | undefined {
    if (usage === undefined || ttftMs === undefined || latencyMs <= ttftMs) {
        return undefined;
    }
    return usage.completionTokens / ((latencyMs - ttftMs) / 1_000);
}

function buildChatCompletionsUrl(baseUrl: string): string {
    const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
    return new URL('chat/completions', normalized).toString();
}

export function sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
}

export function loadCorpusManifest(manifestPath: string): PromoCorpusManifest {
    const text = readFileSync(manifestPath, 'utf8');
    const manifest = parseManifest(parseJson(text, 'Corpus manifest'));
    validateManifestFixtures(path.dirname(manifestPath), manifest);
    return manifest;
}

export function selectBenchmarkModels(
    requestedIds: readonly string[],
): BenchmarkModel[] {
    const requested = new Set(requestedIds);
    if (requested.size !== requestedIds.length) {
        throw new Error('Duplicate --model values are not allowed.');
    }
    const selected =
        requestedIds.length === 0
            ? [...PROMO_BENCHMARK_MODELS]
            : PROMO_BENCHMARK_MODELS.filter((model) =>
                    requested.has(model.id),
                );
    if (selected.length !== requestedIds.length && requestedIds.length > 0) {
        throw new Error('Unknown benchmark model requested.');
    }
    return selected;
}

export function runBenchmarkPreflight(options: {
    repoRoot: string;
    requestedModelIds: readonly string[];
    reasoning: BenchmarkReasoning;
}): BenchmarkPreflight {
    const manifestPath = path.resolve(
        options.repoRoot,
        ACTIVE_MANIFEST_RELATIVE_PATH,
    );
    const manifestText = readFileSync(manifestPath, 'utf8');
    const manifest = parseManifest(parseJson(manifestText, 'Corpus manifest'));
    const corpusRoot = path.dirname(manifestPath);
    if (
        manifest.corpusId !== ACTIVE_CORPUS_ID ||
        manifest.referenceStatus !== 'curated_from_timed_captions' ||
        manifest.items.some((item) => item.paidPromoBlocks === undefined)
    ) {
        throw new Error('Active corpus does not have curated references.');
    }
    const englishCount = manifest.items.filter(
        (item) => item.languageCode === 'en',
    ).length;
    const russianCount = manifest.items.filter(
        (item) => item.languageCode === 'ru',
    ).length;
    if (manifest.itemCount !== 10 || englishCount !== 5 || russianCount !== 5) {
        throw new Error('Active corpus must contain five EN and five RU items.');
    }
    validateManifestFixtures(corpusRoot, manifest);
    const promptSha256 = sha256(PROMO_DETECTION_SYSTEM_PROMPT);
    if (
        PROMO_DETECTION_PROMPT_VERSION !== '4' ||
        promptSha256 !== EXPECTED_PROMPT_SHA256
    ) {
        throw new Error('Promo prompt version or hash changed.');
    }
    const models = selectBenchmarkModels(options.requestedModelIds);
    if (options.reasoning !== 'default') {
        for (const model of models) {
            if (!model.supportedReasoning.includes(options.reasoning)) {
                throw new Error('Requested reasoning is unsupported.');
            }
        }
    }
    return {
        corpusRoot,
        manifestPath,
        manifestSha256: sha256(manifestText),
        manifest,
        models,
        reasoning: options.reasoning,
        promptVersion: PROMO_DETECTION_PROMPT_VERSION,
        promptSha256,
        requestConfigSha256: benchmarkRequestConfigSha256(
            options.reasoning,
        ),
        requestCount:
            models.length * manifest.itemCount * BENCHMARK_REPEAT_COUNT,
    };
}

export function buildBenchmarkMessages(
    corpusRoot: string,
    item: PromoCorpusItem,
): BenchmarkMessage[] {
    const fixturePath = validateFixturePath(corpusRoot, item.fixturePath);
    const fixture = readFileSync(fixturePath, 'utf8').trimEnd();
    const user = [
        USER_MESSAGE_NOTICE,
        `videoId=${item.videoId}`,
        `language=${item.languageCode}`,
        '',
        fixture,
    ].join('\n');
    return [
        { role: 'system', content: PROMO_DETECTION_SYSTEM_PROMPT },
        { role: 'user', content: user },
    ];
}

export function benchmarkMessageSha256(
    messages: readonly BenchmarkMessage[],
): string {
    return sha256(
        messages.map((message) => `${message.role}\0${message.content}`).join(
            '\0',
        ),
    );
}

export function benchmarkRequestConfigSha256(
    reasoning: BenchmarkReasoning,
): string {
    return sha256(
        JSON.stringify({
            stream: true,
            includeUsage: true,
            outputLimit: BENCHMARK_OUTPUT_LIMIT_POLICY,
            reasoning,
        }),
    );
}

export function buildBenchmarkRequestBody(options: {
    model: string;
    messages: BenchmarkMessage[];
    reasoning: BenchmarkReasoning;
}): BenchmarkRequestBody {
    const body: BenchmarkRequestBody = {
        model: options.model,
        messages: options.messages,
        stream: true,
        stream_options: { include_usage: true },
    };
    if (options.reasoning !== 'default') {
        body.reasoning_effort = options.reasoning;
    }
    return body;
}

export function validateBenchmarkApiEnvironment(options: {
    baseUrl: string | undefined;
    apiKey: string | undefined;
}): { baseUrl: string; apiKey: string } {
    const baseUrl = options.baseUrl?.trim() ?? '';
    const apiKey = options.apiKey?.trim() ?? '';
    if (baseUrl.length === 0 || apiKey.length === 0) {
        throw new Error('Benchmark API environment is incomplete.');
    }
    let parsed: URL;
    try {
        parsed = new URL(baseUrl);
    } catch {
        throw new Error('Benchmark API base URL is invalid.');
    }
    if (parsed.protocol !== 'https:') {
        throw new Error('Benchmark API base URL must use HTTPS.');
    }
    return { baseUrl, apiKey };
}

export function calculateUsageCostUsd(
    usage: BenchmarkUsage,
    pricing: BenchmarkPricing,
): number {
    const cachedTokens = Math.min(usage.cachedTokens, usage.promptTokens);
    const cacheWriteTokens = Math.min(
        usage.cacheWriteTokens,
        usage.promptTokens - cachedTokens,
    );
    const uncachedTokens = Math.max(
        usage.promptTokens - cachedTokens - cacheWriteTokens,
        0,
    );
    const reasoningTokens = Math.min(
        usage.reasoningTokens,
        usage.completionTokens,
    );
    const visibleOutputTokens = Math.max(
        usage.completionTokens - reasoningTokens,
        0,
    );
    const cost =
        uncachedTokens * pricing.inputPerMillion +
        cachedTokens * pricing.cacheReadPerMillion +
        cacheWriteTokens * pricing.cacheWritePerMillion +
        visibleOutputTokens * pricing.outputPerMillion +
        reasoningTokens * pricing.reasoningPerMillion;
    return cost / MILLION;
}

export async function callBenchmarkModel(options: {
    baseUrl: string;
    apiKey: string;
    body: BenchmarkRequestBody;
    fetchFunction?: typeof fetch;
    now?: () => number;
    timeoutMs?: number;
}): Promise<BenchmarkCallResult> {
    const fetchFunction = options.fetchFunction ?? fetch;
    const now = options.now ?? performance.now.bind(performance);
    const controller = new AbortController();
    const startedAt = now();
    const timeoutId = setTimeout(
        () => controller.abort(),
        options.timeoutMs ?? BENCHMARK_REQUEST_TIMEOUT_MS,
    );
    try {
        const response = await fetchFunction(
            buildChatCompletionsUrl(options.baseUrl),
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${options.apiKey}`,
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(options.body),
                signal: controller.signal,
            },
        );
        if (!response.ok) {
            await response.body?.cancel();
            return {
                ok: false,
                errorKind: 'http',
                httpStatus: response.status,
                latencyMs: Math.max(0, now() - startedAt),
            };
        }
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.includes('text/event-stream')) {
            const text = await response.text();
            if (text.length > MAX_ASSISTANT_CHARACTERS) {
                return {
                    ok: false,
                    errorKind: 'response_too_large',
                    latencyMs: Math.max(0, now() - startedAt),
                };
            }
            const completion = parseCompletion(
                parseJson(text, 'Completion response'),
            );
            const latencyMs = Math.max(0, now() - startedAt);
            if (completion === undefined) {
                return {
                    ok: false,
                    errorKind: 'response_missing',
                    latencyMs,
                };
            }
            return {
                ok: true,
                streamed: false,
                ...completion,
                latencyMs,
            };
        }
        const parsed = await readSseResponse(response, startedAt, now);
        const latencyMs = Math.max(0, now() - startedAt);
        if (!parsed.ok) {
            return {
                ok: false,
                errorKind: parsed.errorKind ?? 'stream_invalid',
                rawAssistant: parsed.rawAssistant,
                usage: parsed.usage,
                ttftMs: parsed.ttftMs,
                latencyMs,
            };
        }
        return {
            ok: true,
            streamed: true,
            rawAssistant: parsed.rawAssistant,
            finishReason: parsed.finishReason,
            usage: parsed.usage,
            ttftMs: parsed.ttftMs,
            latencyMs,
            outputTokensPerSecond: outputTokensPerSecond(
                parsed.usage,
                parsed.ttftMs,
                latencyMs,
            ),
        };
    } catch (error) {
        return {
            ok: false,
            errorKind:
                controller.signal.aborted ||
                (error instanceof Error && error.name === 'AbortError')
                    ? 'timeout'
                    : 'network',
            latencyMs: Math.max(0, now() - startedAt),
        };
    } finally {
        clearTimeout(timeoutId);
    }
}
