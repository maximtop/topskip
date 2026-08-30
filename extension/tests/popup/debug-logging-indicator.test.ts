import { MantineProvider } from '@mantine/core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DebugLoggingIndicator } from '@/popup/DebugLoggingIndicator';
import { topskipTheme } from '@/shared/theme';

/**
 * Renders inside the popup theme (the provider itself emits `<style>` tags,
 * so the empty case below renders the bare component instead).
 *
 * @param label - Indicator label.
 * @returns Static markup.
 */
function renderWithTheme(label: string): string {
    return renderToStaticMarkup(
        createElement(
            MantineProvider,
            { theme: topskipTheme },
            createElement(DebugLoggingIndicator, { label }),
        ),
    );
}

describe('DebugLoggingIndicator', () => {
    it('renders nothing without a label (unknown status or switch off)', () => {
        expect(
            renderToStaticMarkup(
                createElement(DebugLoggingIndicator, { label: null }),
            ),
        ).toBe('');
    });

    it('renders non-interactive status text with the test id', () => {
        const html = renderWithTheme('Debug logging on');

        expect(html).toContain('data-testid="popup-debug-logging-indicator"');
        expect(html).toContain('role="status"');
        expect(html).toContain('>Debug logging on<');
        // The indicator must not read as a control and adds no footer/version.
        expect(html).not.toContain('<button');
        expect(html).not.toContain('<a ');
        expect(html).not.toContain('popup-footer');
        expect(html).not.toMatch(/version/iu);
    });
});
