import { translate, type I18nInterface } from '@adguard/translate';

import { i18n } from '@/shared/i18n/i18n';

/**
 * Plain-string translator: resolves message keys to localized strings.
 * Used in non-React contexts (background, content scripts).
 */
export const translator = translate.createTranslator(i18n as I18nInterface);
