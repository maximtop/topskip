import * as v from 'valibot';
import { randomUUID } from 'node:crypto';

import { LocalPromoAnalysisFixtureAdapter } from '@topskip/backend/analysis/local-analysis-fixtures';
import { OpenRouterGeminiAnalysisAdapter } from '@topskip/backend/analysis/openrouter-gemini-analysis-adapter';
import { normalizeBackendPromoBlocks } from '@topskip/backend/analysis/promo-block-normalization';
import { buildServerTranscriptChunks } from '@topskip/backend/analysis/promo-analysis-chunking';
import {
    BACKEND_ANALYSIS_FAILURE_REASON,
    backendAnalysisProviderIdSchema,
    analysisRunArtifactSchema,
    type AnalysisRunArtifact,
    type BackendAnalysisFailureReason,
    type BackendLlmAnalysisAdapter,
    type BackendLlmAnalysisAdapterResult,
    type BackendLlmAnalysisUsage,
    type ParsedModelPromoResult,
} from '@topskip/backend/analysis/promo-analysis-types';
import { parseBackendPromoResponse } from '@topskip/backend/analysis/promo-response-parser';
import type { TranscriptArtifact } from '@topskip/backend/extraction/subtitle-extraction-types';
import {
    legacyNoPromoResponseSchema,
    legacyReadyResponseSchema,
    legacyTerminalErrorResponseSchema,
    type LegacyServerAnalysisResponse,
} from '@topskip/backend/legacy/legacy-server-analysis-contract';
import {
    noPromoResponseSchema,
    readyResponseSchema,
    SERVER_ANALYSIS_ERROR_CODE,
    terminalErrorResponseSchema,
    type NoPromoResponse,
    type ReadyResponse,
    type TerminalErrorResponse,
} from '@topskip/common/server-analysis-contract';
import type { PromoBlock } from '@topskip/common/promo-types';
import { ChunkMerge } from '@topskip/common/promo-chunk-merge';
import { mergePromoBlocksWithGap } from '@topskip/common/promo-dedupe';
import {
    BLOCK_MERGE_GAP_SEC,
    CHUNK_BLOCK_TOLERANCE_SEC,
} from '@topskip/common/promo-chunking-config';
import { MS_PER_SECOND, SECONDS_PER_HOUR } from '@topskip/common/constants';

/**
 * Reanalysis window balances provider cost with eventual caption corrections.
 */
export const SERVER_ANALYSIS_RESULT_TTL_MS =
    30 * 24 * SECONDS_PER_HOUR * MS_PER_SECOND;

const INVALID_PROVIDER_METADATA_ID = 'invalid_provider_metadata';
const BACKEND_ANALYSIS_MODEL_MAX_LENGTH = 160;
const BACKEND_ANALYSIS_PROMPT_VERSION_MAX_LENGTH = 80;
const backendAnalysisAdapterMetadataSchema = v.strictObject({
    provider: backendAnalysisProviderIdSchema,
    model: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(BACKEND_ANALYSIS_MODEL_MAX_LENGTH),
    ),
    promptVersion: v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(BACKEND_ANALYSIS_PROMPT_VERSION_MAX_LENGTH),
    ),
});

/**
 * Worker input for one selected transcript analysis run.
 */
export type BackendPromoAnalysisWorkerInput = {
    transcriptArtifact: TranscriptArtifact;
    durationSec: number | undefined;
    nowMs: number;
    adapter?: BackendLlmAnalysisAdapter;
    clock?: () => number;
};

/**
 * Worker output always pairs the terminal response with retained run metadata.
 */
export type BackendPromoAnalysisWorkerResult = {
    terminalResponse:
        | ReadyResponse
        | NoPromoResponse
        | TerminalErrorResponse
        | Extract<
              LegacyServerAnalysisResponse,
              { status: 'ready' | 'no_promo' | 'error' }
          >;
    analysisRun: AnalysisRunArtifact;
};

/**
 * Converts a selected transcript artifact into a terminal server-analysis result.
 */
