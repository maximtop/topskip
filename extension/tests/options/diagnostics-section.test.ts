import { MantineProvider } from '@mantine/core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    sendMessage: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
}));

vi.mock('@/shared/browser', () => ({
    default: {
        i18n: {
            getMessage: vi.fn((key: string) => {
                const messages: Record<string, string> = {
                    options_diagnostics_heading: 'Diagnostics',
                    options_diagnostics_switch_label: 'Debug logging',
                    options_diagnostics_state_loading: 'Loading diagnostics…',
                    options_diagnostics_notice: 'Notice.',
                    options_diagnostics_storage_note: 'Stored up to %cap%.',
                    options_diagnostics_sharing:
                        'Nothing is sent automatically.',
                    options_diagnostics_copy_button: 'Copy log',
                    options_diagnostics_download_button: 'Download log',
                };
                return messages[key] ?? key;
            }),
        },
        runtime: {
            sendMessage: mocks.sendMessage,
            onMessage: {
                addListener: mocks.addListener,
                removeListener: mocks.removeListener,
            },
        },
    },
}));

import { DiagnosticsSection } from '@/options/DiagnosticsSection';
import { topskipTheme } from '@/shared/theme';

/**
 * Extracts one element's opening tag by test id (attribute order varies).
 *
 * @param html - Static markup.
 * @param testId - `data-testid` to find.
 * @returns Opening tag text, or `''` when absent.
 */
function openingTag(html: string, testId: string): string {
    const match = html.match(
        new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`, 'u'),
    );
    return match?.[0] ?? '';
}

describe('DiagnosticsSection', () => {
    it('renders the loading row before any background read and reads nothing during render', () => {
        const html = renderToStaticMarkup(
            createElement(
                MantineProvider,
                { theme: topskipTheme },
                createElement(DiagnosticsSection),
            ),
        );

        expect(html).toContain('data-testid="options-diagnostics-section"');
        expect(html).toContain('Loading diagnostics…');
        expect(html).toContain('Nothing is sent automatically.');
        expect(openingTag(html, 'options-debug-log-switch')).toContain(
            'disabled=""',
        );
        expect(openingTag(html, 'options-debug-log-copy')).toContain(
            'disabled=""',
        );
        // Reads belong to the visibility effect, never to render; a static
        // render must not contact the worker (General's `load()` stays apart).
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        expect(mocks.addListener).not.toHaveBeenCalled();
    });
});
