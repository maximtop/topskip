/**
 * Provider identity constants shared across all extension bundles.
 *
 * Values cross bundle boundaries over `runtime.sendMessage`; keeping them
 * in `shared/` lets every bundle (background, popup, options, content) import
 * without depending on bundle-specific modules.
 */

/**
 * Known provider identifiers stored in preferences and carried in runtime
 * messages.
 */
export const PROVIDER_ID = {
    ChromePromptApi: 'chrome-prompt-api',
    OpenRouter: 'openrouter',
} as const;

/**
 * Union of known provider ID string literals.
 */
export type ProviderId = (typeof PROVIDER_ID)[keyof typeof PROVIDER_ID];
