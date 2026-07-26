import { ChromePromptApiAdapter } from '@/background/providers/chrome-prompt-api-adapter';
import type { LlmProviderAdapter } from '@/background/providers/llm-provider-adapter';
import { OpenAiAdapter } from '@/background/providers/openai-adapter';
import { OpenRouterAdapter } from '@/background/providers/openrouter-adapter';
import { ProviderRegistry } from '@/background/providers/provider-registry';

/**
 * Adapters that are always selectable.
 */
const adapters: LlmProviderAdapter[] = [
    new OpenRouterAdapter(),
    new OpenAiAdapter(),
];

// Chrome's built-in model is compiled out by default: measured against the
// annotated fixture it scored 0.054 mean IoU versus 0.747 for the cloud model,
// and proposed cutting 12 contiguous minutes out of a 30-minute video. The
// adapter is kept so a future Gemini Nano can be re-measured by flipping
// `INCLUDE_CHROME_BUILTIN_PROVIDER` in `extension/build-modes.ts`.
if (__TOPSKIP_INCLUDE_CHROME_BUILTIN__) {
    adapters.unshift(new ChromePromptApiAdapter());
}

/**
 * Production provider registry with all enabled built-in adapters.
 * Imported by `Background.init()`.
 *
 * A provider id stored in prefs but absent here resolves to `undefined` in
 * `PromoAnalysis`, which reports `not_configured` instead of failing.
 */
export const defaultRegistry = new ProviderRegistry(adapters);
