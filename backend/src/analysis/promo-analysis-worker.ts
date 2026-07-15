import * as v from 'valibot';

import { LocalPromoAnalysisFixtureAdapter } from '@topskip/backend/analysis/local-analysis-fixtures';
import { OpenRouterGeminiAnalysisAdapter } from '@topskip/backend/analysis/openrouter-gemini-analysis-adapter';
import { normalizeBackendPromoBlocks } from '@topskip/backend/analysis/promo-block-normalization';
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
    noPromoResponseSchema,
    readyResponseSchema,
    SERVER_ANALYSIS_ERROR_CODE,
    terminalErrorResponseSchema,
    type NoPromoResponse,
    type ReadyResponse,
    type TerminalErrorResponse,
} from '@topskip/common/server-analysis-contract';
import type { PromoBlock } from '@topskip/common/promo-types';
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
    terminalResponse: ReadyResponse | NoPromoResponse | TerminalErrorResponse;
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

        let adapterResult: BackendLlmAnalysisAdapterResult;
        try {
            adapterResult = await adapter.analyze({
                transcriptArtifact: input.transcriptArtifact,
            });
        } catch {
            const completedAtMs = BackendPromoAnalysisWorker.readClock(input);
            return BackendPromoAnalysisWorker.failure(input, {
                provider: adapterMetadata.provider,
                rawModelResponse: null,
                parsedResult: null,
                normalizedPromoBlocks: [],
                failureReason:
                    BACKEND_ANALYSIS_FAILURE_REASON.ModelProviderError,
                model: adapterMetadata.model,
                promptVersion: adapterMetadata.promptVersion,
                completedAtMs,
            });
        }

        const completedAtMs = BackendPromoAnalysisWorker.readClock(input);
        const rawModelResponse = adapterResult.rawModelResponse;

        const parsed = parseBackendPromoResponse(rawModelResponse);
        if (!parsed.ok) {
            return BackendPromoAnalysisWorker.failure(input, {
                provider: adapterMetadata.provider,
                rawModelResponse,
                parsedResult: null,
                normalizedPromoBlocks: [],
                failureReason: parsed.failureReason,
                model: adapterResult.model,
                promptVersion: adapterMetadata.promptVersion,
                usage: adapterResult.usage,
                completedAtMs,
            });
        }

        if (!parsed.parsedResult.hasPromo) {
            const analysisRun = BackendPromoAnalysisWorker.buildAnalysisRun(
                input,
                {
                    provider: adapterMetadata.provider,
                    rawModelResponse,
                    parsedResult: parsed.parsedResult,
                    normalizedPromoBlocks: [],
                    failureReason: null,
                    model: adapterResult.model,
                    promptVersion: adapterMetadata.promptVersion,
                    usage: adapterResult.usage,
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
            promoBlocks: parsed.parsedResult.promoBlocks,
            durationSec: input.durationSec,
        });
        if (!normalized.ok) {
            return BackendPromoAnalysisWorker.failure(input, {
                provider: adapterMetadata.provider,
                rawModelResponse,
                parsedResult: parsed.parsedResult,
                normalizedPromoBlocks: [],
                failureReason: normalized.failureReason,
                model: adapterResult.model,
                promptVersion: adapterMetadata.promptVersion,
                usage: adapterResult.usage,
                completedAtMs,
            });
        }

        const analysisRun = BackendPromoAnalysisWorker.buildAnalysisRun(input, {
            provider: adapterMetadata.provider,
            rawModelResponse,
            parsedResult: parsed.parsedResult,
            normalizedPromoBlocks: normalized.promoBlocks,
            failureReason: null,
            model: adapterResult.model,
            promptVersion: adapterMetadata.promptVersion,
            usage: adapterResult.usage,
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
            runId: BackendPromoAnalysisWorker.buildRunId(
                input.transcriptArtifact,
                details.provider,
            ),
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
    ): ReadyResponse {
        return v.parse(readyResponseSchema, {
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
        });
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
    ): NoPromoResponse {
        return v.parse(noPromoResponseSchema, {
            status: 'no_promo',
            videoId: input.transcriptArtifact.videoId,
            algorithmVersion: input.transcriptArtifact.algorithmVersion,
            sourceResultId: BackendPromoAnalysisWorker.buildSourceResultId(
                input.transcriptArtifact,
            ),
            freshness: {
                expiresAtMs: completedAtMs + SERVER_ANALYSIS_RESULT_TTL_MS,
            },
        });
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
    ): TerminalErrorResponse {
        return v.parse(terminalErrorResponseSchema, {
            status: 'error',
            videoId: input.transcriptArtifact.videoId,
            algorithmVersion: input.transcriptArtifact.algorithmVersion,
            error: {
                code: BackendPromoAnalysisWorker.toTerminalErrorCode(
                    failureReason,
                ),
            },
        });
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
     * @param transcriptArtifact - Transcript consumed by the run.
     * @param provider - Validated provider id.
     * @returns Deterministic analysis run id.
     */
    private static buildRunId(
        transcriptArtifact: TranscriptArtifact,
        provider: string,
    ): string {
        return [
            'analysis',
            transcriptArtifact.videoId,
            transcriptArtifact.algorithmVersion,
            provider,
        ].join('-');
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
        return `result-${transcriptArtifact.videoId}-${transcriptArtifact.algorithmVersion}`;
    }
}
