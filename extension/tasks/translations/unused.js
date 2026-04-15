import fs from 'fs';
import path from 'path';

import { cliLog, readMessagesByLocale } from './helpers.js';
import {
    BASE_LOCALE,
    SRC_ABSOLUTE_PATH,
    SRC_FILENAME_EXTENSIONS,
    PERSISTENT_MESSAGES,
    LOCALES_ABSOLUTE_PATH,
} from './locales-constants.js';

/**
 * Checks file extension is it one of source files
 * @param {string} filePath path to file
 * @returns {boolean}
 */
const canContainLocalesStrings = (filePath) => {
    const isSrcFile = SRC_FILENAME_EXTENSIONS.some((ext) => filePath.endsWith(ext));
    return isSrcFile && !filePath.includes(LOCALES_ABSOLUTE_PATH);
};

/**
 * Collects contents of source files in given directory
 * @param {string} dirPath path to dir
 * @param {string[]} [contents=[]] result acc
 * @returns {string[]}
 */
const getSrcFilesContents = (dirPath, contents = []) => {
    fs.readdirSync(dirPath).forEach((file) => {
        const fullPath = path.join(dirPath, file);
        if (fs.lstatSync(fullPath).isDirectory()) {
            getSrcFilesContents(fullPath, contents);
        } else if (canContainLocalesStrings(fullPath)) {
            contents.push(fs.readFileSync(fullPath).toString());
        }
    });
    return contents;
};

/**
 * Checks if there are unused base-locale strings in source files
 */
export const checkUnusedMessages = async () => {
    const baseLocaleTranslations = await readMessagesByLocale(BASE_LOCALE);
    const baseMessages = Object.keys(baseLocaleTranslations);

    const filesContents = getSrcFilesContents(SRC_ABSOLUTE_PATH);

    const isPresentInFile = (message, file) => {
        return file.includes(`'${message}'`) || file.includes(`"${message}"`);
    };

    const isMessageUnused = (message) => {
        return !PERSISTENT_MESSAGES.includes(message)
            && !filesContents.some((file) => isPresentInFile(message, file));
    };

    const unusedMessages = baseMessages.filter(isMessageUnused);

    if (unusedMessages.length === 0) {
        cliLog.success('There are no unused messages');
    } else {
        cliLog.warning('Unused messages:');
        unusedMessages.forEach((key) => {
            cliLog.warning(`  ${key}`);
        });
    }
};
