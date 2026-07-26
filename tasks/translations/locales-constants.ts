import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Shape of `tasks/translations/config.json`.
 */
type TranslationsConfig = {
    twosky_config_path: string;
    api_url: string;
    source_relative_path: string;
    supported_source_filename_extensions: string[];
    persistent_messages: string[];
    locales_relative_path: string;
    locales_data_format: string;
    locales_data_filename: string;
    required_locales: string[];
    threshold_percentage: number;
};

/**
 * Entry of the repository-root `.twosky.json`.
 */
type TwoskyConfig = {
    base_locale: string;
    languages: Record<string, string>;
    project_id: string;
};

/**
 * Narrows a value to a non-null object so its fields can be read.
 *
 * @param value - Parsed JSON of unknown shape.
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
 * @returns The validated field value.
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

const isString = (v: unknown): v is string => typeof v === 'string';
const isNumber = (v: unknown): v is number => typeof v === 'number';
const isStringArray = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every(isString);
const isStringMap = (v: unknown): v is Record<string, string> =>
    isRecord(v) && Object.values(v).every(isString);

/**
 * Parses a JSON file into an unvalidated record.
 *
 * @param filePath - Absolute path to the file.
 * @returns Parsed contents.
 */
function readJsonRecord(filePath: string): Record<string, unknown> {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (!isRecord(parsed)) {
        throw new Error(`${filePath}: expected a JSON object.`);
    }
    return parsed;
}

const configPath = path.join(__dirname, 'config.json');
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

const twoskyPath = path.join(__dirname, inputConfig.twosky_config_path);
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
export const SRC_FILENAME_EXTENSIONS =
    inputConfig.supported_source_filename_extensions;
export const PERSISTENT_MESSAGES = inputConfig.persistent_messages;
export const LOCALES_RELATIVE_PATH = inputConfig.locales_relative_path;
export const FORMAT = inputConfig.locales_data_format;
export const LOCALE_DATA_FILENAME = inputConfig.locales_data_filename;
export const REQUIRED_LOCALES = inputConfig.required_locales;
export const THRESHOLD_PERCENTAGE = inputConfig.threshold_percentage;

export const LOCALES_ABSOLUTE_PATH = path.join(
    __dirname,
    LOCALES_RELATIVE_PATH,
);
export const SRC_ABSOLUTE_PATH = path.join(__dirname, SRC_RELATIVE_PATH);
