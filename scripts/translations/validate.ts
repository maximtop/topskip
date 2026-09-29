import { validator, type Locale } from '@adguard/translate';

import {
    cliLog,
    readMessagesByLocale,
    writeMessagesByLocale,
    type LocaleMessages,
} from './helpers.ts';
import {
    BASE_LOCALE,
    LANGUAGES,
    PERSISTENT_MESSAGES,
    REQUIRED_LOCALES,
    THRESHOLD_PERCENTAGE,
} from './locales-constants.ts';

/**
 * Every locale the project declares.
 */
const ALL_LOCALES = Object.keys(LANGUAGES);

/**
 * Marker that pins a maximum rendered length in a base description.
 */
const TEXT_MAX_LENGTH_MARKER = 'TEXT MAX LENGTH:';

/**
 * One message that failed validation.
 */
type InvalidTranslation = {
    key: string;
    error: string;
};

/**
 * Per-locale outcome of a validation pass.
 */
export type ValidationResult = {
    locale: string;
    /**
     * Percentage of base messages that are present and valid.
     */
    level: number;
    untranslatedStrings: string[];
    invalidTranslations: InvalidTranslation[];
};

/**
 * Flags controlling how strict a validation pass is and whether it throws.
 */
export type ValidationFlags = {
    /**
     * Only critical errors plus readiness of the required locales.
     */
    isMinimum?: boolean;
    /**
     * Report without failing the process.
     */
    isInfo?: boolean;
};

/**
 * Logs per-locale readiness.
 *
 * @param results - Results to print.
 * @param isMinimum - Suppresses the invalid-translation detail when true.
 * @returns Nothing.
 */
function printTranslationsResults(
    results: ValidationResult[],
    isMinimum = false,
): void {
    cliLog.info('Translations readiness:');
    for (const res of results) {
        const record = `${res.locale} -- ${res.level}%`;
        if (res.level >= THRESHOLD_PERCENTAGE) {
            cliLog.success(record);
            continue;
        }
        cliLog.error(record);
        if (res.untranslatedStrings.length > 0) {
            cliLog.warning('  untranslated:');
            for (const str of res.untranslatedStrings) {
                cliLog.warning(`    - ${str}`);
            }
        }
        if (!isMinimum && res.invalidTranslations.length > 0) {
            cliLog.warning('  invalid:');
            for (const obj of res.invalidTranslations) {
                cliLog.warning(`    - ${obj.key} -- ${obj.error}`);
            }
        }
    }
}

/**
 * Logs locales that contain structurally invalid translations.
 *
 * @param criticals - Results carrying invalid translations.
 * @returns Nothing.
 */
function printCriticalResults(criticals: ValidationResult[]): void {
    cliLog.warning('Invalid translated string:');
    for (const cr of criticals) {
        cliLog.error(`${cr.locale}:`);
        for (const obj of cr.invalidTranslations) {
            cliLog.warning(`   - ${obj.key} -- ${obj.error}`);
        }
    }
}

/**
 * Checks a translation against the `TEXT MAX LENGTH:` marker, when present.
 *
 * @param baseDescriptionValue - Base-locale description, possibly undefined.
 * @param localeMessageValue - Translated message.
 * @returns Error text, or `null` when the length is acceptable.
 */
function validateTranslatedLength(
    baseDescriptionValue: string | undefined,
    localeMessageValue: string,
): string | null {
    if (
        baseDescriptionValue === undefined ||
        !baseDescriptionValue.includes(TEXT_MAX_LENGTH_MARKER)
    ) {
        return null;
    }

    const markerIndex = baseDescriptionValue.indexOf(TEXT_MAX_LENGTH_MARKER);
    const lengthStr = baseDescriptionValue
        .slice(markerIndex + TEXT_MAX_LENGTH_MARKER.length)
        .trim();
    const maxLength = Number(lengthStr);
    if (Number.isNaN(maxLength)) {
        return `Invalid max length value: ${lengthStr}`;
    }
    if (maxLength && localeMessageValue.length > maxLength) {
        return `Text length is more than allowed ${maxLength} characters, actual: ${localeMessageValue.length}`;
    }
    return null;
}

/**
 * Validates one message against its base-locale counterpart.
 *
 * @param baseKey - Message key being checked.
 * @param baseLocaleTranslations - Base locale messages.
 * @param locale - Locale under validation.
 * @param localeTranslations - Messages of the locale under validation.
 * @returns The failure, or `undefined` when the message is valid.
 */
