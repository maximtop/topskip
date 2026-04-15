import type { AvailableLocale } from '@/shared/i18n/locale-constants';

/**
 * Result of matching a locale code against available locales.
 */
export type CheckLocaleResult =
  | { suitable: true; locale: AvailableLocale }
  | { suitable: false; locale: string };

/**
 * Matches a browser locale code to one of the supported locales.
 *
 * Resolution order:
 * 1. Normalize input (lowercase, hyphens → underscores)
 * 2. Exact match against available locales
 * 3. First+last segments for 3-part BCP 47 codes (e.g. zh-Hant-TW → zh_TW)
 * 4. Base language exact match (e.g. en-GB → en)
 * 5. Base language prefix match (e.g. zh → zh_CN)
 *
 * @param availableLocales - List of supported locale codes
 * @param locale - Browser locale code to resolve
 * @returns Result indicating whether a match was found
 */
export function checkLocale(
  availableLocales: readonly AvailableLocale[],
  locale: string | null,
): CheckLocaleResult {
  if (!locale) {
    return { suitable: false, locale: '' };
  }

  const normalized = locale.toLowerCase().replace(/-/g, '_');

  const lookupMap = new Map<string, AvailableLocale>();
  for (const available of availableLocales) {
    lookupMap.set(available.toLowerCase(), available);
  }

  const exactMatch = lookupMap.get(normalized);
  if (exactMatch) {
    return { suitable: true, locale: exactMatch };
  }

  const parts = normalized.split('_');

  if (parts.length >= 3) {
    const firstSecond = `${parts[0]}_${parts[1]}`;
    const firstSecondMatch = lookupMap.get(firstSecond);
    if (firstSecondMatch) {
      return { suitable: true, locale: firstSecondMatch };
    }

    const firstLast = `${parts[0]}_${parts[parts.length - 1]}`;
    const firstLastMatch = lookupMap.get(firstLast);
    if (firstLastMatch) {
      return { suitable: true, locale: firstLastMatch };
    }
  }

  const baseMatch = lookupMap.get(parts[0]);
  if (baseMatch) {
    return { suitable: true, locale: baseMatch };
  }

  const prefix = `${parts[0]}_`;
  const prefixMatch = availableLocales.find(
    (available) => available.toLowerCase().startsWith(prefix),
  );
  if (prefixMatch) {
    return { suitable: true, locale: prefixMatch };
  }

  return { suitable: false, locale: normalized };
}
