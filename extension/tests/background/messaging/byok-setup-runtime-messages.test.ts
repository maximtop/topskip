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

import { ByokSetupRuntimeMessages } from '@/background/messaging/byok-setup-runtime-messages';
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
