import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MantineProvider } from '@mantine/core';

vi.mock('@/shared/browser', () => ({
    default: {
        i18n: {
            getMessage: vi.fn((key: string) => {
                const messages: Record<string, string> = {
                    options_section_general: 'General',
                    options_section_detection: 'Detection',
                    options_section_appearance: 'Appearance',
                    options_section_shortcuts: 'Shortcuts',
                    options_section_diagnostics: 'Diagnostics',
                    options_section_about: 'About',
                    options_sidebar_nav_aria: 'Settings sections',
                    options_placeholder_notice:
                        '%section% settings are visible for navigation preview, but not configurable yet.',
                    options_about_heading: 'About TopSkip',
                    options_about_description:
                        'Automatically skip detected sponsor and promo segments on YouTube.',
                    options_about_version_label: 'Version',
                };
                return messages[key] ?? key;
            }),
        },
        runtime: {
            sendMessage: vi.fn(),
            connect: vi.fn(),
            onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
            openOptionsPage: vi.fn(),
            getManifest: vi.fn(() => ({ version: '0.1.0' })),
        },
    },
}));

import { ChromeBuiltinOnboarding } from '@/options/ChromeBuiltinOnboarding';
import { OpenRouterConfigPanel } from '@/options/OpenRouterConfigPanel';
import {
    AboutSettingsSection,
    OptionsSidebar,
    PlaceholderSettingsSection,
    ProviderChoiceCards,
    getOptionsSectionLabel,
    parseOptionsSectionHash,
} from '@/options/options';
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
    it('renders the redesigned OpenRouter panel with key, preset, and custom models', () => {
        const html = renderWithMantine(
            createElement(OpenRouterConfigPanel, {
                apiKey: '',
                apiKeyVisible: false,
                savedApiKeyMasked: 'sk-or-...abcd',
                modelChoice: 'openai/gpt-4.1-mini',
                modelSelectData: [
                    {
                        value: 'openai/gpt-4.1-mini',
                        label: 'openai/gpt-4.1-mini',
                    },
                    {
                        value: 'meta-llama/llama-3.1-8b-instruct',
                        label: 'meta-llama/llama-3.1-8b-instruct',
                    },
                ],
                customModels: ['meta-llama/llama-3.1-8b-instruct'],
                newModelDraft: '',
                addBusy: false,
                saveBusy: false,
                removeBusySlug: null,
                editingModelSlug: null,
                editingModelDraft: '',
                updateBusySlug: null,
                validationError: null,
                unverifiedModels: new Set<string>(),
                onApiKeyChange: () => {},
                onToggleApiKeyVisibility: () => {},
                onModelChoiceChange: () => {},
                onNewModelDraftChange: () => {},
                onSave: () => {},
                onAddCustomModel: () => {},
                onEditCustomModel: () => {},
                onEditCustomModelDraftChange: () => {},
                onSaveCustomModelEdit: () => {},
                onCancelCustomModelEdit: () => {},
                onRemoveCustomModel: () => {},
            }),
        );

        expect(html).toContain('OpenRouter BYOK settings');
        expect(html).toContain('Key saved');
        expect(html).toContain('Save key');
        expect(html).toContain('Built-in model presets');
        expect(html).toContain('Custom OpenRouter models');
        expect(html).toContain('meta-llama/llama-3.1-8b-instruct');
        expect(html).toContain('Edit');
        expect(html).toContain('Delete');
    });

    it('renders custom model edits inline in the saved row', () => {
        const html = renderWithMantine(
            createElement(OpenRouterConfigPanel, {
                apiKey: '',
                apiKeyVisible: false,
                savedApiKeyMasked: 'sk-or-...abcd',
                modelChoice: 'openai/gpt-4.1-mini',
                modelSelectData: [
                    {
                        value: 'openai/gpt-4.1-mini',
                        label: 'openai/gpt-4.1-mini',
                    },
                ],
                customModels: ['meta-llama/llama-3.1-8b-instruct'],
                newModelDraft: '',
                addBusy: false,
                saveBusy: false,
                removeBusySlug: null,
                editingModelSlug: 'meta-llama/llama-3.1-8b-instruct',
                editingModelDraft: 'meta-llama/llama-3.1-70b-instruct',
                updateBusySlug: null,
                validationError: null,
                unverifiedModels: new Set<string>(),
                onApiKeyChange: () => {},
                onToggleApiKeyVisibility: () => {},
                onModelChoiceChange: () => {},
                onNewModelDraftChange: () => {},
                onSave: () => {},
                onAddCustomModel: () => {},
                onEditCustomModel: () => {},
                onEditCustomModelDraftChange: () => {},
                onSaveCustomModelEdit: () => {},
                onCancelCustomModelEdit: () => {},
                onRemoveCustomModel: () => {},
            }),
        );

        expect(html).toContain('aria-label="Edit meta-llama');
        expect(html).toContain('meta-llama/llama-3.1-70b-instruct');
        expect(html).toContain('Save');
        expect(html).toContain('Cancel');
    });
});

