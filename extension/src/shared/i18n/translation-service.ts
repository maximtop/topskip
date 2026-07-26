import browser from '@/shared/browser';

import {
    type AvailableLocale,
    BASE_LOCALE,
    AVAILABLE_LOCALES,
} from '@/shared/i18n/locale-constants';
import { checkLocale } from '@/shared/i18n/check-locale';

/**
 * Individual message entry in a messages.json file.
 */
interface MessageEntry {
    /**
     * Translated text.
     */
    message: string;
    /**
     * Optional translator context note.
     */
    description?: string;
}

/**
 * Shape of a Chrome extension messages.json file.
 */
type MessagesJson = Record<string, MessageEntry>;

/**
 * Guards that an unknown value has the shape of a `messages.json` file.
 *
 * Extension locale assets are bundled by the same build and always have this
 * shape — this guard proves the type to TypeScript without an unsafe cast.
 *
 * @param value - Value to check.
 * @returns Whether `value` is a record of `MessageEntry` objects.
 */
function isMessagesJson(value: unknown): value is MessagesJson {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    return Object.values(value).every(
        (entry) =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof Reflect.get(entry, 'message') === 'string',
    );
}

/**
 * Flattened format for runtime lookup: key → translated text.
 */
type FlattenedMessages = Record<string, string>;

/**
 * Stateless translation utility: loads locale files on demand, caches them,
 * and provides synchronous message lookup with English fallback.
 *
 * Contains no MobX dependencies and holds no locale state — callers pass
 * the active locale as a parameter to lookup methods.
 */
export class TranslationService {
    /**
     * In-memory cache of loaded and flattened locale data.
     */
    private localeCache = new Map<AvailableLocale, FlattenedMessages>();

    /**
     * Flattens raw MessagesJson into key → message map.
     *
     * @param rawMessages - Raw messages.json content
     * @returns Flattened key-value map
     */
    private flattenMessages(rawMessages: MessagesJson): FlattenedMessages {
        const result: FlattenedMessages = {};
        for (const [key, entry] of Object.entries(rawMessages)) {
            if (
                entry &&
                typeof entry.message === 'string' &&
                entry.message.length > 0
            ) {
                result[key] = entry.message;
            }
        }
        return result;
    }

    /**
     * Resolves a user preference into a supported locale code.
     *
     * @param localePreference - 'auto' or a locale code
     * @returns Resolved locale from AVAILABLE_LOCALES, or BASE_LOCALE
     */
    resolveLocale(localePreference: string): AvailableLocale {
        const code =
            localePreference === 'auto'
                ? browser.i18n.getUILanguage()
                : localePreference;

        const result = checkLocale(AVAILABLE_LOCALES, code);
        return result.suitable ? result.locale : BASE_LOCALE;
    }

    /**
     * Loads a locale file from extension assets, flattens, and caches it.
     *
     * @param locale - Locale code matching a folder in `_locales/`
     * @returns Promise that resolves when the locale is cached
     */
    async loadLocale(locale: AvailableLocale): Promise<void> {
        if (this.localeCache.has(locale)) {
            return;
        }
        const url = browser.runtime.getURL(`_locales/${locale}/messages.json`);
        const response = await fetch(url);
        const raw: unknown = (await response.json()) as unknown;
        if (!isMessagesJson(raw)) {
            throw new Error(`Invalid messages.json shape for locale ${locale}`);
        }
        const flattened = this.flattenMessages(raw);
        this.localeCache.set(locale, flattened);
    }

    /**
     * Loads base English locale and the locale resolved from `preference`.
     *
     * @param preference - 'auto' or a locale code; defaults to 'auto'
     * @returns The resolved AvailableLocale that was loaded
     */
    async loadLocaleData(preference?: string): Promise<AvailableLocale> {
        const pref = preference ?? 'auto';
        await this.loadLocale(BASE_LOCALE);
        const resolved = this.resolveLocale(pref);
        if (resolved !== BASE_LOCALE) {
            await this.loadLocale(resolved);
        }
        return resolved;
    }

    /**
     * Returns the translated message for the given key in the specified locale.
     *
     * @param locale - The locale to look up the message in
     * @param key - Translation message key
     * @returns Translated message, or empty string if untranslated
     */
    getMessage(locale: AvailableLocale, key: string): string {
        const baseMessages = this.localeCache.get(BASE_LOCALE);
        const baseMessage = baseMessages?.[key];

        if (!baseMessage) {
            throw new Error(`There is no such key "${key}" in the messages`);
        }

        if (locale === BASE_LOCALE) {
            return baseMessage;
        }

        const currentMessages = this.localeCache.get(locale);
        return currentMessages?.[key] ?? '';
    }

    /**
     * Returns the UI language code for `@adguard/translate`.
     *
     * @param locale - The locale code
     * @returns Lowercase locale code
     */
    getUILanguage(locale: AvailableLocale): string {
        return locale.toLowerCase();
    }

    /**
     * Returns the English base message for the given key.
     *
     * @param key - Translation message key
     * @returns English base message, or empty string if not found
     */
    getBaseMessage(key: string): string {
        const baseMessages = this.localeCache.get(BASE_LOCALE);
        return baseMessages?.[key] ?? '';
    }
}
