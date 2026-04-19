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
    expect(vm.providerLabel).toBe(
      'OpenRouter · google/gemini-2.0-flash',
    );
  });

  it(
    'providerLabel omits separator when modelDisplayName is empty',
    () => {
      const vm = buildPopupViewModel({
        ...baseArgs,
        modelDisplayName: '',
      });
      expect(vm.providerLabel).toBe('OpenRouter');
    },
  );

  it('not_configured description includes provider name', () => {
    const vm = buildPopupViewModel({
      ...baseArgs,
      detectionState: {
        videoId: 'v1',
        status: 'not_configured',
      },
    });
    expect(vm.description).toContain('OpenRouter');
    expect(vm.providerLabel).toBe(
      'OpenRouter · google/gemini-2.0-flash',
    );
  });

  it(
    'Chrome Built-in provider label shows correct string',
    () => {
      const vm = buildPopupViewModel({
        ...baseArgs,
        providerDisplayName: 'Chrome Built-in',
        modelDisplayName: 'Gemini Nano',
        detectionState: { videoId: 'v1', status: 'analyzing' },
      });
      expect(vm.providerLabel).toBe('Chrome Built-in · Gemini Nano');
    },
  );

  it(
    'openrouter not_configured with empty model shows name only',
    () => {
      const vm = buildPopupViewModel({
        ...baseArgs,
        modelDisplayName: '',
        detectionState: {
          videoId: 'v1',
          status: 'not_configured',
        },
      });
      expect(vm.providerLabel).toBe('OpenRouter');
    },
  );

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
});
