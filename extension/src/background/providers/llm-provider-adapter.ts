/**
 * @file Provider-agnostic contract, shared roles and result types for
 * LLM-backed transcript analysis adapters.
 */

import type { PROVIDER_AVAILABILITY } from '@/shared/chrome-prompt-api';
import type { ProviderId } from '@/shared/providers';
import type { PromoBlock } from '@topskip/common/promo-types';

export { PROVIDER_AVAILABILITY } from '@/shared/chrome-prompt-api';
export { PROVIDER_ID, type ProviderId } from '@/shared/providers';

/**
 * Whether the provider is ready to run analysis.
 */
export type ProviderAvailability = (typeof PROVIDER_AVAILABILITY)[keyof typeof PROVIDER_AVAILABILITY];

/**
 * LLM chat role literals used by all provider adapters.
 *
 * Centralised here so both the OpenRouter and Chrome Prompt API adapters
 * reference the same values rather than repeating inline string literals.
 */
export const LLM_ROLE = {
    /**
     * System-level prompt role.
     */
    System: 'system',

    /**
     * User-turn prompt role.
     */
    User: 'user',
} as const;

/**
 * Metadata about the provider that ran an analysis (for logging).
 */
export interface ProviderMeta {
    /**
     * Provider id that ran the analysis.
     */
    id: ProviderId;

    /**
     * Model name or slug used for the call.
     */
    model: string;
}

/**
 * Extension-owned provider failures that must not become generic LLM errors.
 */
export const PROVIDER_ANALYSIS_FAILURE_CODE = {
    HostAccessRequired: 'host_access_required',
} as const;

/**
 * Safe diagnostic shared by adapters when Chrome no longer grants a host.
 */
export const PROVIDER_HOST_ACCESS_REQUIRED_ERROR = 'Provider host access is required';

/**
 * A revoked optional host grant stops BYOK analysis before provider I/O.
 */
export interface ProviderHostAccessRequiredAnalysisResult {
    /**
     * Always `false`: the call never reached the provider.
     */
    ok: false;

    /**
     * Discriminates this result from an ordinary provider/parsing failure.
     */
    failureCode: typeof PROVIDER_ANALYSIS_FAILURE_CODE.HostAccessRequired;

    /**
     * Safe diagnostic message ({@link PROVIDER_HOST_ACCESS_REQUIRED_ERROR}).
     */
    error: string;

    /**
     * Never set for this result variant.
     */
    tooLarge?: never;

    /**
     * Never set for this result variant.
     */
    rawAssistant?: never;

    /**
     * Never set for this result variant.
     */
    status?: never;

    /**
     * Never set for this result variant.
     */
    kind?: never;
}

/**
 * Ordinary provider and parsing failures retain partial-analysis behavior.
 */
interface ProviderAnalysisFailure {
    /**
     * Always `false`: the analysis did not produce a usable result.
     */
    ok: false;

    /**
     * Human-readable failure description.
     */
    error: string;

    /**
     * Whether the transcript exceeded the provider's context budget.
     */
    tooLarge?: boolean;

    /**
     * Raw model text when available (e.g. parse failures).
     */
    rawAssistant?: string;

    /**
     * HTTP status from the provider call, or `null` for transport failures.
     */
    status?: number | null;

    /**
     * Stable transport/parse classification for BYOK metadata.
     */
    kind?: 'http' | 'network' | 'timeout' | 'parse' | 'aborted';

    /**
     * Never set for this result variant (distinguishes it from a host-access
     * failure).
     */
    failureCode?: never;
}

/**
 * Input to `LlmProviderAdapter.analyzeTranscript`.
 */
export interface AnalyzeTranscriptParams {
    /**
     * Merged caption text, already trimmed by the pipeline.
     */
    transcript: string;

    /**
     * YouTube video ID.
     */
    videoId: string;

    /**
     * Caption language code (e.g. `'en'`).
     */
    languageCode: string;

    /**
     * Video duration in seconds; used for promo-block clamping when known.
     */
    durationSec?: number | undefined;

    /**
     * Cancellation signal from the pipeline's AbortController.
     */
    signal?: AbortSignal | undefined;
}

/**
 * Output of `LlmProviderAdapter.analyzeTranscript`.
 */
export type AnalyzeTranscriptResult = | {
    ok: true;
    hasPromo: false;
    providerMeta: ProviderMeta;
    rawAssistant: string;
}
    | {
        ok: true;
        hasPromo: true;
        blocks: PromoBlock[];
        providerMeta: ProviderMeta;
        rawAssistant: string;
    }
    | ProviderAnalysisFailure
    | ProviderHostAccessRequiredAnalysisResult;

/**
 * Provider-agnostic contract for LLM-backed transcript analysis.
 * Each concrete adapter owns its own prompt construction, API call,
 * response parsing, and error handling.
 */
export interface LlmProviderAdapter {
    /**
     * Unique provider identifier stored in prefs
     * (e.g. `'openrouter'`).
     */
    readonly id: ProviderId;

    /**
     * User-facing label (e.g. `'OpenRouter'`).
     */
    readonly displayName: string;

    /**
     * Whether the provider can currently run analysis.
     *
     * @returns Current availability state.
     */
    availability(): Promise<ProviderAvailability>;

    /**
     * Runs promo detection on a merged transcript.
     *
     * @param params - Transcript and context for the analysis.
     *
     * @returns Detection result or error.
     */
    analyzeTranscript(
        params: AnalyzeTranscriptParams,
    ): Promise<AnalyzeTranscriptResult>;

    /**
     * Conservative UTF-16 character budget for one `analyzeTranscript` user
     * message (planning estimate for chunking).
     *
     * @returns Max transcript length in characters, or 0 if unavailable.
     */
    maxTranscriptChars(): Promise<number>;
}
