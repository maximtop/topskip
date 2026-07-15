import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefsMocks = vi.hoisted(() => ({
    ready: vi.fn().mockResolvedValue(undefined),
    load: vi.fn(),
}));

vi.mock('@/background/storage/prefs-sync', () => ({
    PrefsSyncStorage: prefsMocks,
}));

const promoMocks = vi.hoisted(() => ({
    onCaptionsReady: vi.fn(),
}));

vi.mock('@/background/messaging/promo-analysis', () => ({
    PromoAnalysis: promoMocks,
}));

const transcriptLogMock = vi.hoisted(() => vi.fn());

vi.mock('@/background/captions/log-transcript-dev', () => ({
    logTranscriptForDeveloper: transcriptLogMock,
}));

import { CaptionRuntimeMessages } from '@/background/messaging/caption-runtime-messages';
import type { CaptionsFromContentPayload } from '@/shared/messages';

const payload: CaptionsFromContentPayload = {
    ok: true,
    videoId: 'dQw4w9WgXcQ',
    languageCode: 'en',
    segments: [{ startSec: 0, durationSec: 2, text: 'hello' }],
};

describe('CaptionRuntimeMessages analysis mode guard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('does not invoke provider analysis in server mode', async () => {
        prefsMocks.load.mockResolvedValue({
            enabled: true,
            providerId: 'openrouter',
            activeModelId: 'openrouter:test',
            analysisMode: 'server',
        });

        await CaptionRuntimeMessages.handle(payload, {
            tab: { id: 42 },
        } as never);

        expect(promoMocks.onCaptionsReady).not.toHaveBeenCalled();
    });

    it('does not invoke provider analysis while BYOK is disabled', async () => {
        prefsMocks.load.mockResolvedValue({
            enabled: false,
            providerId: 'openrouter',
            activeModelId: 'openrouter:test',
            analysisMode: 'byok',
        });

        await CaptionRuntimeMessages.handle(payload, {
            tab: { id: 42 },
        } as never);

        expect(promoMocks.onCaptionsReady).not.toHaveBeenCalled();
    });

    it.each(['capture-timeout', 'captions-unavailable'] as const)(
        'keeps failed %s payloads diagnostic-only',
        async (reason) => {
            await CaptionRuntimeMessages.handle(
                {
                    ok: false,
                    videoId: 'dQw4w9WgXcQ',
                    error: reason,
                    reason,
                },
                { tab: { id: 42 } } as never,
            );

            expect(prefsMocks.load).not.toHaveBeenCalled();
            expect(promoMocks.onCaptionsReady).not.toHaveBeenCalled();
        },
    );

    it('keeps BYOK mode on the existing provider path', async () => {
        prefsMocks.load.mockResolvedValue({
            enabled: true,
            providerId: 'openrouter',
            activeModelId: 'openrouter:test',
            analysisMode: 'byok',
        });

        await CaptionRuntimeMessages.handle(payload, {
            tab: { id: 42 },
        } as never);

        expect(promoMocks.onCaptionsReady).toHaveBeenCalled();
        expect(transcriptLogMock).not.toHaveBeenCalled();
    });
});
