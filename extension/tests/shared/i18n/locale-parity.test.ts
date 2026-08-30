import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { AVAILABLE_LOCALES } from '@/shared/i18n/locale-constants';

const LOCALES_DIR = path.resolve(__dirname, '../../../src/_locales');
const REFERENCE_LOCALE = 'en';

/**
 * Reads one `messages.json` as an ordered entry list.
 */
function readMessages(locale: string): Array<[string, { message: string }]> {
    const text = readFileSync(path.join(LOCALES_DIR, locale, 'messages.json'), 'utf8');
    return Object.entries(JSON.parse(text) as Record<string, { message: string }>);
}

describe('locale parity', () => {
    const reference = readMessages(REFERENCE_LOCALE);
    const referenceKeys = reference.map(([key]) => key);

    it('lists 20 locales including the reference', () => {
        expect(AVAILABLE_LOCALES).toHaveLength(20);
        expect(AVAILABLE_LOCALES).toContain(REFERENCE_LOCALE);
    });

    it.each(AVAILABLE_LOCALES)('%s has exactly the reference keys, in order, with non-empty messages', (locale) => {
        const entries = readMessages(locale);
        expect(entries.map(([key]) => key)).toEqual(referenceKeys);
        for (const [key, value] of entries) {
            expect(typeof value.message, key).toBe('string');
            expect(value.message.length, key).toBeGreaterThan(0);
        }
    });
});
