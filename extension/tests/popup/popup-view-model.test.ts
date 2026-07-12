import { describe, expect, it, vi } from 'vitest';

import { buildPopupViewModel } from '@/popup/PopupApp';
import { ANALYSIS_MODE } from '@/shared/constants';
import type { PromoDetectionStatePayload } from '@/shared/messages';

vi.mock('@/shared/browser', () => ({
    default: {
        i18n: {
            getMessage: vi.fn((key: string) => {
                const messages: Record<string, string> = {
                    popup_detection_server_pending_badge: 'Server',
                    popup_detection_server_pending_title:
                        'Server analysis pending',
                    popup_detection_server_pending_description:
                        'TopSkip asked the local backend to analyze this video.',
                    popup_detection_server_pending_headline:
                        'Server analysis is in progress.',
                    popup_detection_server_pending_body:
                        'Skipping will start when the TopSkip backend has promo blocks for a future playback position.',
                    popup_detection_server_error_badge: 'Server',
                    popup_detection_server_error_title:
                        'Server analysis unavailable',
                    popup_detection_server_error_description:
                        'TopSkip could not use the local backend for this video.',
                    popup_detection_server_error_headline:
                        'Server analysis failed.',
                    popup_detection_server_error_body:
                        'The local TopSkip backend did not return a usable response. Playback continues without server-detected skips.',
                    popup_detection_server_cache_badge: 'Server cache',
                    popup_detection_server_cache_title:
                        'Server-detected blocks ready',
                    popup_detection_server_cache_description:
                        'TopSkip received cached promo blocks from the local backend.',
                    popup_detection_server_cache_headline: 'Server cache hit.',
                    popup_detection_server_no_promo_badge: 'Server',
                    popup_detection_server_no_promo_title:
                        'Server analysis complete',
                    popup_detection_server_no_promo_description:
                        'TopSkip checked the local backend result for this video.',
                    popup_detection_server_no_promo_headline:
                        'No server promo blocks detected.',
                    popup_detection_server_no_promo_body:
                        'Playback continues normally unless future server results add blocks.',
                    popup_detection_server_unavailable_badge: 'Server',
                    popup_detection_server_unavailable_title:
                        'Server analysis unavailable',
                    popup_detection_server_unavailable_description:
                        'The local backend could not produce a result for this video.',
                    popup_detection_server_unavailable_headline:
                        'Server analysis is unavailable.',
                    popup_detection_server_unavailable_body:
                        'Playback continues without server-detected skips.',
                    popup_analysis_mode_server: 'TopSkip Server',
                    popup_analysis_mode_byok: 'Private BYOK',
                    popup_byok_setup_badge: 'Setup required',
                    popup_byok_setup_title: 'Private BYOK setup required',
                    popup_byok_setup_description:
                        'Configure %provider% in settings before promo analysis can run.',
                    popup_byok_setup_body:
                        'Analysis stays with your configured provider and is not shared with TopSkip.',
                    popup_open_settings: 'Open settings',
                };
                return messages[key] ?? key;
            }),
        },
        runtime: {
            sendMessage: vi.fn(),
            connect: vi.fn(),
            onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
            openOptionsPage: vi.fn(),
        },
    },
}));