export class BackendPromoAnalysisWorker {
    /**
     * Runs deterministic analysis and records safe artifacts for diagnostics.
     *
     * @param input - Transcript, duration, clock, and optional adapter override.
     * @returns Terminal response plus stored analysis run metadata.
     */
    static async analyze(
        input: BackendPromoAnalysisWorkerInput,
    ): Promise<BackendPromoAnalysisWorkerResult> {
        const adapter =
            input.adapter ?? BackendPromoAnalysisWorker.defaultAdapter();
        const adapterMetadata =
            BackendPromoAnalysisWorker.validateAdapterMetadata(adapter);

        if (adapterMetadata === null) {
            return BackendPromoAnalysisWorker.providerError(input);
        }

        const chunkPlan = buildServerTranscriptChunks(
            input.transcriptArtifact.segments,
        );
        if (!chunkPlan.ok) {
            return BackendPromoAnalysisWorker.failure(input, {
                provider: adapterMetadata.provider,
                rawModelResponse: null,
                parsedResult: null,
                normalizedPromoBlocks: [],
                failureReason:
                    BACKEND_ANALYSIS_FAILURE_REASON.ModelProviderError,
                model: adapterMetadata.model,
                promptVersion: adapterMetadata.promptVersion,
                completedAtMs: BackendPromoAnalysisWorker.readClock(input),
            });
        }

        let mergedBlocks: PromoBlock[] = [];
        const rawResponses: string[] = [];
        let usage: BackendLlmAnalysisUsage | undefined;
        let model = adapterMetadata.model;

        for (const chunk of chunkPlan.chunks) {
            const chunkArtifact: TranscriptArtifact = {
                ...input.transcriptArtifact,
                segments: chunk.segments,
            };
            const attempt =
                await BackendPromoAnalysisWorker.analyzeChunkWithRetry(
                    adapter,
                    chunkArtifact,
                );
            if (!attempt.ok) {
                return BackendPromoAnalysisWorker.failure(input, {
                    provider: adapterMetadata.provider,
                    rawModelResponse: attempt.rawModelResponse,
                    parsedResult: null,
                    normalizedPromoBlocks: [],
                    failureReason: attempt.failureReason,
                    model,
                    promptVersion: adapterMetadata.promptVersion,
                    usage,
                    completedAtMs: BackendPromoAnalysisWorker.readClock(input),
                });
            }

            model = attempt.model;
            rawResponses.push(
                `[chunk ${String(chunk.index)} ${String(chunk.startSec)}-${String(chunk.endSec)}s]\n${attempt.rawModelResponse}`,
            );
            usage = BackendPromoAnalysisWorker.sumUsage(usage, attempt.usage);

            if (!attempt.parsedResult.hasPromo) {
                continue;
            }
            // Only trim interior chunk boundaries: a block outside a middle
            // chunk's caption span belongs to an adjacent overlapping chunk,
            // but the first chunk has no earlier neighbor and the last none
            // later, so their outer edges stay open. A single chunk is both,
            // so nothing is filtered — identical to whole-transcript analysis.
            const isFirstChunk = chunk.index === 0;
            const isLastChunk = chunk.index === chunkPlan.chunks.length - 1;
            const loSec = isFirstChunk
                ? Number.NEGATIVE_INFINITY
                : chunk.startSec;
            const hiSec = isLastChunk ? Number.POSITIVE_INFINITY : chunk.endSec;
            const filtered = ChunkMerge.filterPromoBlocksForChunkTimeRange(
                attempt.parsedResult.promoBlocks,
                loSec,
                hiSec,
                CHUNK_BLOCK_TOLERANCE_SEC,
            );
            mergedBlocks = mergePromoBlocksWithGap(
                [...mergedBlocks, ...filtered],
                BLOCK_MERGE_GAP_SEC,
            );
        }

        const completedAtMs = BackendPromoAnalysisWorker.readClock(input);
        const rawModelResponse =
            rawResponses.length > 0 ? rawResponses.join('\n\n') : null;
        const combinedParsedResult: ParsedModelPromoResult =
            mergedBlocks.length > 0
                ? { hasPromo: true, promoBlocks: mergedBlocks }
                : { hasPromo: false };

        if (!combinedParsedResult.hasPromo) {
            const analysisRun = BackendPromoAnalysisWorker.buildAnalysisRun(
                input,
                {
                    provider: adapterMetadata.provider,
                    rawModelResponse,
                    parsedResult: combinedParsedResult,
                    normalizedPromoBlocks: [],
                    failureReason: null,
                    model,
                    promptVersion: adapterMetadata.promptVersion,
                    usage,
                    completedAtMs,
                },
            );
            return {
                analysisRun,
                terminalResponse:
                    BackendPromoAnalysisWorker.buildNoPromoResponse(
                        input,
                        completedAtMs,
                    ),
            };
        }

        const normalized = normalizeBackendPromoBlocks({
            promoBlocks: combinedParsedResult.promoBlocks,
            durationSec: input.durationSec,
        });
        if (!normalized.ok) {
            return BackendPromoAnalysisWorker.failure(input, {
                provider: adapterMetadata.provider,
                rawModelResponse,
                parsedResult: combinedParsedResult,
                normalizedPromoBlocks: [],
                failureReason: normalized.failureReason,
                model,
                promptVersion: adapterMetadata.promptVersion,
                usage,
                completedAtMs,
            });
        }

        const analysisRun = BackendPromoAnalysisWorker.buildAnalysisRun(input, {
            provider: adapterMetadata.provider,
            rawModelResponse,
            parsedResult: combinedParsedResult,
            normalizedPromoBlocks: normalized.promoBlocks,
            failureReason: null,
            model,
            promptVersion: adapterMetadata.promptVersion,
            usage,
            completedAtMs,
        });
        return {
            analysisRun,
            terminalResponse: BackendPromoAnalysisWorker.buildReadyResponse(
                input,
                normalized.promoBlocks,
                completedAtMs,
            ),
        };
    }

