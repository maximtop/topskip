import type { PromoBlock } from '@/shared/promo-types';

/**
 * Enum-like object for provider availability states.
 */
export const PROVIDER_AVAILABILITY = {
  Available: 'available',
  Downloadable: 'downloadable',
  Downloading: 'downloading',
  Unavailable: 'unavailable',
} as const;

/**
 * Whether the provider is ready to run analysis.
 */
export type ProviderAvailability =
  typeof PROVIDER_AVAILABILITY[keyof typeof PROVIDER_AVAILABILITY];

/**
 * Known provider identifiers. Extended when new adapters are added.
 */
export const PROVIDER_ID = {
  ChromePromptApi: 'chrome-prompt-api',
  OpenRouter: 'openrouter',
} as const;

/**
 * Union of known provider ID literals.
 */
export type ProviderId = typeof PROVIDER_ID[keyof typeof PROVIDER_ID];

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
  | { ok: true; hasPromo: false; providerMeta: ProviderMeta }
  | {
      ok: true;
      hasPromo: true;
      blocks: PromoBlock[];
      providerMeta: ProviderMeta;
    }
  | { ok: false; error: string };

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
}
