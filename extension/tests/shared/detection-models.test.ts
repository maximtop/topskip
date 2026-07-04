import { describe, expect, it } from 'vitest';

import {
    buildOpenRouterModelId,
    DEFAULT_DETECTION_MODEL_ID,
    getBuiltinDetectionModels,
    resolveDetectionModel,
} from '@/shared/detection-models';
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
