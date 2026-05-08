/**
 * Chrome Prompt API (Web AI) surface identifiers.
 *
 * Pure constants — no I/O — so they safely live in `shared/`. Used by both
 * the background (message handlers) and options (direct `LanguageModel`
 * calls) bundles.
 */

/**
 * Global constructor name exposed by Chrome when Prompt API is enabled.
 */
export const LANGUAGE_MODEL_GLOBAL = 'LanguageModel';

/**
 * Method names on `LanguageModel`.
 */
export const LANGUAGE_MODEL_METHOD = {
    /**
     * Returns current model availability state.
     */
    AVAILABILITY: 'availability',
    /**
     * Creates a new model session (triggers download if needed).
     */
    CREATE: 'create',
} as const;

/**
 * Event name emitted by the `monitor` callback during model download.
 */
export const DOWNLOAD_PROGRESS_EVENT = 'downloadprogress';

/**
 * Availability states returned by `LanguageModel.availability()`. Mirrors
 * `ProviderAvailabilityMessage` in `shared/messages.ts` and serves as the
 * single source of truth for those literal values.
 */
export const PROVIDER_AVAILABILITY = {
    AVAILABLE: 'available',
    DOWNLOADABLE: 'downloadable',
    DOWNLOADING: 'downloading',
    UNAVAILABLE: 'unavailable',
} as const;

/**
 * Human-readable model name shown in UI when the Chrome Prompt API
 * (Gemini Nano) provider is active.
 */
export const CHROME_PROMPT_API_MODEL_NAME = 'Gemini Nano';