function validateMessage(
    baseKey: string,
    baseLocaleTranslations: LocaleMessages,
    locale: string,
    localeTranslations: LocaleMessages,
): InvalidTranslation | undefined {
    const baseEntry = baseLocaleTranslations[baseKey];
    const localeEntry = localeTranslations[baseKey];
    if (baseEntry === undefined || localeEntry === undefined) {
        return undefined;
    }

    const lengthValidationError = validateTranslatedLength(
        baseEntry.description,
        localeEntry.message,
    );
    if (lengthValidationError !== null) {
        return { key: baseKey, error: lengthValidationError };
    }

    try {
        // Locale codes come from `.twosky.json`, so they cannot be narrowed
        // to the validator's union at compile time. An unknown code makes the
        // validator throw, which the catch below turns into a reported error.
        const normalizedLocale = locale
            .toLowerCase()
            .replace('-', '_') as Locale;
        const isValid = validator.isTranslationValid(
            baseEntry.message,
            localeEntry.message,
            normalizedLocale,
        );
        if (!isValid) {
            throw new Error('Invalid translation');
        }
    } catch (error) {
        return {
            key: baseKey,
            error: error instanceof Error ? error.message : String(error),
        };
    }
    return undefined;
}

/**
 * Measures and reports translation readiness for the given locales.
 *
 * @param locales - Locales to check.
 * @param flags - Strictness and reporting flags.
 * @returns One result per locale.
 */
export async function checkTranslations(
    locales: string[],
    flags: ValidationFlags,
): Promise<ValidationResult[]> {
    const { isMinimum = false, isInfo = false } = flags;
    const baseLocaleTranslations = await readMessagesByLocale(BASE_LOCALE);
    const baseMessages = Object.keys(baseLocaleTranslations);
    const baseMessagesCount = baseMessages.length;

    const translationResults = await Promise.all(
        locales.map(async (locale): Promise<ValidationResult> => {
            const localeTranslations = await readMessagesByLocale(locale);
            const localeMessages = Object.keys(localeTranslations);

            const untranslatedStrings: string[] = [];
            const invalidTranslations: InvalidTranslation[] = [];
            for (const baseKey of baseMessages) {
                if (!localeMessages.includes(baseKey)) {
                    untranslatedStrings.push(baseKey);
                    continue;
                }
                const validationError = validateMessage(
                    baseKey,
                    baseLocaleTranslations,
                    locale,
                    localeTranslations,
                );
                if (validationError !== undefined) {
                    invalidTranslations.push(validationError);
                }
            }

            const validLocaleMessagesCount =
                localeMessages.length - invalidTranslations.length;
            const strictLevel =
                (validLocaleMessagesCount / baseMessagesCount) * 100;

            return {
                locale,
                level: Math.round((strictLevel + Number.EPSILON) * 100) / 100,
                untranslatedStrings,
                invalidTranslations,
            };
        }),
    );

    const filteredCriticalResults = translationResults.filter(
        (result) => result.invalidTranslations.length > 0,
    );
    const filteredReadinessResults = translationResults.filter((result) =>
        isMinimum
            ? result.level < THRESHOLD_PERCENTAGE &&
              REQUIRED_LOCALES.includes(result.locale)
            : result.level < THRESHOLD_PERCENTAGE,
    );

    if (isInfo) {
        printTranslationsResults(translationResults);
        return translationResults;
    }

    if (isMinimum) {
        let isSuccess = true;
        if (filteredCriticalResults.length === 0) {
            cliLog.success('No invalid translations found');
        } else {
            isSuccess = false;
            printCriticalResults(filteredCriticalResults);
            cliLog.error('Locales above should not have invalid strings');
        }
        if (filteredReadinessResults.length === 0) {
            cliLog.success('Our locales have required level of translations');
        } else {
            isSuccess = false;
            printTranslationsResults(filteredReadinessResults, isMinimum);
            cliLog.error('Our locales should be done for 100%');
        }
        if (!isSuccess) {
            throw new Error('Locales validation failed!');
        }
    }

    if (filteredReadinessResults.length === 0) {
        const coversEveryLocale =
            locales.length === ALL_LOCALES.length &&
            locales.every((l, i) => l === ALL_LOCALES[i]);
        cliLog.success(
            coversEveryLocale
                ? 'All locales have required level of translations'
                : `Level of translations is required for locales: ${locales.join(', ')}`,
        );
    } else {
        printTranslationsResults(filteredReadinessResults);
        throw new Error('Locales above should be done for 100%');
    }

    return translationResults;
}

/**
 * Copies persistent messages from the base locale into locales missing them.
 *
 * @param locales - Locales to top up.
 * @returns Human-readable summary of what was copied.
 */
export async function addRequiredFields(locales: string[]): Promise<string> {
    const nonBaseLocales = locales.filter((locale) => locale !== BASE_LOCALE);
    const baseLocaleMessages = await readMessagesByLocale(BASE_LOCALE);

    const result = await Promise.all(
        nonBaseLocales.map(async (locale) => {
            const localeMessages = await readMessagesByLocale(locale);
            const additions: string[] = [];
            for (const requiredField of PERSISTENT_MESSAGES) {
                if (localeMessages[requiredField] !== undefined) {
                    continue;
                }
                const baseEntry = baseLocaleMessages[requiredField];
                if (baseEntry === undefined) {
                    continue;
                }
                additions.push(
                    `From base locale to ${locale} copied: "${requiredField}"`,
                );
                localeMessages[requiredField] = baseEntry;
            }
            await writeMessagesByLocale(localeMessages, locale);
            return additions.join('\n');
        }),
    );

    return result.filter((i) => i).join('\n');
}
