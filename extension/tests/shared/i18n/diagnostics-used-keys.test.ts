import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '../../../src');
const EN = JSON.parse(
    readFileSync(path.join(SRC, '_locales/en/messages.json'), 'utf8'),
) as Record<string, unknown>;
/**
 * Files that resolve Diagnostics / popup-indicator copy through
 * `translator.getMessage('<key>', …)`.
 */
const SOURCES = [
    'options/DiagnosticsPanel.tsx',
    'options/options.tsx',
    'popup/PopupApp.tsx',
];
const KEY_LITERAL = /getMessage\(\s*'([a-z0-9_]+)'/gu;

describe('English catalog covers every Diagnostics / popup indicator key (FR-043)', () => {
    it.each(SOURCES)('%s uses only keys present in en', (file) => {
        const text = readFileSync(path.join(SRC, file), 'utf8');
        const used = [...text.matchAll(KEY_LITERAL)].map((m) => m[1]);
        expect(used.length).toBeGreaterThan(0);
        for (const key of used) {
            expect(EN, key).toHaveProperty(key);
        }
    });

    it('the Diagnostics heading and popup indicator keys are among the scanned calls', () => {
        const panel = readFileSync(
            path.join(SRC, 'options/DiagnosticsPanel.tsx'),
            'utf8',
        );
        const popup = readFileSync(
            path.join(SRC, 'popup/PopupApp.tsx'),
            'utf8',
        );
        expect(panel).toContain("getMessage('options_diagnostics_heading')");
        expect(popup).toContain("getMessage('popup_debug_logging_on')");
    });
});
