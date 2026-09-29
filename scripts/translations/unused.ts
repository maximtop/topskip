import fs from 'node:fs';
import path from 'node:path';

import { cliLog, readMessagesByLocale } from './helpers.ts';
import {
    BASE_LOCALE,
    LOCALES_ABSOLUTE_PATH,
    PERSISTENT_MESSAGES,
    SRC_ABSOLUTE_PATH,
    SRC_FILENAME_EXTENSIONS,
} from './locales-constants.ts';

/**
 * Whether a file could reference a message key.
 *
 * @param filePath - Absolute path to inspect.
 * @returns True for source files outside the locales tree.
 */
function canContainLocalesStrings(filePath: string): boolean {
    const isSrcFile = SRC_FILENAME_EXTENSIONS.some((ext) =>
        filePath.endsWith(ext),
    );
    return isSrcFile && !filePath.includes(LOCALES_ABSOLUTE_PATH);
}

/**
 * Reads every source file under a directory.
 *
 * @param dirPath - Directory to walk.
 * @param contents - Accumulator for recursive calls.
 * @returns File contents.
 */
function getSrcFilesContents(dirPath: string, contents: string[] = []): string[] {
    for (const file of fs.readdirSync(dirPath)) {
        const fullPath = path.join(dirPath, file);
        if (fs.lstatSync(fullPath).isDirectory()) {
            getSrcFilesContents(fullPath, contents);
        } else if (canContainLocalesStrings(fullPath)) {
            contents.push(fs.readFileSync(fullPath).toString());
        }
    }
    return contents;
}

/**
 * Reports base-locale keys that no source file references.
 *
 * @returns Nothing; findings are logged.
 */
export async function checkUnusedMessages(): Promise<void> {
    const baseLocaleTranslations = await readMessagesByLocale(BASE_LOCALE);
    const baseMessages = Object.keys(baseLocaleTranslations);
    const filesContents = getSrcFilesContents(SRC_ABSOLUTE_PATH);

    const isPresentInFile = (message: string, file: string): boolean =>
        file.includes(`'${message}'`) || file.includes(`"${message}"`);

    const isMessageUnused = (message: string): boolean =>
        !PERSISTENT_MESSAGES.includes(message) &&
        !filesContents.some((file) => isPresentInFile(message, file));

    const unusedMessages = baseMessages.filter(isMessageUnused);

    if (unusedMessages.length === 0) {
        cliLog.success('There are no unused messages');
        return;
    }
    cliLog.warning('Unused messages:');
    for (const key of unusedMessages) {
        cliLog.warning(`  ${key}`);
    }
}
