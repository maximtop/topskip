import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ActivityIcon } from '@/shared/topskip-icons';

describe('ActivityIcon', () => {
    it('renders a decorative stroke icon at the requested size and color', () => {
        const html = renderToStaticMarkup(
            createElement(ActivityIcon, { size: 16, color: '#2563eb' }),
        );

        expect(html).toContain('<svg');
        expect(html).toContain('width="16"');
        expect(html).toContain('height="16"');
        expect(html).toContain('stroke="#2563eb"');
        expect(html).toContain('aria-hidden="true"');
        expect(html).toContain('d="M22 12h-4l-3 9L9 3l-3 9H2"');
    });

    it('falls back to currentColor like the other sidebar icons', () => {
        const html = renderToStaticMarkup(
            createElement(ActivityIcon, { size: 20 }),
        );

        expect(html).toContain('stroke="currentColor"');
    });
});