describe('buildPopupViewModel', () => {
    const baseArgs = {
        enabled: true,
        analysisMode: ANALYSIS_MODE.Server,
        detectionState: null,
        prefsError: null,
        detectionError: null,
        providerId: 'openrouter',
        providerDisplayName: 'OpenRouter',
        modelDisplayName: 'google/gemini-2.0-flash',
        chromeModelAvailability: null,
    };

    it('idle state includes provider label', () => {
        const vm = buildPopupViewModel(baseArgs);
        expect(vm.providerLabel).toBe('google/gemini-2.0-flash · OpenRouter');
        expect(vm.activityLabel).toBe('Promo detection active');
        expect(vm.modeLabel).toBe('TopSkip Server');
    });

    it.each([
        null,
        { videoId: 'v1', status: 'analyzing', source: 'server' },
        {
            videoId: 'v1',
            status: 'detected',
            source: 'server_cache',
            promoBlocks: [{ startSec: 4, endSec: 20 }],
        },
        { videoId: 'v1', status: 'no_promo', source: 'server' },
        { videoId: 'v1', status: 'error', source: 'server' },
    ] satisfies (PromoDetectionStatePayload | null)[])(
        'always identifies Server mode for server state %#',
        (detectionState) => {
            const vm = buildPopupViewModel({ ...baseArgs, detectionState });
            expect(vm.modeLabel).toBe('TopSkip Server');
        },
    );

    it.each([
        'analyzing',
        'detected',
        'no_promo',
        'error',
        'unavailable',
    ] as const)('identifies Private BYOK for %s', (status) => {
        const vm = buildPopupViewModel({
            ...baseArgs,
            analysisMode: ANALYSIS_MODE.Byok,
            detectionState: {
                videoId: 'v1',
                status,
                source: 'local_provider',
            },
        });
        expect(vm.modeLabel).toBe('Private BYOK');
    });

    it('shows caption-independent BYOK setup guidance without server wording', () => {
        const vm = buildPopupViewModel({
            ...baseArgs,
            analysisMode: ANALYSIS_MODE.Byok,
            providerDisplayName: 'OpenRouter',
            detectionState: {
                videoId: 'v1',
                status: 'not_configured',
                source: 'local_provider',
            },
        });

        expect(vm.modeLabel).toBe('Private BYOK');
        expect(vm.badgeLabel).toBe('Setup required');
        expect(vm.description).toContain('OpenRouter');
        expect(`${vm.description} ${vm.statusBody}`).not.toMatch(
            /server|cache|fallback/i,
        );
    });

    it('providerLabel omits separator when modelDisplayName is empty', () => {
        const vm = buildPopupViewModel({
            ...baseArgs,
            modelDisplayName: '',
        });
        expect(vm.providerLabel).toBe('OpenRouter');
    });

    it('not_configured description includes provider name', () => {
        const vm = buildPopupViewModel({
            ...baseArgs,
            detectionState: {
                videoId: 'v1',
                status: 'not_configured',
            },
        });
        expect(vm.description).toContain('OpenRouter');
        expect(vm.providerLabel).toBe('google/gemini-2.0-flash · OpenRouter');
    });

    it('Chrome Built-in provider label shows correct string', () => {
        const vm = buildPopupViewModel({
            ...baseArgs,
            providerDisplayName: 'Chrome Built-in',
            modelDisplayName: 'Gemini Nano',
            detectionState: { videoId: 'v1', status: 'analyzing' },
        });
        expect(vm.providerLabel).toBe('Gemini Nano · Chrome Built-in');
    });

    it('openrouter not_configured with empty model shows name only', () => {
        const vm = buildPopupViewModel({
            ...baseArgs,
            modelDisplayName: '',
            detectionState: {
                videoId: 'v1',
                status: 'not_configured',
            },
        });
        expect(vm.providerLabel).toBe('OpenRouter');
    });

    it('chrome downloading shows model_downloading messaging', () => {
        const vm = buildPopupViewModel({
            ...baseArgs,
            providerId: 'chrome-prompt-api',
            providerDisplayName: 'Chrome Built-in',
            modelDisplayName: 'Gemini Nano',
            chromeModelAvailability: 'downloading',
            detectionState: { videoId: 'v1', status: 'analyzing' },
        });

        expect(vm.tone).toBe('brand');
        expect(vm.badgeLabel).toBe('Downloading');
        expect(vm.statusHeadline).toContain('Model downloading');
    });

    it('chrome unavailable shows model_unavailable messaging', () => {
        const vm = buildPopupViewModel({
            ...baseArgs,
            providerId: 'chrome-prompt-api',
            providerDisplayName: 'Chrome Built-in',
            modelDisplayName: 'Gemini Nano',
            chromeModelAvailability: 'unavailable',
            detectionState: { videoId: 'v1', status: 'unavailable' },
        });

        expect(vm.tone).toBe('warning');
        expect(vm.badgeLabel).toBe('Unavailable');
        expect(vm.statusHeadline).toContain('Model unavailable');
        expect(vm.statusBody).toContain('Open settings');
    });

    it('chrome downloadable shows setup messaging', () => {
        const vm = buildPopupViewModel({
            ...baseArgs,
            providerId: 'chrome-prompt-api',
            providerDisplayName: 'Chrome Built-in',
            modelDisplayName: 'Gemini Nano',
            chromeModelAvailability: 'downloadable',
            detectionState: { videoId: 'v1', status: 'not_configured' },
        });

        expect(vm.tone).toBe('neutral');
        expect(vm.badgeLabel).toBe('Setup');
        expect(vm.statusHeadline).toContain('Model not downloaded yet');
    });

    it('openrouter ignores chrome readiness state', () => {
        const vm = buildPopupViewModel({
            ...baseArgs,
            providerId: 'openrouter',
            chromeModelAvailability: 'downloading',
            detectionState: { videoId: 'v1', status: 'analyzing' },
        });

        expect(vm.statusHeadline).toBe('Analysis is in progress.');
    });

    it('server analyzing state explains that backend work is pending', () => {
        const vm = buildPopupViewModel({
            ...baseArgs,
            detectionState: {
                videoId: 'dQw4w9WgXcQ',
                status: 'analyzing',
                source: 'server',
            },
        });

        expect(vm.title).toBe('Server analysis pending');
        expect(vm.statusHeadline).toBe('Server analysis is in progress.');
        expect(vm.statusBody).toContain('TopSkip backend');
    });

    it('server error state explains the backend failure path', () => {
        const vm = buildPopupViewModel({
            ...baseArgs,
            detectionState: {
                videoId: 'dQw4w9WgXcQ',
                status: 'error',
                source: 'server',
                error: 'Server analysis timed out.',
            },
        });

        expect(vm.title).toBe('Server analysis unavailable');
        expect(vm.statusHeadline).toBe('Server analysis timed out.');
        expect(vm.statusBody).toContain('local TopSkip backend');
        expect(vm.statusBody).not.toContain('API key');
    });

    it('server rate-limit state explains that skipping remains server-only', () => {
        const vm = buildPopupViewModel({
            ...baseArgs,
            detectionState: {
                videoId: 'dQw4w9WgXcQ',
                status: 'unavailable',
                source: 'server',
                error: 'Local cold-analysis limit reached. Retry later.',
            },
        });

        expect(vm.title).toBe('Server analysis unavailable');
        expect(vm.statusHeadline).toBe(
            'Local cold-analysis limit reached. Retry later.',
        );
        expect(vm.statusBody).toContain('server-detected skips');
        expect(vm.statusBody).not.toContain('API key');
    });

    it.each(['downloading', 'unavailable', 'downloadable'] as const)(
        'server cache detected state takes precedence over Chrome %s state',
        (chromeModelAvailability) => {
            const vm = buildPopupViewModel({
                ...baseArgs,
                providerId: 'chrome-prompt-api',
                providerDisplayName: 'Chrome Built-in',
                modelDisplayName: 'Gemini Nano',
                chromeModelAvailability,
                detectionState: {
                    videoId: 'e2eFixture1',
                    status: 'detected',
                    source: 'server_cache',
                    promoBlocks: [{ startSec: 4, endSec: 24 }],
                },
            });

            expect(vm.badgeLabel).toBe('Server cache');
            expect(vm.title).toBe('Server-detected blocks ready');
            expect(vm.statusHeadline).toBe('Server cache hit.');
            expect(vm.statusBody).toBe('0:04–0:24');
        },
    );

    it.each(['downloading', 'unavailable', 'downloadable'] as const)(
        'server no-promo terminal state takes precedence over Chrome %s state',
        (chromeModelAvailability) => {
            const vm = buildPopupViewModel({
                ...baseArgs,
                providerId: 'chrome-prompt-api',
                providerDisplayName: 'Chrome Built-in',
                modelDisplayName: 'Gemini Nano',
                chromeModelAvailability,
                detectionState: {
                    videoId: 'dQw4w9WgXcQ',
                    status: 'no_promo',
                    source: 'server',
                },
            });

            expect(vm.title).toBe('Server analysis complete');
            expect(vm.statusHeadline).toBe('No server promo blocks detected.');
        },
    );

    it.each(['downloading', 'unavailable', 'downloadable'] as const)(
        'server unavailable terminal state takes precedence over Chrome %s state',
        (chromeModelAvailability) => {
            const vm = buildPopupViewModel({
                ...baseArgs,
                providerId: 'chrome-prompt-api',
                providerDisplayName: 'Chrome Built-in',
                modelDisplayName: 'Gemini Nano',
                chromeModelAvailability,
                detectionState: {
                    videoId: 'dQw4w9WgXcQ',
                    status: 'unavailable',
                    source: 'server',
                    error: 'Fixture analysis is unavailable.',
                },
            });

            expect(vm.title).toBe('Server analysis unavailable');
            expect(vm.statusHeadline).toBe('Fixture analysis is unavailable.');
            expect(vm.statusBody).toContain('server-detected skips');
        },
    );

    it('paused state uses disabled tone and copy', () => {
        const vm = buildPopupViewModel({
            ...baseArgs,
            enabled: false,
        });

        expect(vm.tone).toBe('paused');
        expect(vm.title).toBe('TopSkip is paused');
        expect(vm.activityLabel).toBe('Promo detection paused');
        expect(vm.statusHeadline).toContain('currently off');
    });

    it('chrome available falls back to detection logic', () => {
        const vm = buildPopupViewModel({
            ...baseArgs,
            providerId: 'chrome-prompt-api',
            providerDisplayName: 'Chrome Built-in',
            modelDisplayName: 'Gemini Nano',
            chromeModelAvailability: 'available',
            detectionState: { videoId: 'v1', status: 'analyzing' },
        });

        expect(vm.statusHeadline).toBe('Analysis is in progress.');
    });

    it('detected state exposes block count title for compact popup summary', () => {
        const vm = buildPopupViewModel({
            ...baseArgs,
            detectionState: {
                videoId: 'v1',
                status: 'detected',
                promoBlocks: [
                    { startSec: 92, endSec: 125 },
                    { startSec: 490, endSec: 522 },
                ],
            },
        });

        expect(vm.badgeLabel).toBe('Detected');
        expect(vm.title).toBe('2 promo blocks found');
        expect(vm.statusHeadline).toBe('Detected windows');
        expect(vm.statusBody).toContain('1:32');
        expect(vm.statusBody).toContain('8:10');
    });

    it('no promo state remains positive without detected block wording', () => {
        const vm = buildPopupViewModel({
            ...baseArgs,
            detectionState: { videoId: 'v1', status: 'no_promo' },
        });

        expect(vm.tone).toBe('success');
        expect(vm.badgeLabel).toBe('Clear');
        expect(vm.title).toBe('Watching clean');
        expect(vm.statusHeadline).toBe('No promo blocks detected.');
    });

    it('detected block summary formats exact start and end timecodes', () => {
        const vm = buildPopupViewModel({
            ...baseArgs,
            detectionState: {
                videoId: 'v1',
                status: 'detected',
                promoBlocks: [{ startSec: 92, endSec: 125 }],
            },
        });

        expect(vm.statusBody).toBe('1:32–2:05');
    });
});