describe('OptionsSidebar', () => {
    it('renders every section in order with the active one marked', () => {
        const html = renderWithMantine(
            createElement(OptionsSidebar, {
                activeSection: 'general',
                onSectionChange: () => {},
            }),
        );

        expect(html).toContain('TopSkip');
        expect(html).toContain('aria-label="Settings sections"');
        const order = [
            'General',
            'Detection',
            'Appearance',
            'Shortcuts',
            'Diagnostics',
            'About',
        ].map((label) => html.indexOf(`>${label}<`));
        expect(order.every((index) => index >= 0)).toBe(true);
        expect(order).toEqual([...order].sort((a, b) => a - b));
        expect(html).toContain('aria-current="page"');
        expect(html).not.toContain('Setup guide');
    });
});

describe('parseOptionsSectionHash', () => {
    it('resolves known section hashes and rejects everything else', () => {
        expect(parseOptionsSectionHash('#diagnostics')).toBe('diagnostics');
        expect(parseOptionsSectionHash('#about')).toBe('about');
        expect(parseOptionsSectionHash('diagnostics')).toBe('diagnostics');
        expect(parseOptionsSectionHash('#nope')).toBeNull();
        expect(parseOptionsSectionHash('')).toBeNull();
        expect(parseOptionsSectionHash('#')).toBeNull();
    });
});

describe('getOptionsSectionLabel', () => {
    it('returns the localized label for a section', () => {
        expect(getOptionsSectionLabel('diagnostics')).toBe('Diagnostics');
        expect(getOptionsSectionLabel('general')).toBe('General');
    });
});

describe('PlaceholderSettingsSection', () => {
    it('renders safe placeholder copy for Detection', () => {
        const html = renderWithMantine(
            createElement(PlaceholderSettingsSection, {
                sectionId: 'detection',
            }),
        );

        expect(html).toContain('Detection');
        expect(html).toContain(
            'Detection settings are visible for navigation preview, but not configurable yet.',
        );
    });

    it('no longer accepts the Diagnostics section', () => {
        const props: Parameters<typeof PlaceholderSettingsSection>[0] = {
            // @ts-expect-error — Diagnostics has a real section now.
            sectionId: 'diagnostics',
        };
        expect(props.sectionId).toBe('diagnostics');
    });
});

describe('AboutSettingsSection', () => {
    it('renders minimal extension metadata', () => {
        const html = renderWithMantine(
            createElement(AboutSettingsSection, {
                extensionVersion: '2.3.4',
            }),
        );

        expect(html).toContain('About TopSkip');
        expect(html).toContain('Automatically skip detected sponsor');
        expect(html).toContain('Version');
        expect(html).toContain('v2.3.4');
    });
});

describe('ProviderChoiceCards', () => {
    it('renders OpenRouter and Chrome provider cards with selected radio state', () => {
        const html = renderWithMantine(
            createElement(ProviderChoiceCards, {
                providers: [
                    {
                        id: 'chrome-prompt-api',
                        displayName: 'Chrome Built-in',
                        availability: 'available',
                    },
                    {
                        id: 'openrouter',
                        displayName: 'OpenRouter',
                        availability: 'available',
                    },
                ],
                activeProviderId: 'openrouter',
                onProviderChange: () => {},
            }),
        );

        expect(html).toContain('Chrome Built-in Prompt API');
        expect(html).toContain('OpenRouter BYOK');
        expect(html).toContain('Use Chrome');
        expect(html).toContain('Use OpenRouter');
        expect(html).toContain('aria-checked="true"');
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
