import { describe, expect, it } from 'vitest';

import {
    buildOpenAiModelId,
    buildOpenRouterModelId,
    DEBUG_LOG_CUSTOM_MODEL_ID,
    DEFAULT_DETECTION_MODEL_ID,
    getBuiltinDetectionModels,
    isPresetModelId,
    resolveDetectionModel,
    toDebugLogModelId,
    toDebugLogModelName,
} from '@/shared/detection-models';
import { OPENROUTER_DEFAULT_MODEL_SLUG } from '@/shared/openrouter-model-presets';
import { PROVIDER_ID } from '@/shared/providers';

describe('detection model catalog', () => {
    it('includes OpenRouter, OpenAI, and Chrome built-in models', () => {
        const models = getBuiltinDetectionModels();
        expect(
            models.some((m) => m.providerId === PROVIDER_ID.OpenRouter),
        ).toBe(true);
        expect(models.some((m) => m.providerId === PROVIDER_ID.OpenAI)).toBe(
            true,
        );
        expect(
            models.some((m) => m.providerId === PROVIDER_ID.ChromePromptApi),
        ).toBe(true);
    });

    it('builds and resolves custom OpenRouter model ids', () => {
        const id = buildOpenRouterModelId('meta-llama/llama-3.1-8b-instruct');
        const model = resolveDetectionModel(id, [
            'meta-llama/llama-3.1-8b-instruct',
        ]);
        expect(model).toEqual(
            expect.objectContaining({
                id,
                providerId: PROVIDER_ID.OpenRouter,
                modelName: 'meta-llama/llama-3.1-8b-instruct',
                requiresConnection: true,
            }),
        );
    });

    it('falls back to default for unknown ids', () => {
        expect(resolveDetectionModel('bad:id', [])?.id).toBe(
            DEFAULT_DETECTION_MODEL_ID,
        );
    });
});

describe('debug-log model id rule', () => {
    it('keeps built-in preset ids verbatim for their own provider only', () => {
        expect(isPresetModelId(PROVIDER_ID.OpenRouter, DEFAULT_DETECTION_MODEL_ID)).toBe(true);
        expect(isPresetModelId(PROVIDER_ID.OpenAI, buildOpenAiModelId('gpt-5-mini'))).toBe(true);
        expect(isPresetModelId(PROVIDER_ID.OpenAI, DEFAULT_DETECTION_MODEL_ID)).toBe(false);
        expect(toDebugLogModelId(PROVIDER_ID.OpenRouter, DEFAULT_DETECTION_MODEL_ID)).toBe(
            DEFAULT_DETECTION_MODEL_ID,
        );
    });

    it('maps every non-preset slug to the custom stand-in', () => {
        const custom = buildOpenRouterModelId('acme-corp/internal-finetune');
        expect(isPresetModelId(PROVIDER_ID.OpenRouter, custom)).toBe(false);
        expect(toDebugLogModelId(PROVIDER_ID.OpenRouter, custom)).toBe(DEBUG_LOG_CUSTOM_MODEL_ID);
        expect(DEBUG_LOG_CUSTOM_MODEL_ID).toBe('custom');
    });

    it('keeps provider-native preset names verbatim and maps everything else to custom', () => {
        expect(toDebugLogModelName(PROVIDER_ID.OpenRouter, OPENROUTER_DEFAULT_MODEL_SLUG)).toBe(
            OPENROUTER_DEFAULT_MODEL_SLUG,
        );
        expect(toDebugLogModelName(PROVIDER_ID.OpenRouter, 'openai/gpt-5.4')).toBe(
            'openai/gpt-5.4',
        );
        expect(toDebugLogModelName(PROVIDER_ID.OpenAI, 'gpt-5.2')).toBe('gpt-5.2');
        expect(toDebugLogModelName(PROVIDER_ID.ChromePromptApi, 'gemini-nano')).toBe('gemini-nano');
        expect(toDebugLogModelName(PROVIDER_ID.OpenRouter, 'acme/secret-org-model')).toBe(
            DEBUG_LOG_CUSTOM_MODEL_ID,
        );
        expect(toDebugLogModelName(PROVIDER_ID.OpenAI, 'ft:custom')).toBe(
            DEBUG_LOG_CUSTOM_MODEL_ID,
        );
        expect(toDebugLogModelName(PROVIDER_ID.OpenAI, 'openai/gpt-5.4')).toBe(
            DEBUG_LOG_CUSTOM_MODEL_ID,
        );
    });
});
