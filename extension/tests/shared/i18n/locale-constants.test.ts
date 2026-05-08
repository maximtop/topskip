import { describe, it, expect } from 'vitest';

import {
    AVAILABLE_LOCALES,
    BASE_LOCALE,
    LANGUAGE_NAMES,
    type AvailableLocale,
} from '@/shared/i18n/locale-constants';

describe('locale-constants', () => {
    it('BASE_LOCALE is "en"', () => {
        expect(BASE_LOCALE).toBe('en');
    });

    it('AVAILABLE_LOCALES contains exactly 20 entries', () => {
        expect(AVAILABLE_LOCALES).toHaveLength(20);
    });

    it('AVAILABLE_LOCALES is sorted alphabetically', () => {
        const sorted = [...AVAILABLE_LOCALES].sort();
        expect(AVAILABLE_LOCALES).toEqual(sorted);
    });

    it('AVAILABLE_LOCALES includes expected locales', () => {
        const expected: AvailableLocale[] = [
            'ar',
            'de',
            'en',
            'es',
            'fr',
            'hi',
            'id',
            'it',
            'ja',
            'ko',
            'nl',
            'pl',
            'pt_BR',
            'ru',
            'th',
            'tr',
            'uk',
            'vi',
            'zh_CN',
            'zh_TW',
        ];
        for (const locale of expected) {
            expect(AVAILABLE_LOCALES).toContain(locale);
        }
    });

    it('LANGUAGE_NAMES has an entry for every available locale', () => {
        for (const locale of AVAILABLE_LOCALES) {
            expect(LANGUAGE_NAMES[locale]).toBeDefined();
            expect(typeof LANGUAGE_NAMES[locale]).toBe('string');
            expect(LANGUAGE_NAMES[locale].length).toBeGreaterThan(0);
        }
    });
});
