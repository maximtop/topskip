/* eslint-disable no-await-in-loop */
import fs from 'fs';
import path from 'path';

import { cliLog } from './helpers.js';
import {
    PROJECT_ID,
    API_URL,
    LOCALES_ABSOLUTE_PATH,
    FORMAT,
    LOCALE_DATA_FILENAME,
} from './locales-constants.js';

const API_DOWNLOAD_URL = `${API_URL}/download`;

/**
 * Build query string for downloading translations
 * @param {string} lang locale code
 * @returns {string}
 */
const getQueryString = (lang) => {
    const params = new URLSearchParams({
        format: FORMAT,
        language: lang,
        project: PROJECT_ID,
        filename: LOCALE_DATA_FILENAME,
    });
    return params.toString();
};

/**
 * Save file by path with passed content
 * @param {string} filePath path to file
 * @param {string} data text content
 */
async function saveFile(filePath, data) {
    const formattedData = data.trim();

    const dirPath = path.dirname(filePath);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }

    await fs.promises.writeFile(filePath, formattedData);
}

/**
 * Entry point for downloading translations
 * @param {string[]} locales
 */
export const downloadAndSave = async (locales) => {
    for (const lang of locales) {
        const downloadUrl = `${API_DOWNLOAD_URL}?${getQueryString(lang)}`;
        try {
            cliLog.info(`Downloading: ${downloadUrl}`);
            const response = await fetch(downloadUrl);
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(errorText);
            }
            const data = await response.text();
            const filePath = path.join(LOCALES_ABSOLUTE_PATH, lang, LOCALE_DATA_FILENAME);
            await saveFile(filePath, data);
            cliLog.info(`Successfully saved in: ${filePath}`);
        } catch (e) {
            throw new Error(`Error occurred: ${e.message}, while downloading: ${downloadUrl}`);
        }
    }
};
