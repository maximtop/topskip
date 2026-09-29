import fs from 'node:fs';
import path from 'node:path';

import { cliLog } from './helpers.ts';
import {
    API_URL,
    FORMAT,
    LOCALES_ABSOLUTE_PATH,
    LOCALE_DATA_FILENAME,
    PROJECT_ID,
} from './locales-constants.ts';

const API_DOWNLOAD_URL = `${API_URL}/download`;

/**
 * Builds the query string for downloading one locale.
 *
 * @param lang - Locale code to request.
 * @returns Encoded query string.
 */
function getQueryString(lang: string): string {
    return new URLSearchParams({
        format: FORMAT,
        language: lang,
        project: PROJECT_ID,
        filename: LOCALE_DATA_FILENAME,
    }).toString();
}

/**
 * Writes downloaded content, creating the locale directory when new.
 *
 * @param filePath - Destination file.
 * @param data - Raw response body.
 * @returns Nothing.
 */
async function saveFile(filePath: string, data: string): Promise<void> {
    const dirPath = path.dirname(filePath);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
    await fs.promises.writeFile(filePath, data.trim());
}

/**
 * Downloads the given locales from the localization service.
 *
 * @param locales - Locale codes to fetch.
 * @returns Nothing.
 */
export async function downloadAndSave(locales: string[]): Promise<void> {
    for (const lang of locales) {
        const downloadUrl = `${API_DOWNLOAD_URL}?${getQueryString(lang)}`;
        try {
            cliLog.info(`Downloading: ${downloadUrl}`);
            const response = await fetch(downloadUrl);
            if (!response.ok) {
                throw new Error(await response.text());
            }
            const data = await response.text();
            const filePath = path.join(
                LOCALES_ABSOLUTE_PATH,
                lang,
                LOCALE_DATA_FILENAME,
            );
            await saveFile(filePath, data);
            cliLog.info(`Successfully saved in: ${filePath}`);
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            throw new Error(
                `Error occurred: ${message}, while downloading: ${downloadUrl}`,
                { cause: e },
            );
        }
    }
}
