import { describe, it, expect } from 'vitest';

import { checkLocale } from '@/shared/i18n/check-locale';
import { AVAILABLE_LOCALES } from '@/shared/i18n/locale-constants';

describe('checkLocale', () => {
    it('exact match returns suitable', () => {
        const r = checkLocale(AVAILABLE_LOCALES, 'en');
        expect(r).toEqual({ suitable: true, locale: 'en' });
    });

    it('case-insensitive match: EN → en', () => {
        const r = checkLocale(AVAILABLE_LOCALES, 'EN');
        expect(r).toEqual({ suitable: true, locale: 'en' });
    });

    it('hyphen to underscore: zh-CN → zh_CN', () => {
        const r = checkLocale(AVAILABLE_LOCALES, 'zh-CN');
        expect(r).toEqual({ suitable: true, locale: 'zh_CN' });
    });

    it('BCP 47 three-part: zh-Hant-TW → zh_TW', () => {
        const r = checkLocale(AVAILABLE_LOCALES, 'zh-Hant-TW');
        expect(r).toEqual({ suitable: true, locale: 'zh_TW' });
    });

    it('BCP 47 three-part: zh-Hans-CN → zh_CN', () => {
        const r = checkLocale(AVAILABLE_LOCALES, 'zh-Hans-CN');
        expect(r).toEqual({ suitable: true, locale: 'zh_CN' });
    });

    it('base language match: en-GB → en', () => {
        const r = checkLocale(AVAILABLE_LOCALES, 'en-GB');
        expect(r).toEqual({ suitable: true, locale: 'en' });
    });

    it('pt-BR → pt_BR', () => {
        const r = checkLocale(AVAILABLE_LOCALES, 'pt-BR');
        expect(r).toEqual({ suitable: true, locale: 'pt_BR' });
    });

    it('unsupported locale returns not suitable', () => {
        const r = checkLocale(AVAILABLE_LOCALES, 'sw');
        expect(r).toEqual({ suitable: false, locale: 'sw' });
    });

    it('null input returns not suitable', () => {
        const r = checkLocale(AVAILABLE_LOCALES, null);
        expect(r).toEqual({ suitable: false, locale: '' });
    });

    it('empty string returns not suitable', () => {
        const r = checkLocale(AVAILABLE_LOCALES, '');
        expect(r).toEqual({ suitable: false, locale: '' });
    });
});
