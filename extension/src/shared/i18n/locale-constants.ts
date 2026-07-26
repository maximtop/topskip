import twosky from '../../../../.twosky.json';

/**
 * Locale code derived from the `.twosky.json` languages object.
 */
export type AvailableLocale = keyof (typeof twosky)[0]['languages'];

/**
 * Base locale used as fallback when translations are missing.
 */
export const BASE_LOCALE: AvailableLocale = 'en';

/**
 * All supported locale codes, derived from `.twosky.json` languages.
 * Sorted alphabetically.
 */
export const AVAILABLE_LOCALES: AvailableLocale[] = (
    Object.keys(twosky[0].languages) as AvailableLocale[]
).sort();

/**
 * Maps each supported locale code to its native language name.
 */
export const LANGUAGE_NAMES: Record<AvailableLocale, string> = {
    ar: 'العربية',
    de: 'Deutsch',
    en: 'English',
    es: 'Español',
    fr: 'Français',
    hi: 'हिन्दी',
    id: 'Bahasa Indonesia',
    it: 'Italiano',
    ja: '日本語',
    ko: '한국어',
    nl: 'Nederlands',
    pl: 'Polski',
    pt_BR: 'Português (Brasil)',
    ru: 'Русский',
    th: 'ไทย',
    tr: 'Türkçe',
    uk: 'Українська',
    vi: 'Tiếng Việt',
    zh_CN: '简体中文',
    zh_TW: '繁體中文',
};
