import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefsMocks = vi.hoisted(() => ({
    ready: vi.fn().mockResolvedValue(undefined),
    load: vi.fn(),
}));

vi.mock('@/background/storage/prefs-sync', () => ({
    PrefsSyncStorage: prefsMocks,
}));

const detectionMocks = vi.hoisted(() => ({ set: vi.fn() }));

vi.mock('@/background/promo-detection-store', () => ({
    PromoDetectionStore: detectionMocks,
}));

vi.mock('@/background/providers/default-registry', () => ({
    defaultRegistry: { get: vi.fn() },
}));

const providerBoundaryMocks = vi.hoisted(() => ({
    openRouterLoad: vi.fn(),
    openAiLoad: vi.fn(),
    providerHostAccessIsGranted: vi.fn(),
    callOpenRouterChat: vi.fn(),
    callOpenAiResponse: vi.fn(),
}));

vi.mock('@/background/storage/openrouter-storage', () => ({
    OpenRouterStorage: { load: providerBoundaryMocks.openRouterLoad },
}));

vi.mock('@/background/storage/openai-storage', () => ({
    OpenAiStorage: { load: providerBoundaryMocks.openAiLoad },
}));

vi.mock('@/background/permissions/provider-host-access', () => ({
    ProviderHostAccess: {
        isGranted: providerBoundaryMocks.providerHostAccessIsGranted,
    },
}));

vi.mock('@/background/openrouter/openrouter-client', () => ({
    callOpenRouterChat: providerBoundaryMocks.callOpenRouterChat,
}));

vi.mock('@/background/openai/openai-client', () => ({
    callOpenAiResponse: providerBoundaryMocks.callOpenAiResponse,
}));

import { ByokSetupRuntimeMessages } from '@/background/messaging/byok-setup-runtime-messages';
import { OpenAiAdapter } from '@/background/providers/openai-adapter';
import { OpenRouterAdapter } from '@/background/providers/openrouter-adapter';
import { PROVIDER_AVAILABILITY } from '@/shared/chrome-prompt-api';
import { ANALYSIS_MODE } from '@/shared/constants';

describe('ByokSetupRuntimeMessages', () => {
    const prefs = {
        enabled: true,
        providerId: 'openrouter',
        activeModelId: 'openrouter:test',
        analysisMode: ANALYSIS_MODE.Byok,
    };
    const availability = vi
        .fn()
        .mockResolvedValue(PROVIDER_AVAILABILITY.AVAILABLE);
    const registry = { get: vi.fn() };

    beforeEach(() => {
        vi.clearAllMocks();
        prefsMocks.load.mockResolvedValue(prefs);
        availability.mockResolvedValue(PROVIDER_AVAILABILITY.AVAILABLE);
        registry.get.mockReturnValue({ availability });
        providerBoundaryMocks.openRouterLoad.mockResolvedValue({
            apiKey: 'sk-openrouter',
            model: 'provider/model',
            customModels: [],
        });
        providerBoundaryMocks.openAiLoad.mockResolvedValue({
            apiKey: 'sk-openai',
            model: 'gpt-5.2',
        });
        providerBoundaryMocks.providerHostAccessIsGranted.mockResolvedValue(
            true,
        );
        ByokSetupRuntimeMessages.setRegistry(registry as never);
    });

    it.each([
        ['missing adapter', undefined],
        [
            'unavailable adapter',
            {
                availability: vi
                    .fn()
                    .mockResolvedValue(PROVIDER_AVAILABILITY.UNAVAILABLE),
            },
        ],
    ])(
        'publishes setup-required for an %s before captions',
        async (_name, adapter) => {
            registry.get.mockReturnValue(adapter);

            const result = await ByokSetupRuntimeMessages.handle(
                { videoId: 'video-a' },
                { tab: { id: 42 } } as never,
            );

            expect(result).toEqual({ ok: true, status: 'setup_required' });
            expect(detectionMocks.set).toHaveBeenCalledWith(42, {
                videoId: 'video-a',
                status: 'not_configured',
                source: 'local_provider',
            });
        },
    );

    it('returns ready without writing setup-required', async () => {
        await expect(
            ByokSetupRuntimeMessages.handle({ videoId: 'video-a' }, {
                tab: { id: 42 },
            } as never),
        ).resolves.toEqual({ ok: true, status: 'ready' });
        expect(availability).toHaveBeenCalledOnce();
        expect(detectionMocks.set).not.toHaveBeenCalled();
    });

    it.each([
        {
            providerId: 'openrouter',
            createAdapter: () => new OpenRouterAdapter(),
            providerClient: providerBoundaryMocks.callOpenRouterChat,
        },
        {
            providerId: 'openai',
            createAdapter: () => new OpenAiAdapter(),
            providerClient: providerBoundaryMocks.callOpenAiResponse,
        },
    ])(
        'publishes setup-required without a $providerId fetch or server fallback',
        async ({ providerId, createAdapter, providerClient }) => {
            prefsMocks.load.mockResolvedValue({ ...prefs, providerId });
            providerBoundaryMocks.providerHostAccessIsGranted.mockResolvedValue(
                false,
            );
            registry.get.mockReturnValue(createAdapter());

            await expect(
                ByokSetupRuntimeMessages.handle({ videoId: 'video-a' }, {
                    tab: { id: 42 },
                } as never),
            ).resolves.toEqual({ ok: true, status: 'setup_required' });
            expect(providerClient).not.toHaveBeenCalled();
            expect(detectionMocks.set).toHaveBeenCalledOnce();
            expect(detectionMocks.set).toHaveBeenCalledWith(42, {
                videoId: 'video-a',
                status: 'not_configured',
                source: 'local_provider',
            });
        },
    );

    it.each([
        { ...prefs, enabled: false },
        { ...prefs, analysisMode: ANALYSIS_MODE.Server },
    ])(
        'returns inactive without probing for $analysisMode/$enabled',
        async (stored) => {
            prefsMocks.load.mockResolvedValue(stored);

            await expect(
                ByokSetupRuntimeMessages.handle({ videoId: 'video-a' }, {
                    tab: { id: 42 },
                } as never),
            ).resolves.toEqual({ ok: true, status: 'inactive' });
            expect(registry.get).not.toHaveBeenCalled();
            expect(availability).not.toHaveBeenCalled();
        },
    );

    it('normalizes readiness probe failures without fallback', async () => {
        availability.mockRejectedValue(new Error('provider probe failed'));

        await expect(
            ByokSetupRuntimeMessages.handle({ videoId: 'video-a' }, {
                tab: { id: 42 },
            } as never),
        ).resolves.toEqual({ ok: false, error: 'provider probe failed' });
        expect(detectionMocks.set).not.toHaveBeenCalled();
    });
});