    /**
     * One chunk analysis with a single retry; parse failures and provider
     * throws share the retry so a transient bad response cannot fail a
     * multi-minute job outright.
     *
     * @param adapter - Backend LLM adapter.
     * @param chunkArtifact - Transcript slice for this chunk.
     * @returns Parsed chunk outcome, or a stable failure after the retry.
     */
    private static async analyzeChunkWithRetry(
        adapter: BackendLlmAnalysisAdapter,
        chunkArtifact: TranscriptArtifact,
    ): Promise<
        | {
              ok: true;
              parsedResult: ParsedModelPromoResult;
              rawModelResponse: string;
              model: string;
              usage?: BackendLlmAnalysisUsage;
          }
        | {
              ok: false;
              failureReason: BackendAnalysisFailureReason;
              rawModelResponse: string | null;
          }
    > {
        let lastFailure:
            | {
                  failureReason: BackendAnalysisFailureReason;
                  rawModelResponse: string | null;
              }
            | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
            let adapterResult: BackendLlmAnalysisAdapterResult;
            try {
                adapterResult = await adapter.analyze({
                    transcriptArtifact: chunkArtifact,
                });
            } catch {
                lastFailure = {
                    failureReason:
                        BACKEND_ANALYSIS_FAILURE_REASON.ModelProviderError,
                    rawModelResponse: null,
                };
                continue;
            }
            const parsed = parseBackendPromoResponse(
                adapterResult.rawModelResponse,
            );
            if (!parsed.ok) {
                lastFailure = {
                    failureReason: parsed.failureReason,
                    rawModelResponse: adapterResult.rawModelResponse,
                };
                continue;
            }
            return {
                ok: true,
                parsedResult: parsed.parsedResult,
                rawModelResponse: adapterResult.rawModelResponse,
                model: adapterResult.model,
                usage: adapterResult.usage,
            };
        }
        return lastFailure !== undefined
            ? { ok: false, ...lastFailure }
            : {
                  ok: false,
                  failureReason:
                      BACKEND_ANALYSIS_FAILURE_REASON.ModelProviderError,
                  rawModelResponse: null,
              };
    }

    /**
     * Sums per-chunk provider usage; `costUsd` stays present when any chunk
     * reported one.
     *
     * @param prev - Running usage total, or `undefined` before the first chunk.
     * @param next - This chunk's usage, or `undefined` when the adapter omits it.
     * @returns Combined usage, or `undefined` when neither side has usage.
     */
    private static sumUsage(
        prev: BackendLlmAnalysisUsage | undefined,
        next: BackendLlmAnalysisUsage | undefined,
    ): BackendLlmAnalysisUsage | undefined {
        if (next === undefined) {
            return prev;
        }
        const base = prev ?? { inputTokens: 0, outputTokens: 0 };
        const combined: BackendLlmAnalysisUsage = {
            inputTokens: base.inputTokens + next.inputTokens,
            outputTokens: base.outputTokens + next.outputTokens,
        };
        if (base.costUsd !== undefined || next.costUsd !== undefined) {
            combined.costUsd = (base.costUsd ?? 0) + (next.costUsd ?? 0);
        }
        return combined;
    }

    /**
     * Keeps deterministic fixtures test-only while production always uses Gemini.
     *
     * @returns Environment-appropriate backend adapter.
     */
    private static defaultAdapter(): BackendLlmAnalysisAdapter {
        return process.env.NODE_ENV === 'test'
            ? LocalPromoAnalysisFixtureAdapter
            : OpenRouterGeminiAnalysisAdapter.createFromEnvironment();
    }

    /**
     * Uses an injected clock for deterministic tests and wall time in production.
     *
     * @param input - Worker input with optional clock override.
     * @returns Completion timestamp.
     */
    private static readClock(input: BackendPromoAnalysisWorkerInput): number {
        return input.clock?.() ?? Date.now();
    }

    /**
     * Keeps untrusted adapter metadata out of persisted analysis artifacts.
     *
     * @param adapter - Adapter-owned stable metadata and analysis behavior.
     * @returns Valid stable metadata, or `null` when unsafe.
     */
    private static validateAdapterMetadata(
        adapter: BackendLlmAnalysisAdapter,
    ): v.InferOutput<typeof backendAnalysisAdapterMetadataSchema> | null {
        const parsed = v.safeParse(backendAnalysisAdapterMetadataSchema, {
            provider: adapter.providerId,
            model: adapter.model,
            promptVersion: adapter.promptVersion,
        });
        if (!parsed.success) {
            return null;
        }
        return parsed.output;
    }

    /**
     * Builds the safe terminal response for invalid provider metadata.
     *
     * @param input - Transcript analysis input.
     * @returns Terminal provider error and diagnostic artifact.
     */
    private static providerError(
        input: BackendPromoAnalysisWorkerInput,
    ): BackendPromoAnalysisWorkerResult {
        return BackendPromoAnalysisWorker.failure(input, {
            provider: INVALID_PROVIDER_METADATA_ID,
            rawModelResponse: null,
            parsedResult: null,
            normalizedPromoBlocks: [],
            failureReason: BACKEND_ANALYSIS_FAILURE_REASON.ModelProviderError,
        });
    }

    /**
     * Builds a terminal error response with its matching failed analysis run.
     *
     * @param input - Transcript analysis input.
     * @param details - Safe run details to retain.
     * @returns Terminal error and diagnostic artifact.
     */
    private static failure(
        input: BackendPromoAnalysisWorkerInput,
        details: {
            provider: string;
            rawModelResponse: string | null;
            parsedResult: ParsedModelPromoResult | null;
            normalizedPromoBlocks: PromoBlock[];
            failureReason: BackendAnalysisFailureReason;
            model?: string;
            promptVersion?: string;
            usage?: BackendLlmAnalysisUsage;
            completedAtMs?: number;
        },
    ): BackendPromoAnalysisWorkerResult {
        return {
            analysisRun: BackendPromoAnalysisWorker.buildAnalysisRun(
                input,
                details,
            ),
            terminalResponse: BackendPromoAnalysisWorker.buildErrorResponse(
                input,
                details.failureReason,
            ),
        };
    }

    /**
     * Builds a validated retained analysis artifact.
     *
     * @param input - Transcript analysis input.
     * @param details - Model output, parsed output, and failure metadata.
     * @returns Validated analysis run artifact.
     */
    private static buildAnalysisRun(
        input: BackendPromoAnalysisWorkerInput,
        details: {
            provider: string;
            rawModelResponse: string | null;
            parsedResult: ParsedModelPromoResult | null;
            normalizedPromoBlocks: PromoBlock[];
            failureReason: BackendAnalysisFailureReason | null;
            model?: string;
            promptVersion?: string;
            usage?: BackendLlmAnalysisUsage;
            completedAtMs?: number;
        },
    ): AnalysisRunArtifact {
        return v.parse(analysisRunArtifactSchema, {
            runId: BackendPromoAnalysisWorker.buildRunId(),
            transcriptArtifactId: input.transcriptArtifact.artifactId,
            videoId: input.transcriptArtifact.videoId,
            algorithmVersion: input.transcriptArtifact.algorithmVersion,
            provider: details.provider,
            model: details.model,
            promptVersion: details.promptVersion,
            usage: details.usage,
            startedAtMs: input.nowMs,
            completedAtMs: details.completedAtMs ?? input.nowMs,
            rawModelResponse: details.rawModelResponse,
            parsedResult: details.parsedResult,
            normalizedPromoBlocks: details.normalizedPromoBlocks,
            failureReason: details.failureReason,
        });
    }

    /**
     * Builds a validated ready response from normalized blocks.
     *
     * @param input - Transcript analysis input.
     * @param promoBlocks - Safe sorted blocks to deliver.
     * @param completedAtMs - Completion time used to derive cache freshness.
     * @returns Ready terminal response.
     */
    private static buildReadyResponse(
        input: BackendPromoAnalysisWorkerInput,
        promoBlocks: PromoBlock[],
        completedAtMs: number,
    ):
        | ReadyResponse
        | Extract<LegacyServerAnalysisResponse, { status: 'ready' }> {
        const response = {
            status: 'ready',
            videoId: input.transcriptArtifact.videoId,
            algorithmVersion: input.transcriptArtifact.algorithmVersion,
            source: 'server_cache',
            sourceResultId: BackendPromoAnalysisWorker.buildSourceResultId(
                input.transcriptArtifact,
            ),
            freshness: {
                expiresAtMs: completedAtMs + SERVER_ANALYSIS_RESULT_TTL_MS,
            },
            promoBlocks,
        } as const;
        if (
            input.transcriptArtifact.sourceType === 'extension_caption_upload'
        ) {
            return v.parse(readyResponseSchema, {
                ...response,
                languageCode: input.transcriptArtifact.languageCode,
                transcriptHash: input.transcriptArtifact.transcriptHash,
            });
        }
        return v.parse(legacyReadyResponseSchema, response);
    }

    /**
     * Builds a validated no-promo terminal response.
     *
     * @param input - Transcript analysis input.
     * @param completedAtMs - Completion time used to derive cache freshness.
     * @returns No-promo terminal response.
     */
    private static buildNoPromoResponse(
        input: BackendPromoAnalysisWorkerInput,
        completedAtMs: number,
    ):
        | NoPromoResponse
        | Extract<LegacyServerAnalysisResponse, { status: 'no_promo' }> {
        const response = {
            status: 'no_promo',
            videoId: input.transcriptArtifact.videoId,
            algorithmVersion: input.transcriptArtifact.algorithmVersion,
            sourceResultId: BackendPromoAnalysisWorker.buildSourceResultId(
                input.transcriptArtifact,
            ),
            freshness: {
                expiresAtMs: completedAtMs + SERVER_ANALYSIS_RESULT_TTL_MS,
            },
        } as const;
        if (
            input.transcriptArtifact.sourceType === 'extension_caption_upload'
        ) {
            return v.parse(noPromoResponseSchema, {
                ...response,
                languageCode: input.transcriptArtifact.languageCode,
                transcriptHash: input.transcriptArtifact.transcriptHash,
            });
        }
        return v.parse(legacyNoPromoResponseSchema, response);
    }

    /**
     * Builds a validated terminal error response.
     *
     * @param input - Transcript analysis input.
     * @param failureReason - Stable failure reason to expose as an error code.
     * @returns Error terminal response.
     */
    private static buildErrorResponse(
        input: BackendPromoAnalysisWorkerInput,
        failureReason: BackendAnalysisFailureReason,
    ):
        | TerminalErrorResponse
        | Extract<LegacyServerAnalysisResponse, { status: 'error' }> {
        const response = {
            status: 'error',
            videoId: input.transcriptArtifact.videoId,
            algorithmVersion: input.transcriptArtifact.algorithmVersion,
            error: {
                code: BackendPromoAnalysisWorker.toTerminalErrorCode(
                    failureReason,
                ),
            },
        } as const;
        if (
            input.transcriptArtifact.sourceType === 'extension_caption_upload'
        ) {
            return v.parse(terminalErrorResponseSchema, {
                ...response,
                languageCode: input.transcriptArtifact.languageCode,
                transcriptHash: input.transcriptArtifact.transcriptHash,
            });
        }
        return v.parse(legacyTerminalErrorResponseSchema, response);
    }

    /**
     * Maps internal failure reasons onto the public terminal contract.
     *
     * @param failureReason - Stable backend analysis failure reason.
     * @returns Public terminal error code.
     */
    private static toTerminalErrorCode(
        failureReason: BackendAnalysisFailureReason,
    ): TerminalErrorResponse['error']['code'] {
        switch (failureReason) {
            case BACKEND_ANALYSIS_FAILURE_REASON.InvalidModelResponse:
                return SERVER_ANALYSIS_ERROR_CODE.InvalidModelResponse;
            case BACKEND_ANALYSIS_FAILURE_REASON.UnsafeModelBlocks:
                return SERVER_ANALYSIS_ERROR_CODE.UnsafeModelBlocks;
            case BACKEND_ANALYSIS_FAILURE_REASON.ModelProviderError:
                return SERVER_ANALYSIS_ERROR_CODE.ModelProviderError;
        }
    }

    /**
     * Builds the retained analysis run id.
     *
     * @returns Opaque analysis run id that reveals no transcript identity.
     */
    private static buildRunId(): string {
        return `analysis-${randomUUID()}`;
    }

    /**
     * Builds the source result id shared by terminal status responses.
     *
     * @param transcriptArtifact - Transcript consumed by the run.
     * @returns Stable source result id.
     */
    private static buildSourceResultId(
        transcriptArtifact: TranscriptArtifact,
    ): string {
        return transcriptArtifact.sourceType === 'extension_caption_upload'
            ? `result-${randomUUID()}`
            : `result-${transcriptArtifact.videoId}-${transcriptArtifact.algorithmVersion}`;
    }
}
