/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';

import { LOCALES_ABSOLUTE_PATH, LOCALE_DATA_FILENAME } from './locales-constants.js';

// ANSI color helpers (no chalk dependency)
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const BOLD = '\x1b[1m';

export const cliLog = {
    info: (str) => {
        console.log(str);
    },
    success: (str) => {
        console.log(`${GREEN}${str}${RESET}`);
    },
    warning: (str) => {
        console.log(`${YELLOW}${str}${RESET}`);
    },
    error: (str) => {
        console.log(`${BOLD}${RED}${str}${RESET}`);
    },
};

/**
 * Gets strings for certain locale
 * @param {string} locale
 * @returns {Promise<Object>}
 */
export const readMessagesByLocale = async (locale) => {
    const filePath = path.join(LOCALES_ABSOLUTE_PATH, locale, LOCALE_DATA_FILENAME);
    const fileContent = await fs.promises.readFile(filePath, 'utf-8');
    return JSON.parse(fileContent);
};

/**
 * Save file by path with passed content
 * @param {Object} messages
 * @param {string} locale
 */
export const writeMessagesByLocale = async (messages, locale) => {
    const localePath = path.join(LOCALES_ABSOLUTE_PATH, locale, LOCALE_DATA_FILENAME);
    const messagesString = JSON.stringify(messages, null, 4);
    await fs.promises.writeFile(localePath, messagesString);
};
