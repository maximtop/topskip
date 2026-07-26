import { MantineProvider } from '@mantine/core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/browser', () => ({
    default: {
        i18n: {
            getMessage: vi.fn((key: string) => {
                const messages: Record<string, string> = {
                    options_analysis_mode_heading: 'Analysis mode',
                    options_analysis_mode_server_label: 'TopSkip Server',
                    options_analysis_mode_server_description:
                        'Uses TopSkip analysis and shared cached results.',
                    options_analysis_mode_byok_label: 'Private BYOK',
                    options_analysis_mode_byok_description:
                        'Uses your configured provider in this extension.',
                    options_analysis_mode_byok_privacy:
                        'TopSkip Server is never used as a fallback in this mode.',
                    options_connections_heading: 'Connections',
                    options_connections_description:
                        'Save and test API keys for cloud models.',
                    options_connection_required_badge:
                        'Required for selected model',
                    options_connection_key_saved: 'Key saved',
                    options_connection_key_missing: 'Key missing',
                    options_connection_key_placeholder: 'Enter API key',
                    options_connection_test_button: 'Test',
                    options_connection_key_valid: 'Key is valid.',
                };
                return messages[key] ?? key;
            }),
        },
    },
}));

import { AnalysisModePanel } from '@/options/AnalysisModePanel';
import { ConnectionsPanel } from '@/options/ConnectionsPanel';
import { ModelSelectionPanel } from '@/options/ModelSelectionPanel';
import { shouldShowByokSettings } from '@/options/options';
import { ANALYSIS_MODE } from '@/shared/constants';
import { topskipTheme } from '@/shared/theme';

function render(element: ReturnType<typeof createElement>): string {
    return renderToStaticMarkup(
        createElement(MantineProvider, { theme: topskipTheme }, element),
    );
}

describe('model-first settings panels', () => {
    it.each([
        [ANALYSIS_MODE.Server, 'TopSkip Server'],
        [ANALYSIS_MODE.Byok, 'Private BYOK'],
    ] as const)('renders the explicit %s mode selector', (value, label) => {
        const html = render(
            createElement(AnalysisModePanel, {
                value,
                disabled: false,
                onChange: () => {},
            }),
        );

        expect(html).toContain('Analysis mode');
        expect(html).toContain('TopSkip Server');
        expect(html).toContain('Private BYOK');
        expect(html).toContain(label);
        expect(html).toContain('role="radiogroup"');
        expect(html).toContain(
            value === ANALYSIS_MODE.Byok
                ? 'Uses your configured provider in this extension.'
                : 'Uses TopSkip analysis and shared cached results.',
        );
    });

    it('reveals retained provider controls only in Private BYOK mode', () => {
        expect(shouldShowByokSettings(ANALYSIS_MODE.Server)).toBe(false);
        expect(shouldShowByokSettings(ANALYSIS_MODE.Byok)).toBe(true);
    });

    it('renders model choice without provider cards', () => {
        const html = render(
            createElement(ModelSelectionPanel, {
                activeModelId: 'openai:gpt-5.2',
                models: [
                    {
                        id: 'openai:gpt-5.2',
                        label: 'GPT-5.2',
                        providerId: 'openai',
                        providerLabel: 'OpenAI',
                        modelName: 'gpt-5.2',
                        requiresConnection: true,
                        availability: 'available',
                    },
                ],
                missingConnectionProviderId: null,
                onModelChange: () => {},
                onOpenConnection: () => {},
            }),
        );
        expect(html).toContain('Detection model');
        expect(html).toContain('GPT-5.2');
        expect(html).not.toContain('Promo-detection provider');
    });

    it('renders OpenRouter and OpenAI connection test buttons', () => {
        const html = render(
            createElement(ConnectionsPanel, {
                connections: [
                    {
                        providerId: 'openrouter',
                        providerLabel: 'OpenRouter',
                        requiredForActiveModel: false,
                        apiKeyMasked: null,
                        status: 'missing',
                    },
                    {
                        providerId: 'openai',
                        providerLabel: 'OpenAI',
                        requiredForActiveModel: true,
                        apiKeyMasked: '****1234',
                        status: 'saved',
                    },
                ],
                drafts: { openrouter: '', openai: '' },
                busyProviderId: null,
                testStates: {},
                onDraftChange: () => {},
                onSave: () => {},
                onTest: () => {},
            }),
        );
        expect(html).toContain('Connections');
        expect(html).toContain('OpenAI');
        expect(html).toContain('Test');
        expect(html).toContain('Required for selected model');
    });
});
