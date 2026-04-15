import browser from '@/shared/browser';

import { TranslationService } from '@/shared/i18n/translation-service';
import {
  type AvailableLocale,
  BASE_LOCALE,
} from '@/shared/i18n/locale-constants';

/**
 * I18n facade with browser.i18n fallback before initialization.
 *
 * Each extension context (background, popup, options, content) creates its
 * own TranslationService instance. Before `init()` completes, all methods
 * fall back to `browser.i18n` (native Chrome API reading `_locales/`).
 */
export class I18n {
  /**
   * Per-context TranslationService instance.
   */
  private translationService = new TranslationService();

  /**
   * Whether `init()` has completed successfully.
   */
  private initialized = false;

  /**
   * Active locale (resolved from browser language).
   */
  private currentLocale: AvailableLocale = BASE_LOCALE;

  /**
   * Initializes the translation service with locale data.
   *
   * @returns Promise resolving when locale data is loaded
   */
  async init(): Promise<void> {
    try {
      this.currentLocale =
        await this.translationService.loadLocaleData();
    } catch {
      this.currentLocale = BASE_LOCALE;
    }
    this.initialized = true;
  }

  /**
   * Retrieves the localized message for the given key.
   *
   * Before `init()` completes, falls back to `browser.i18n.getMessage()`.
   *
   * @param key - Message key from messages.json
   * @returns Localized message string
   */
  getMessage(key: string): string {
    if (!this.initialized) {
      return browser.i18n.getMessage(key);
    }
    return this.translationService.getMessage(
      this.currentLocale,
      key,
    );
  }

  /**
   * Returns the UI language code for `@adguard/translate`.
   *
   * Before `init()` completes, falls back to `browser.i18n.getUILanguage()`.
   *
   * @returns Lowercase locale code (e.g. 'de', 'pt_br')
   */
  getUILanguage(): string {
    if (!this.initialized) {
      return browser.i18n
        .getUILanguage()
        .toLowerCase()
        .replace('-', '_');
    }
    return this.translationService.getUILanguage(
      this.currentLocale,
    );
  }

  /**
   * Returns the English base message for the given key.
   *
   * Before `init()` completes, falls back to `browser.i18n.getMessage()`.
   *
   * @param key - Message key from messages.json
   * @returns English base message
   */
  getBaseMessage(key: string): string {
    if (!this.initialized) {
      return browser.i18n.getMessage(key);
    }
    return this.translationService.getBaseMessage(key);
  }

  /**
   * Returns the base locale code.
   *
   * @returns The base locale code ('en')
   */
  getBaseUILanguage(): string {
    return BASE_LOCALE;
  }
}

/**
 * Shared singleton — each bundle gets its own instance due to separate
 * Rspack entry points.
 */
export const i18n = new I18n();
