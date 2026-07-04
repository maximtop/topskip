import { CHROME_PROMPT_API_MODEL_NAME } from '@/shared/chrome-prompt-api';
import {
    OPENROUTER_DEFAULT_MODEL_SLUG,
    OPENROUTER_MODEL_PRESETS,
} from '@/shared/openrouter-model-presets';
import {
    PROVIDER_ID,
    PROVIDER_LABEL,
    type ProviderId,
} from '@/shared/providers';

/**
 * Model option shown to users while keeping provider routing metadata hidden.
 */
export type DetectionModel = {
    id: string;
    label: string;
    providerId: ProviderId;
    providerLabel: string;
    modelName: string;
    requiresConnection: boolean;
};

/**
 * Initial OpenAI presets exposed by model-first settings.
 */
export const OPENAI_MODEL_PRESETS = [
    { value: 'gpt-5.2', label: 'GPT-5.2' },
    { value: 'gpt-5-mini', label: 'GPT-5 mini' },
    { value: 'gpt-5-nano', label: 'GPT-5 nano' },
] as const;

/**
 * Prefixes OpenRouter slugs so active model IDs are provider-unique.
 *
 * @param slug - OpenRouter model slug.
 * @returns Stable model-first ID.
 */
export function buildOpenRouterModelId(slug: string): string {
    return `${PROVIDER_ID.OpenRouter}:${slug}`;
}

/**
 * Prefixes OpenAI model names so active model IDs are provider-unique.
 *
 * @param model - OpenAI model name.
 * @returns Stable model-first ID.
 */
export function buildOpenAiModelId(model: string): string {
    return `${PROVIDER_ID.OpenAI}:${model}`;
}

/**
 * Stable ID for Chrome's built-in Gemini Nano model.
 */
export const CHROME_BUILTIN_MODEL_ID = `${PROVIDER_ID.ChromePromptApi}:gemini-nano`;

/**
 * Default active model for new or repaired installations.
 */
export const DEFAULT_DETECTION_MODEL_ID = buildOpenRouterModelId(
    OPENROUTER_DEFAULT_MODEL_SLUG,
);

/**
 * Built-in detection models shipped without user-added OpenRouter slugs.
 *
 * @returns Ordered model catalog.
 */
export function getBuiltinDetectionModels(): DetectionModel[] {
    return [
        ...OPENROUTER_MODEL_PRESETS.map((model) => ({
            id: buildOpenRouterModelId(model.value),
            label: model.label,
            providerId: PROVIDER_ID.OpenRouter,
            providerLabel: PROVIDER_LABEL.OpenRouter,
            modelName: model.value,
            requiresConnection: true,
        })),
        ...OPENAI_MODEL_PRESETS.map((model) => ({
            id: buildOpenAiModelId(model.value),
            label: model.label,
            providerId: PROVIDER_ID.OpenAI,
            providerLabel: PROVIDER_LABEL.OpenAI,
            modelName: model.value,
            requiresConnection: true,
        })),
        {
            id: CHROME_BUILTIN_MODEL_ID,
            label: CHROME_PROMPT_API_MODEL_NAME,
            providerId: PROVIDER_ID.ChromePromptApi,
            providerLabel: PROVIDER_LABEL.ChromeBuiltIn,
            modelName: 'gemini-nano',
            requiresConnection: false,
        },
    ];
}

/**
 * Full catalog with user-added OpenRouter models appended after built-ins.
 *
 * @param customOpenRouterModels - Saved custom OpenRouter slugs.
 * @returns Ordered model catalog.
 */
export function getDetectionModels(
    customOpenRouterModels: string[],
): DetectionModel[] {
    const builtins = getBuiltinDetectionModels();
    const seen = new Set(builtins.map((model) => model.id));
    const custom = customOpenRouterModels.flatMap((slug) => {
        const id = buildOpenRouterModelId(slug);
        if (seen.has(id)) {
            return [];
        }
        seen.add(id);
        return [
            {
                id,
                label: slug,
                providerId: PROVIDER_ID.OpenRouter,
                providerLabel: PROVIDER_LABEL.OpenRouter,
                modelName: slug,
                requiresConnection: true,
            },
        ];
    });
    return [...builtins, ...custom];
}

/**
 * Resolves a stored active model ID, falling back to a valid default.
 *
 * @param modelId - Stored or incoming active model ID.
 * @param customOpenRouterModels - Saved custom OpenRouter slugs.
 * @returns Matching model or default model.
 */
export function resolveDetectionModel(
    modelId: string,
    customOpenRouterModels: string[],
): DetectionModel | null {
    return (
        getDetectionModels(customOpenRouterModels).find(
            (model) => model.id === modelId,
        ) ??
        getBuiltinDetectionModels().find(
            (model) => model.id === DEFAULT_DETECTION_MODEL_ID,
        ) ??
        null
    );
}
