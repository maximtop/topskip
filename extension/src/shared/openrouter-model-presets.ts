/**
 * Built-in OpenRouter model presets for the options UI and storage migration
 * (single source of truth for built-in slugs vs user-added models).
 */
export const OPENROUTER_MODEL_PRESETS = [
  // Google
  {
    value: 'google/gemini-3.1-pro-preview',
    label: 'google/gemini-3.1-pro-preview',
  },
  {
    value: 'google/gemini-3-flash-preview',
    label: 'google/gemini-3-flash-preview',
  },
  // OpenAI
  { value: 'openai/gpt-5.4', label: 'openai/gpt-5.4' },
  { value: 'openai/gpt-5.4-mini', label: 'openai/gpt-5.4-mini' },
  // Anthropic
  {
    value: 'anthropic/claude-sonnet-4.6',
    label: 'anthropic/claude-sonnet-4.6',
  },
  // Chinese
  { value: 'z-ai/glm-5.1', label: 'z-ai/glm-5.1' },
  { value: 'minimax/minimax-m2.7', label: 'minimax/minimax-m2.7' },
  { value: 'xiaomi/mimo-v2-pro', label: 'xiaomi/mimo-v2-pro' },
] as const;

/**
 * Built-in model slugs (same order as {@link OPENROUTER_MODEL_PRESETS}).
 */
export const OPENROUTER_BUILTIN_MODEL_SLUGS: readonly string[] =
  OPENROUTER_MODEL_PRESETS.map((p) => p.value);

/**
 * Default model when none is set or after removing a custom active model.
 */
export const OPENROUTER_DEFAULT_MODEL_SLUG: string =
  OPENROUTER_MODEL_PRESETS[0]?.value ?? 'google/gemini-3.1-pro-preview';

/**
 * @param slug - Model id to test
 * @returns Whether the slug is a built-in preset (not user-added)
 */
export function isOpenRouterBuiltinModelSlug(slug: string): boolean {
  return OPENROUTER_BUILTIN_MODEL_SLUGS.includes(slug);
}
