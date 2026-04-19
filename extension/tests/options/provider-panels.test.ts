import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MantineProvider } from '@mantine/core';

import { ChromeBuiltinOnboarding } from '@/options/ChromeBuiltinOnboarding';
import { OpenRouterConfigPanel } from '@/options/OpenRouterConfigPanel';
import { topskipTheme } from '@/shared/theme';

function renderWithMantine(element: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(
    createElement(
      MantineProvider,
      { theme: topskipTheme, defaultColorScheme: 'auto' },
      element,
    ),
  );
}

describe('provider panels', () => {
  it('renders the OpenRouter panel with required props', () => {
    const html = renderWithMantine(
      createElement(OpenRouterConfigPanel, {
        apiKey: '',
        apiKeyVisible: false,
        savedApiKeyMasked: null,
        modelChoice: 'google/gemini-2.5-flash-lite',
        modelSelectData: [
          {
            value: 'google/gemini-2.5-flash-lite',
            label: 'google/gemini-2.5-flash-lite',
          },
        ],
        customModels: [],
        newModelDraft: '',
        addBusy: false,
        removeBusySlug: null,
        validationError: null,
        unverifiedModels: new Set<string>(),
        onApiKeyChange: () => {},
        onToggleApiKeyVisibility: () => {},
        onModelChoiceChange: () => {},
        onNewModelDraftChange: () => {},
        onAddCustomModel: () => {},
        onRemoveCustomModel: () => {},
      }),
    );

    expect(html).toContain('Custom models');
    expect(html).toContain('Secure connection');
  });
});

describe('ChromeBuiltinOnboarding', () => {
  it('renders unavailable state with requirements text', () => {
    const html = renderWithMantine(
      createElement(ChromeBuiltinOnboarding, {
        availability: 'unavailable',
        downloadProgress: null,
        onDownload: () => {},
      }),
    );

    expect(html).toContain('not available');
    expect(html).toContain('Chrome 138');
  });

  it('renders downloadable state with download button', () => {
    const html = renderWithMantine(
      createElement(ChromeBuiltinOnboarding, {
        availability: 'downloadable',
        downloadProgress: null,
        onDownload: () => {},
      }),
    );

    expect(html).toContain('Download model');
    expect(html).toContain('Gemini Nano');
    expect(html).toContain('no data leaves');
  });

  it('renders downloading state with progress', () => {
    const html = renderWithMantine(
      createElement(ChromeBuiltinOnboarding, {
        availability: 'downloading',
        downloadProgress: 42,
        onDownload: () => {},
      }),
    );

    expect(html).toContain('42%');
  });

  it('renders downloading state with retry when progress is null', () => {
    const html = renderWithMantine(
      createElement(ChromeBuiltinOnboarding, {
        availability: 'downloading',
        downloadProgress: null,
        onDownload: () => {},
      }),
    );

    expect(html).toContain('Retry');
  });

  it('renders available state with Ready badge', () => {
    const html = renderWithMantine(
      createElement(ChromeBuiltinOnboarding, {
        availability: 'available',
        downloadProgress: null,
        onDownload: () => {},
      }),
    );

    expect(html).toContain('Ready');
    expect(html).toContain('ready to use');
  });
});