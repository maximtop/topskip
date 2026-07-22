import { describe, expect, it, vi } from 'vitest';

import {
    buildPopupViewModel,
    chooseMonotonicDetectionSnapshot,
} from '@/popup/PopupApp';
import { ANALYSIS_MODE } from '@/shared/constants';
import type { PromoDetectionStatePayload } from '@/shared/messages';

const SERVER_SESSION_ID = '00000000-0000-4000-8000-000000000001';

vi.mock('@/shared/browser', () => ({
    default: {
        i18n: {
            getMessage: vi.fn(
                (key: string, substitutions?: Record<string, string>) => {
                    const messages: Record<string, string> = {
                        popup_detection_server_acquisition_badge: 'Captions',
                        popup_detection_server_acquisition_title:
                            'Getting captions',
                        popup_detection_server_acquisition_description:
                            'TopSkip is reading timed captions from this video.',
                        popup_detection_server_acquisition_headline:
                            'Getting video captions…',
                        popup_detection_server_acquisition_body:
                            'Promo analysis will start as soon as captions are ready.',
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
                        popup_detection_server_cache_headline:
                            'Server cache hit.',
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
                        popup_server_limitation_title:
                            'This video could not be analyzed',
                        popup_server_limitation_description:
                            'Your TopSkip settings are working.',
                        popup_server_limitation_headline:
                            'TopSkip could not process this video.',
                        popup_server_limitation_body:
                            'Playback continues without server-detected skips.',
                        popup_server_temporary_title:
                            'TopSkip Server is temporarily busy',
                        popup_server_temporary_description:
                            'Your settings are working. Try again later.',
                        popup_server_temporary_headline:
                            'Server capacity is temporarily unavailable.',
                        popup_server_temporary_body:
                            'Try this video again later.',
                        popup_server_temporary_retry:
                            'Try again in %seconds% seconds.',
                        popup_server_failure_title: 'TopSkip Server error',
                        popup_server_failure_description:
                            'The problem is on the TopSkip server, not in your settings.',
                        popup_server_failure_headline:
                            'The server could not analyze this video.',
                        popup_server_failure_body:
                            'Playback continues normally. You can report this error on GitHub.',
                        popup_server_upgrade_title: 'Update TopSkip',
                        popup_server_upgrade_description:
                            'This server version requires a newer extension.',
                        popup_server_upgrade_headline:
                            'An extension update is required.',
                        popup_server_upgrade_body:
                            'Update TopSkip and try this video again.',
                        popup_server_report_primary: 'Report on GitHub',
                        popup_server_report_secondary:
                            'Report if this seems wrong',
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
                    let message = messages[key] ?? key;
                    for (const [name, value] of Object.entries(
                        substitutions ?? {},
                    )) {
                        message = message.replace(`%${name}%`, value);
                    }
                    return message;
                },
            ),
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
        {
            videoId: 'v1',
            status: 'analyzing',
            source: 'server',
            sessionId: SERVER_SESSION_ID,
            serverAnalysisPhase: 'server_analysis',
        },
        {
            videoId: 'v1',
            status: 'detected',
            source: 'server_cache',
            sessionId: SERVER_SESSION_ID,
            promoBlocks: [{ startSec: 4, endSec: 20 }],
        },
        {
            videoId: 'v1',
            status: 'no_promo',
            source: 'server',
            sessionId: SERVER_SESSION_ID,
        },
        {
            videoId: 'v1',
            status: 'error',
            source: 'server',
            sessionId: SERVER_SESSION_ID,
        },
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

    it.each(['', '   '])(
        'uses the BYOK fallback while provider metadata is %j',
        (providerDisplayName) => {
            const vm = buildPopupViewModel({
                ...baseArgs,
                analysisMode: ANALYSIS_MODE.Byok,
                providerDisplayName,
                detectionState: {
                    videoId: 'v1',
                    status: 'not_configured',
                    source: 'local_provider',
                },
            });

            expect(vm.description).toBe(
                'Configure Private BYOK in settings before promo analysis can run.',
            );
        },
    );

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
                sessionId: SERVER_SESSION_ID,
                serverAnalysisPhase: 'server_analysis',
            },
        });

        expect(vm.title).toBe('Server analysis pending');
        expect(vm.statusHeadline).toBe('Server analysis is in progress.');
        expect(vm.statusBody).toContain('TopSkip backend');
    });

    it('distinguishes caption acquisition from server analysis', () => {
        const vm = buildPopupViewModel({
            ...baseArgs,
            detectionState: {
                videoId: 'dQw4w9WgXcQ',
                sessionId: SERVER_SESSION_ID,
                status: 'analyzing',
                source: 'server',
                serverAnalysisPhase: 'caption_acquisition',
            },
        });

        expect(vm.title).toBe('Getting captions');
        expect(vm.statusHeadline).toBe('Getting video captions…');
        expect(`${vm.description} ${vm.statusBody}`).not.toMatch(
            /backend|server analysis/i,
        );
    });

    it('never chooses an earlier phase from the same session', () => {
        const sessionId = SERVER_SESSION_ID;
        const acquisition = {
            videoId: 'dQw4w9WgXcQ',
            sessionId,
            status: 'analyzing',
            source: 'server',
            serverAnalysisPhase: 'caption_acquisition',
        } as const;
        const analysis = {
            ...acquisition,
            serverAnalysisPhase: 'server_analysis',
        } as const;
        const terminal = {
            videoId: 'dQw4w9WgXcQ',
            sessionId,
            status: 'no_promo',
            source: 'server',
        } as const;

        expect(chooseMonotonicDetectionSnapshot(analysis, acquisition)).toBe(
            analysis,
        );
        expect(chooseMonotonicDetectionSnapshot(terminal, analysis)).toBe(
            terminal,
        );
        expect(chooseMonotonicDetectionSnapshot(acquisition, analysis)).toBe(
            analysis,
        );
        expect(chooseMonotonicDetectionSnapshot(analysis, terminal)).toBe(
            terminal,
        );
    });

    it('server error state explains the backend failure path', () => {
        const vm = buildPopupViewModel({
            ...baseArgs,
            detectionState: {
                videoId: 'dQw4w9WgXcQ',
                status: 'error',
                source: 'server',
                sessionId: SERVER_SESSION_ID,
                serverFailure: {
                    code: 'invalid_server_response',
                    supportId: 'support-123',
                    apiVersion: 1,
                    algorithmVersion: 'server-v6',
                    extensionVersion: '0.1.0',
                },
            },
        });

        expect(vm.title).toBe('TopSkip Server error');
        expect(vm.description).toContain('not in your settings');
        expect(vm.statusHeadline).toBe(
            'The server could not analyze this video.',
        );
        expect(vm.statusBody).not.toContain('support-123');
        expect(vm.reportAction).toBe('primary');
        expect(vm.reportLabel).toBe('Report on GitHub');
    });

    it('does not label a freshly polled server result as a cache hit', () => {
        const vm = buildPopupViewModel({
            ...baseArgs,
            detectionState: {
                videoId: 'dQw4w9WgXcQ',
                status: 'detected',
                source: 'server',
                sessionId: SERVER_SESSION_ID,
                durationSec: 213,
                promoBlocks: [{ startSec: 4, endSec: 24 }],
            },
        });

        expect(vm.title).toBe('1 promo block found');
        expect(vm.badgeLabel).toBe('Detected');
        expect(`${vm.title} ${vm.statusHeadline}`).not.toMatch(/cache/i);
    });

    it('server rate-limit state explains that skipping remains server-only', () => {
        const vm = buildPopupViewModel({
            ...baseArgs,
            detectionState: {
                videoId: 'dQw4w9WgXcQ',
                status: 'unavailable',
                source: 'server',
                sessionId: SERVER_SESSION_ID,
                serverFailure: {
                    code: 'rate_limited',
                    retryAfterSec: 60,
                    apiVersion: 1,
                    extensionVersion: '0.1.0',
                },
            },
        });

        expect(vm.title).toBe('TopSkip Server is temporarily busy');
        expect(vm.statusBody).toBe('Try again in 60 seconds.');
        expect(vm.reportAction).toBeUndefined();
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
                    sessionId: SERVER_SESSION_ID,
                    promoBlocks: [{ startSec: 4, endSec: 24 }],
                },
            });

            expect(vm.badgeLabel).toBe('Server cache');
            expect(vm.title).toBe('Server-detected blocks ready');
            expect(vm.statusHeadline).toBe('Server cache hit.');
            expect(vm.statusBody).toBe('0:04–0:24');
        },
    );

    it('shows video limitations as not caused by user settings', () => {
        const vm = buildPopupViewModel({
            ...baseArgs,
            detectionState: {
                videoId: 'dQw4w9WgXcQ',
                status: 'unavailable',
                source: 'server',
                sessionId: SERVER_SESSION_ID,
                serverFailure: {
                    code: 'captions_unavailable',
                    apiVersion: 1,
                    extensionVersion: '0.1.0',
                },
            },
        });

        expect(vm.title).toBe('This video could not be analyzed');
        expect(vm.description).toContain('settings are working');
        expect(vm.reportAction).toBe('secondary');
        expect(vm.reportLabel).toBe('Report if this seems wrong');
    });

    it('shows upgrade-required without offering a GitHub report', () => {
        const vm = buildPopupViewModel({
            ...baseArgs,
            detectionState: {
                videoId: 'dQw4w9WgXcQ',
                status: 'unavailable',
                source: 'server',
                sessionId: SERVER_SESSION_ID,
                serverFailure: {
                    code: 'client_upgrade_required',
                    apiVersion: 1,
                    extensionVersion: '0.1.0',
                },
            },
        });

        expect(vm.title).toBe('Update TopSkip');
        expect(vm.reportAction).toBeUndefined();
    });

    it('shows every server-detected Gemini interval with existing popup formatting', () => {
        const vm = buildPopupViewModel({
            ...baseArgs,
            detectionState: {
                videoId: 'dQw4w9WgXcQ',
                status: 'detected',
                source: 'server_cache',
                sessionId: SERVER_SESSION_ID,
                promoBlocks: [
                    { startSec: 242.12, endSec: 329.44 },
                    { startSec: 826.56, endSec: 943.519 },
                    { startSec: 1_583.679, endSec: 1_611.72 },
                ],
            },
        });

        expect(vm.statusBody).toBe('4:02–5:29; 13:46–15:43; 26:23–26:51');
        expect(vm.modeLabel).toBe('TopSkip Server');
    });

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
                    sessionId: SERVER_SESSION_ID,
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
                    sessionId: SERVER_SESSION_ID,
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
