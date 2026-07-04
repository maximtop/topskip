import { describe, expect, it, vi } from 'vitest';

import { buildPopupViewModel } from '@/popup/PopupApp';

vi.mock('@/shared/browser', () => ({
    default: {
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
