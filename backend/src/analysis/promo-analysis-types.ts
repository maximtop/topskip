import * as v from 'valibot';

import type { TranscriptArtifact } from '@topskip/backend/extraction/subtitle-extraction-types';
import {
    promoBlockSchema,
    youtubeVideoIdSchema,
} from '@topskip/common/server-analysis-contract';

const finiteEpochMsSchema = v.pipe(
    v.number(),
    v.check(
        (value) => Number.isFinite(value),
        'Epoch milliseconds must be finite.',
    ),
    v.integer(),
    v.minValue(1),
);

const parsedModelPromoResultSchema = v.union([
    v.strictObject({
        hasPromo: v.literal(false),
        confidence: v.optional(v.picklist(['low', 'medium', 'high'] as const)),
    }),
    v.strictObject({
        hasPromo: v.literal(true),
        promoBlocks: v.pipe(v.array(promoBlockSchema), v.minLength(1)),
    }),
]);

const analysisRunUsageSchema = v.strictObject({
    inputTokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
    outputTokens: v.pipe(v.number(), v.integer(), v.minValue(0)),
    costUsd: v.optional(v.pipe(v.number(), v.minValue(0))),
});

/**
 * Provider IDs are bounded so analysis artifacts can store adapter metadata safely.
 */
export const BACKEND_ANALYSIS_PROVIDER_ID_MAX_LENGTH = 80;

/**
 * Built-in provider IDs owned by the local backend analysis layer.
 */
export const BACKEND_ANALYSIS_PROVIDER_ID = {
    LocalFixture: 'local_fixture_llm',
    OpenRouter: 'openrouter',
} as const;

/**
 * Validates adapter-owned provider metadata before it is stored on a run.
 */
export const backendAnalysisProviderIdSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(BACKEND_ANALYSIS_PROVIDER_ID_MAX_LENGTH),
);

/**
 * Stable analysis failure reasons avoid storing raw provider exception details.
 */
export const BACKEND_ANALYSIS_FAILURE_REASON = {
    InvalidModelResponse: 'invalid_model_response',
    UnsafeModelBlocks: 'unsafe_model_blocks',
    ModelProviderError: 'model_provider_error',
} as const;

const backendAnalysisFailureReasonSchema = v.picklist([
    BACKEND_ANALYSIS_FAILURE_REASON.InvalidModelResponse,
    BACKEND_ANALYSIS_FAILURE_REASON.UnsafeModelBlocks,
    BACKEND_ANALYSIS_FAILURE_REASON.ModelProviderError,
] as const);

/**
 * Validates one retained backend analysis run artifact.
 */
export const analysisRunArtifactSchema = v.strictObject({
    runId: v.pipe(v.string(), v.minLength(1)),
    transcriptArtifactId: v.pipe(v.string(), v.minLength(1)),
    videoId: youtubeVideoIdSchema,
    algorithmVersion: v.pipe(v.string(), v.minLength(1)),
    provider: backendAnalysisProviderIdSchema,
    model: v.optional(v.pipe(v.string(), v.minLength(1))),
    promptVersion: v.optional(v.pipe(v.string(), v.minLength(1))),
    usage: v.optional(analysisRunUsageSchema),
    startedAtMs: finiteEpochMsSchema,
    completedAtMs: finiteEpochMsSchema,
    rawModelResponse: v.nullable(v.pipe(v.string(), v.minLength(1))),
    parsedResult: v.nullable(parsedModelPromoResultSchema),
    normalizedPromoBlocks: v.array(promoBlockSchema),
    failureReason: v.nullable(backendAnalysisFailureReasonSchema),
});

/**
 * Input passed to backend-owned analysis adapters.
 */
export type BackendLlmAnalysisAdapterInput = {
    transcriptArtifact: TranscriptArtifact;
};

/**
 * Provider accounting retained without storing request credentials or reasoning text.
 */
export type BackendLlmAnalysisUsage = {
    inputTokens: number;
    outputTokens: number;
    costUsd?: number;
};

/**
 * Adapter output couples the raw assistant JSON with stable model diagnostics.
 */
export type BackendLlmAnalysisAdapterResult = {
    rawModelResponse: string;
    model: string;
    usage?: BackendLlmAnalysisUsage;
};

/**
 * Backend-only adapter boundary for deterministic or future model analysis.
 */
export type BackendLlmAnalysisAdapter = {
    providerId: string;
    model: string;
    promptVersion: string;
    analyze: (
        input: BackendLlmAnalysisAdapterInput,
    ) => Promise<BackendLlmAnalysisAdapterResult>;
};

/**
 * Parsed model result retained after raw response validation.
 */
export type ParsedModelPromoResult = v.InferOutput<
    typeof parsedModelPromoResultSchema
>;

/**
 * Stored backend analysis run artifact.
 */
export type AnalysisRunArtifact = v.InferOutput<
    typeof analysisRunArtifactSchema
>;

/**
 * Stable failure reason stored on failed analysis runs.
 */
export type BackendAnalysisFailureReason = v.InferOutput<
    typeof backendAnalysisFailureReasonSchema
>;
