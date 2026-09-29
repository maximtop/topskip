/**
 * @file Loads and validates `scripts/translations/config.json` and the
 * `extension/.twosky.json` locales config, then re-exports their fields as
 * typed constants so the other translation scripts never re-parse or
 * re-validate them.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirName = path.dirname(fileURLToPath(import.meta.url));

/**
 * Shape of `scripts/translations/config.json`.
 */
interface TranslationsConfig {
    /**
     * Path, relative to this module, to the twosky locales config.
     */
    twosky_config_path: string;

    /**
     * Base URL of the localization service API.
     */
    api_url: string;

    /**
     * Path, relative to this module, to the source tree scanned for message keys.
     */
    source_relative_path: string;

    /**
     * File extensions scanned when looking for message-key references in source.
     */
    supported_source_filename_extensions: string[];

    /**
     * Message keys kept in every locale even when unused in source.
     */
    persistent_messages: string[];

    /**
     * Path, relative to this module, to the locales directory.
     */
    locales_relative_path: string;

    /**
     * Localization-service export format requested for locale data.
     */
    locales_data_format: string;

    /**
     * Filename used for each locale's data file.
     */
    locales_data_filename: string;

    /**
     * Locale codes that must pass validation for the build to succeed.
     */
    required_locales: string[];

    /**
     * Minimum translated-message percentage a locale must reach to count as ready.
     */
    threshold_percentage: number;
}

/**
 * Entry of `extension/.twosky.json`.
 */
interface TwoskyConfig {
    /**
     * Locale code treated as the source of truth for message keys and text.
     */
    base_locale: string;

    /**
     * Map of locale code to display name, defining every locale the project supports.
     */
    languages: Record<string, string>;

    /**
     * Localization-service project identifier used in API requests.
     */
    project_id: string;
}

/**
 * Narrows a value to a non-null object so its fields can be read.
 *
 * @param value - Parsed JSON of unknown shape.
 *
 * @returns Whether the value is a plain object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads a required field, failing loudly with the file that is at fault.
 *
 * These configs are edited by hand, so a typo should name the file and key
 * rather than surface later as `undefined` in a request URL.
 *
 * @param source - File the value came from, for the error message.
 * @param raw - Parsed file contents.
 * @param key - Field to read.
 * @param check - Predicate the value must satisfy.
 *
 * @returns The validated field value.
 *
 * @throws {Error} When the field is missing or fails `check`.
 */
function requireField<T>(
    source: string,
    raw: Record<string, unknown>,
    key: string,
    check: (value: unknown) => value is T,
): T {
    const value = raw[key];
    if (!check(value)) {
        throw new Error(`${source}: field '${key}' is missing or malformed.`);
    }
    return value;
}

/**
 * Narrows a value to a string.
 *
 * @param v - Value to check.
 *
 * @returns Whether the value is a string.
 */
const isString = (v: unknown): v is string => {
    return typeof v === 'string';
};

/**
 * Narrows a value to a number.
 *
 * @param v - Value to check.
 *
 * @returns Whether the value is a number.
 */
const isNumber = (v: unknown): v is number => {
    return typeof v === 'number';
};

/**
 * Narrows a value to a string array.
 *
 * @param v - Value to check.
 *
 * @returns Whether the value is an array of strings.
 */
const isStringArray = (v: unknown): v is string[] => {
    return Array.isArray(v) && v.every(isString);
};

/**
 * Narrows a value to a string-to-string map.
 *
 * @param v - Value to check.
 *
 * @returns Whether the value is a plain object whose values are all strings.
 */
const isStringMap = (v: unknown): v is Record<string, string> => {
    return isRecord(v) && Object.values(v).every(isString);
};

/**
 * Parses a JSON file into an unvalidated record.
 *
 * @param filePath - Absolute path to the file.
 *
 * @returns Parsed contents.
 *
 * @throws {Error} When the parsed JSON is not a plain object.
 */
function readJsonRecord(filePath: string): Record<string, unknown> {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!isRecord(parsed)) {
        throw new Error(`${filePath}: expected a JSON object.`);
    }
    return parsed;
}

const configPath = path.join(moduleDirName, 'config.json');
const rawConfig = readJsonRecord(configPath);

const inputConfig: TranslationsConfig = {
    twosky_config_path: requireField(
        configPath,
        rawConfig,
        'twosky_config_path',
        isString,
    ),
    api_url: requireField(configPath, rawConfig, 'api_url', isString),
    source_relative_path: requireField(
        configPath,
        rawConfig,
        'source_relative_path',
        isString,
    ),
    supported_source_filename_extensions: requireField(
        configPath,
        rawConfig,
        'supported_source_filename_extensions',
        isStringArray,
    ),
    persistent_messages: requireField(
        configPath,
        rawConfig,
        'persistent_messages',
        isStringArray,
    ),
    locales_relative_path: requireField(
        configPath,
        rawConfig,
        'locales_relative_path',
        isString,
    ),
    locales_data_format: requireField(
        configPath,
        rawConfig,
        'locales_data_format',
        isString,
    ),
    locales_data_filename: requireField(
        configPath,
        rawConfig,
        'locales_data_filename',
        isString,
    ),
    required_locales: requireField(
        configPath,
        rawConfig,
        'required_locales',
        isStringArray,
    ),
    threshold_percentage: requireField(
        configPath,
        rawConfig,
        'threshold_percentage',
        isNumber,
    ),
};

const twoskyPath = path.join(moduleDirName, inputConfig.twosky_config_path);
const twoskyParsed: unknown = JSON.parse(
    fs.readFileSync(twoskyPath, { encoding: 'utf8' }),
);
if (!Array.isArray(twoskyParsed) || twoskyParsed.length === 0) {
    throw new Error(`${twoskyPath}: expected a non-empty JSON array.`);
}
const rawTwosky: unknown = twoskyParsed[0];
if (!isRecord(rawTwosky)) {
    throw new Error(`${twoskyPath}: first entry must be a JSON object.`);
}

const twoskyConfig: TwoskyConfig = {
    base_locale: requireField(twoskyPath, rawTwosky, 'base_locale', isString),
    languages: requireField(twoskyPath, rawTwosky, 'languages', isStringMap),
    project_id: requireField(twoskyPath, rawTwosky, 'project_id', isString),
};

export const BASE_LOCALE = twoskyConfig.base_locale;
export const LANGUAGES = twoskyConfig.languages;
export const PROJECT_ID = twoskyConfig.project_id;

export const API_URL = inputConfig.api_url;
export const SRC_RELATIVE_PATH = inputConfig.source_relative_path;
export const SRC_FILENAME_EXTENSIONS = inputConfig.supported_source_filename_extensions;
export const PERSISTENT_MESSAGES = inputConfig.persistent_messages;
export const LOCALES_RELATIVE_PATH = inputConfig.locales_relative_path;
export const FORMAT = inputConfig.locales_data_format;
export const LOCALE_DATA_FILENAME = inputConfig.locales_data_filename;
export const REQUIRED_LOCALES = inputConfig.required_locales;
export const THRESHOLD_PERCENTAGE = inputConfig.threshold_percentage;

export const LOCALES_ABSOLUTE_PATH = path.join(
    moduleDirName,
    LOCALES_RELATIVE_PATH,
);
export const SRC_ABSOLUTE_PATH = path.join(moduleDirName, SRC_RELATIVE_PATH);
