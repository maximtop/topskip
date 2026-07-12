import * as v from 'valibot';

import { LocalPromoAnalysisFixtureAdapter } from '@/backend/analysis/local-analysis-fixtures';
import { normalizeBackendPromoBlocks } from '@/backend/analysis/promo-block-normalization';
import {
    BACKEND_ANALYSIS_FAILURE_REASON,
    backendAnalysisProviderIdSchema,
    analysisRunArtifactSchema,
    type AnalysisRunArtifact,
    type BackendAnalysisFailureReason,
    type BackendLlmAnalysisAdapter,
    type ParsedModelPromoResult,
} from '@/backend/analysis/promo-analysis-types';
import { parseBackendPromoResponse } from '@/backend/analysis/promo-response-parser';
import type { TranscriptArtifact } from '@/backend/extraction/subtitle-extraction-types';
import {
    noPromoResponseSchema,
    readyResponseSchema,
    SERVER_ANALYSIS_ERROR_CODE,
    terminalErrorResponseSchema,
    type NoPromoResponse,
    type ReadyResponse,
    type TerminalErrorResponse,
} from '@/shared/server-analysis-contract';
import type { PromoBlock } from '@/shared/promo-types';

/**
 * Long-lived local freshness keeps deterministic fixture responses reusable in tests.
 */
export const LOCAL_ANALYSIS_RESULT_EXPIRES_AT_MS = 4_102_444_800_000;

const INVALID_PROVIDER_METADATA_ID = 'invalid_provider_metadata';

/**
 * Worker input for one selected transcript analysis run.
 */
export type BackendPromoAnalysisWorkerInput = {
    transcriptArtifact: TranscriptArtifact;
    durationSec: number | undefined;
    nowMs: number;
    adapter?: BackendLlmAnalysisAdapter;
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
    static analyze(
        input: BackendPromoAnalysisWorkerInput,
    ): BackendPromoAnalysisWorkerResult {
        const adapter = input.adapter ?? LocalPromoAnalysisFixtureAdapter;
        const provider = BackendPromoAnalysisWorker.validateProviderId(
            adapter.providerId,
        );

        if (provider === null) {
            return BackendPromoAnalysisWorker.providerError(input);
        }

        let rawModelResponse: string;
        try {
            rawModelResponse = adapter.analyze({
                transcriptArtifact: input.transcriptArtifact,
            });
        } catch {
            return BackendPromoAnalysisWorker.failure(input, {
                provider,
                rawModelResponse: null,
                parsedResult: null,
                normalizedPromoBlocks: [],
                failureReason:
                    BACKEND_ANALYSIS_FAILURE_REASON.ModelProviderError,
            });
        }

        const parsed = parseBackendPromoResponse(rawModelResponse);
        if (!parsed.ok) {
            return BackendPromoAnalysisWorker.failure(input, {
                provider,
                rawModelResponse,
                parsedResult: null,
                normalizedPromoBlocks: [],
                failureReason: parsed.failureReason,
            });
        }

        if (!parsed.parsedResult.hasPromo) {
            const analysisRun = BackendPromoAnalysisWorker.buildAnalysisRun(
                input,
                {
                    provider,
                    rawModelResponse,
                    parsedResult: parsed.parsedResult,
                    normalizedPromoBlocks: [],
                    failureReason: null,
                },
            );
            return {
                analysisRun,
                terminalResponse:
                    BackendPromoAnalysisWorker.buildNoPromoResponse(input),
            };
        }

        const normalized = normalizeBackendPromoBlocks({
            promoBlocks: parsed.parsedResult.promoBlocks,
            durationSec: input.durationSec,
        });
        if (!normalized.ok) {
            return BackendPromoAnalysisWorker.failure(input, {
                provider,
                rawModelResponse,
                parsedResult: parsed.parsedResult,
                normalizedPromoBlocks: [],
                failureReason: normalized.failureReason,
            });
        }

        const analysisRun = BackendPromoAnalysisWorker.buildAnalysisRun(input, {
            provider,
            rawModelResponse,
            parsedResult: parsed.parsedResult,
            normalizedPromoBlocks: normalized.promoBlocks,
            failureReason: null,
        });
        return {
            analysisRun,
            terminalResponse: BackendPromoAnalysisWorker.buildReadyResponse(
                input,
                normalized.promoBlocks,
            ),
        };
    }

    /**
     * Keeps untrusted adapter metadata out of persisted analysis artifacts.
     *
     * @param providerId - Adapter-owned provider id.
     * @returns Valid provider id, or `null` when unsafe.
     */
    private static validateProviderId(providerId: string): string | null {
        const parsed = v.safeParse(backendAnalysisProviderIdSchema, providerId);
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
            startedAtMs: input.nowMs,
            completedAtMs: input.nowMs,
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
     * @returns Ready terminal response.
     */
    private static buildReadyResponse(
        input: BackendPromoAnalysisWorkerInput,
        promoBlocks: PromoBlock[],
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
                expiresAtMs: LOCAL_ANALYSIS_RESULT_EXPIRES_AT_MS,
            },
            promoBlocks,
        });
    }

    /**
     * Builds a validated no-promo terminal response.
     *
     * @param input - Transcript analysis input.
     * @returns No-promo terminal response.
     */
    private static buildNoPromoResponse(
        input: BackendPromoAnalysisWorkerInput,
    ): NoPromoResponse {
        return v.parse(noPromoResponseSchema, {
            status: 'no_promo',
            videoId: input.transcriptArtifact.videoId,
            algorithmVersion: input.transcriptArtifact.algorithmVersion,
            sourceResultId: BackendPromoAnalysisWorker.buildSourceResultId(
                input.transcriptArtifact,
            ),
            freshness: {
                expiresAtMs: LOCAL_ANALYSIS_RESULT_EXPIRES_AT_MS,
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
                message:
                    BackendPromoAnalysisWorker.toTerminalErrorMessage(
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
     * Keeps user-facing model failures concise and free of provider details.
     *
     * @param failureReason - Stable backend analysis failure reason.
     * @returns User-safe terminal message.
     */
    private static toTerminalErrorMessage(
        failureReason: BackendAnalysisFailureReason,
    ): string {
        switch (failureReason) {
            case BACKEND_ANALYSIS_FAILURE_REASON.InvalidModelResponse:
                return 'Model returned an invalid promo response.';
            case BACKEND_ANALYSIS_FAILURE_REASON.UnsafeModelBlocks:
                return 'Model returned unsafe promo blocks.';
            case BACKEND_ANALYSIS_FAILURE_REASON.ModelProviderError:
                return 'Model analysis failed.';
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
