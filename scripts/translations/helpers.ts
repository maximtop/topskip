import fs from 'node:fs';
import path from 'node:path';

import {
    LOCALES_ABSOLUTE_PATH,
    LOCALE_DATA_FILENAME,
} from './locales-constants.ts';

/**
 * One entry of a Chrome `messages.json` file.
 */
export type LocaleMessage = {
    message: string;
    description?: string;
};

/**
 * Contents of a locale's `messages.json`, keyed by message name.
 */
export type LocaleMessages = Record<string, LocaleMessage>;

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';

/**
 * ANSI-coloured console output, kept dependency-free on purpose.
 */
export const cliLog = {
    /**
     * Prints an uncoloured line.
     *
     * @param str - Text to print.
     */
    info: (str: string): void => {
        console.log(str);
    },
    /**
     * Prints a green line.
     *
     * @param str - Text to print.
     */
    success: (str: string): void => {
        console.log(`${GREEN}${str}${RESET}`);
    },
    /**
     * Prints a yellow line.
     *
     * @param str - Text to print.
     */
    warning: (str: string): void => {
        console.log(`${YELLOW}${str}${RESET}`);
    },
    /**
     * Prints a bold red line.
     *
     * @param str - Text to print.
     */
    error: (str: string): void => {
        console.log(`${BOLD}${RED}${str}${RESET}`);
    },
};

/**
 * Absolute path to a locale's message file.
 *
 * @param locale - Locale code, e.g. `pt_BR`.
 * @returns Path to that locale's `messages.json`.
 */
export function localeMessagesPath(locale: string): string {
    return path.join(LOCALES_ABSOLUTE_PATH, locale, LOCALE_DATA_FILENAME);
}

/**
 * Reads and validates one locale's messages.
 *
 * @param locale - Locale code to read.
 * @returns Parsed messages for that locale.
 */
export async function readMessagesByLocale(
    locale: string,
): Promise<LocaleMessages> {
    const filePath = localeMessagesPath(locale);
    const fileContent = await fs.promises.readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(fileContent);

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error(`${filePath}: expected a JSON object of messages.`);
    }

    const messages: LocaleMessages = {};
    for (const [key, value] of Object.entries(parsed)) {
        if (
            typeof value !== 'object' ||
            value === null ||
            typeof (value as { message?: unknown }).message !== 'string'
        ) {
            throw new Error(`${filePath}: '${key}' has no string 'message'.`);
        }
        const entry = value as { message: string; description?: unknown };
        messages[key] = {
            message: entry.message,
            ...(typeof entry.description === 'string'
                ? { description: entry.description }
                : {}),
        };
    }
    return messages;
}

/**
 * Writes one locale's messages back to disk.
 *
 * @param messages - Messages to serialize.
 * @param locale - Locale code being written.
 * @returns Nothing.
 */
export async function writeMessagesByLocale(
    messages: LocaleMessages,
    locale: string,
): Promise<void> {
    const messagesString = JSON.stringify(messages, null, 4);
    await fs.promises.writeFile(localeMessagesPath(locale), messagesString);
}
