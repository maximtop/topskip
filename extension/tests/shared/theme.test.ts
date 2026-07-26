import { describe, expect, it } from 'vitest';

import { topskipTheme } from '@/shared/theme';

describe('topskipTheme', () => {
    it('exports a theme object', () => {
        expect(topskipTheme).toBeDefined();
        expect(typeof topskipTheme).toBe('object');
    });

    it('sets a custom primary color (not default blue)', () => {
        expect(topskipTheme.primaryColor).toBeDefined();
        expect(topskipTheme.primaryColor).not.toBe('blue');
    });

    it('defines the primary color scale with 10 shades', () => {
        const name = topskipTheme.primaryColor!;
        const scale = topskipTheme.colors?.[name];
        expect(scale).toBeDefined();
        expect(scale).toHaveLength(10);
        for (const shade of scale!) {
            expect(shade).toMatch(/^#[0-9a-fA-F]{6}$/);
        }
    });

    it('defines semantic color scales (success, warning, error)', () => {
        for (const name of ['success', 'warning', 'error']) {
            const scale = topskipTheme.colors?.[name];
            expect(scale, `missing color scale: ${name}`).toBeDefined();
            expect(scale, `${name} must have 10 shades`).toHaveLength(10);
        }
    });

    it('uses a system font stack (no web fonts)', () => {
        expect(topskipTheme.fontFamily).toBeDefined();
        expect(topskipTheme.fontFamily).toContain('system-ui');
        expect(topskipTheme.fontFamily).not.toContain('Inter');
    });

    it('defines fontSizes with at least xs, sm, md, lg, xl', () => {
        const fs = topskipTheme.fontSizes;
        expect(fs).toBeDefined();
        for (const key of ['xs', 'sm', 'md', 'lg', 'xl']) {
            expect(fs?.[key], `missing fontSizes.${key}`).toBeDefined();
        }
    });

    it('defines lineHeights with at least xs, sm, md, lg, xl', () => {
        const lh = topskipTheme.lineHeights;
        expect(lh).toBeDefined();
        for (const key of ['xs', 'sm', 'md', 'lg', 'xl']) {
            expect(lh?.[key], `missing lineHeights.${key}`).toBeDefined();
        }
    });

    it('defines spacing scale', () => {
        const sp = topskipTheme.spacing;
        expect(sp).toBeDefined();
        for (const key of ['xs', 'sm', 'md', 'lg', 'xl']) {
            expect(sp?.[key], `missing spacing.${key}`).toBeDefined();
        }
    });

    it('defines radius scale and a default radius', () => {
        expect(topskipTheme.radius).toBeDefined();
        expect(topskipTheme.defaultRadius).toBeDefined();
    });

    it('enables autoContrast', () => {
        expect(topskipTheme.autoContrast).toBe(true);
    });

    it('enables respectReducedMotion', () => {
        expect(topskipTheme.respectReducedMotion).toBe(true);
    });

    it('toast hardcoded tokens align with theme', () => {
        // The content-script toast (youtube-watch.ts) hardcodes CSS values that
        // must match the theme. If any of these fail, update the toast inline
        // styles to match.
        expect(topskipTheme.fontSizes?.sm).toBe('0.8125rem');
        expect(topskipTheme.lineHeights?.sm).toBe('1.4');
        expect(topskipTheme.spacing?.sm).toBe('0.625rem');
        expect(topskipTheme.spacing?.md).toBe('1rem');
        expect(topskipTheme.radius?.md).toBe('0.5rem');
        expect(topskipTheme.fontFamily).toContain('system-ui');
    });

    it('defines component defaults for key components', () => {
        const comps = topskipTheme.components;
        expect(comps).toBeDefined();
        for (const name of [
            'Button',
            'TextInput',
            'Select',
            'Switch',
            'Checkbox',
            'Alert',
            'Text',
            'Stack',
        ]) {
            expect(
                comps?.[name],
                `missing component default: ${name}`,
            ).toBeDefined();
        }
    });
});
