import fs from 'fs';
import path from 'path';

import {
    BASE_LOCALE,
    PROJECT_ID,
    API_URL,
    LOCALES_ABSOLUTE_PATH,
    FORMAT,
    LOCALE_DATA_FILENAME,
} from './locales-constants.js';

const API_UPLOAD_URL = `${API_URL}/upload`;

/**
 * Entry point for uploading base locale translations
 */
export const uploadBaseLocale = async () => {
    const filePath = path.join(
        LOCALES_ABSOLUTE_PATH,
        BASE_LOCALE,
        LOCALE_DATA_FILENAME,
    );
    const fileContent = await fs.promises.readFile(filePath);
    const blob = new Blob([fileContent], { type: 'application/json' });

    const formData = new FormData();
    formData.append('format', FORMAT);
    formData.append('language', BASE_LOCALE);
    formData.append('project', PROJECT_ID);
    formData.append('filename', LOCALE_DATA_FILENAME);
    formData.append('file', blob, LOCALE_DATA_FILENAME);

    let response;
    try {
        response = await fetch(API_UPLOAD_URL, {
            method: 'POST',
            body: formData,
        });
    } catch (e) {
        throw new Error(
            `Error: ${e.message}, while uploading: ${API_UPLOAD_URL}`,
        );
    }

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
            `Error: ${errorText}, while uploading: ${API_UPLOAD_URL}`,
        );
    }

    return response.json();
};
