import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const debugLogMock = vi.hoisted(() => ({ record: vi.fn() }));
vi.mock('@/background/debug-log/debug-log', () => ({ DebugLog: debugLogMock }));

import { CaptionRuntimeMessages } from '@/background/messaging/caption-runtime-messages';
import { DEBUG_LOG_EVENT } from '@/shared/debug-log-events';
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
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
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
            expect(console.warn).toHaveBeenCalledWith(
                '[TopSkip captions]',
                reason,
            );
            expect(console.error).not.toHaveBeenCalled();
        },
    );

    it('keeps integration malfunctions at error level', async () => {
        await CaptionRuntimeMessages.handle(
            {
                ok: false,
                videoId: 'dQw4w9WgXcQ',
                error: 'bridge-install-failed',
                reason: 'bridge-install-failed',
            },
            { tab: { id: 42 } } as never,
        );

        expect(console.error).toHaveBeenCalledWith(
            '[TopSkip captions]',
            'bridge-install-failed',
        );
        expect(console.warn).not.toHaveBeenCalled();
    });

    it('logs the stable reason (not the free-form error) and records capture-failed', async () => {
        await CaptionRuntimeMessages.handle(
            {
                ok: false,
                videoId: 'dQw4w9WgXcQ',
                error: 'https://youtube.com/api/timedtext?pot=SECRET_LEAK',
                reason: 'capture-timeout',
            },
            { tab: { id: 42 } } as never,
        );

        expect(console.warn).toHaveBeenCalledWith('[TopSkip captions]', 'capture-timeout');
        expect(console.warn).not.toHaveBeenCalledWith(
            '[TopSkip captions]',
            expect.stringContaining('SECRET_LEAK'),
        );
        expect(debugLogMock.record).toHaveBeenCalledWith(
            DEBUG_LOG_EVENT.CaptureFailed,
            { reason: 'capture-timeout' },
            { tab: 42 },
        );
    });

    it('logs an unknown sentinel when a genuine failure has no reason', async () => {
        await CaptionRuntimeMessages.handle(
            { ok: false, videoId: 'dQw4w9WgXcQ', error: 'raw stack trace' },
            { tab: { id: 42 } } as never,
        );
        expect(console.error).toHaveBeenCalledWith('[TopSkip captions]', 'unknown');
        expect(console.error).not.toHaveBeenCalledWith(
            '[TopSkip captions]',
            'raw stack trace',
        );
    });

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
