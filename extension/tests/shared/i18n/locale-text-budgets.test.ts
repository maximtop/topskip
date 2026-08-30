import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEBUG_LOG_POPUP_INDICATOR_MAX_CHARS } from '@/shared/debug-log-constants';
import {
    AVAILABLE_LOCALES,
    BASE_LOCALE,
} from '@/shared/i18n/locale-constants';

const LOCALES_DIR = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../../src/_locales',
);
const MESSAGES_FILE = 'messages.json';
const POPUP_DEBUG_LOGGING_KEY = 'popup_debug_logging_on';
const TEXT_MAX_LENGTH_MARKER = 'TEXT MAX LENGTH:';

/**
 * Reads one catalog entry; a missing key or field fails the test loudly.
 *
 * @param locale - Locale directory name.
 * @param key - Message key.
 * @returns Message and description strings (empty when absent).
 */
function readLocaleEntry(
    locale: string,
    key: string,
): { message: string; description: string } {
    const file = path.join(LOCALES_DIR, locale, MESSAGES_FILE);
    const catalog: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof catalog !== 'object' || catalog === null) {
        throw new Error(`${file}: not an object`);
    }
    const entry: unknown = Reflect.get(catalog, key);
    if (typeof entry !== 'object' || entry === null) {
        throw new Error(`${file}: missing "${key}"`);
    }
    const message: unknown = Reflect.get(entry, 'message');
    const description: unknown = Reflect.get(entry, 'description');
    return {
        message: typeof message === 'string' ? message : '',
        description: typeof description === 'string' ? description : '',
    };
}

describe('locale text budgets', () => {
    it.each(AVAILABLE_LOCALES)(
        '%s keeps the popup debug logging indicator within its budget',
        (locale) => {
            const { message } = readLocaleEntry(locale, POPUP_DEBUG_LOGGING_KEY);
            expect(message.length).toBeGreaterThan(0);
            expect([...message].length).toBeLessThanOrEqual(
                DEBUG_LOG_POPUP_INDICATOR_MAX_CHARS,
            );
        },
    );

    it('pins the English description to the same budget', () => {
        const { description } = readLocaleEntry(
            BASE_LOCALE,
            POPUP_DEBUG_LOGGING_KEY,
        );
        expect(
            description.endsWith(
                `${TEXT_MAX_LENGTH_MARKER} ${DEBUG_LOG_POPUP_INDICATOR_MAX_CHARS}`,
            ),
        ).toBe(true);
    });
});
