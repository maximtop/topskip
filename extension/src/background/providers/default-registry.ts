import { ChromePromptApiAdapter } from
  '@/background/providers/chrome-prompt-api-adapter';
import { OpenRouterAdapter } from
  '@/background/providers/openrouter-adapter';
import { ProviderRegistry } from
  '@/background/providers/provider-registry';

/**
 * Production provider registry with all built-in adapters.
 * Imported by `Background.init()` (once the pipeline is rewired in issue 3).
 */
export const defaultRegistry = new ProviderRegistry([
  new ChromePromptApiAdapter(),
  new OpenRouterAdapter(),
]);
