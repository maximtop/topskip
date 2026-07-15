import type { PromoBlock } from '@topskip/common/promo-types';
import { PROVIDER_AVAILABILITY } from '@/shared/chrome-prompt-api';
import type { ProviderId } from '@/shared/providers';
export { PROVIDER_AVAILABILITY } from '@/shared/chrome-prompt-api';
export { PROVIDER_ID, type ProviderId } from '@/shared/providers';

/**
 * Whether the provider is ready to run analysis.
 */
export type ProviderAvailability =
    (typeof PROVIDER_AVAILABILITY)[keyof typeof PROVIDER_AVAILABILITY];

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
export type ProviderMeta = {
    id: ProviderId;
    model: string;
};

/**
 * Input to `LlmProviderAdapter.analyzeTranscript`.
 */
export type AnalyzeTranscriptParams = {
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
    durationSec?: number;
    /**
     * Cancellation signal from the pipeline's AbortController.
     */
    signal?: AbortSignal;
};

/**
 * Output of `LlmProviderAdapter.analyzeTranscript`.
 */
export type AnalyzeTranscriptResult =
    | {
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
    | {
          ok: false;
          error: string;
          tooLarge?: boolean;
          /**
           * Raw model text when available (e.g. parse failures).
           */
          rawAssistant?: string;
      };

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
