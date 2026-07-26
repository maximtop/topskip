import fs from 'node:fs';

import { localeMessagesPath } from './helpers.ts';
import {
    API_URL,
    BASE_LOCALE,
    FORMAT,
    LOCALE_DATA_FILENAME,
    PROJECT_ID,
} from './locales-constants.ts';

const API_UPLOAD_URL = `${API_URL}/upload`;

/**
 * Uploads the base locale to the localization service.
 *
 * @returns Parsed service response.
 */
export async function uploadBaseLocale(): Promise<unknown> {
    const fileContent = await fs.promises.readFile(
        localeMessagesPath(BASE_LOCALE),
    );
    const blob = new Blob([fileContent], { type: 'application/json' });

    const formData = new FormData();
    formData.append('format', FORMAT);
    formData.append('language', BASE_LOCALE);
    formData.append('project', PROJECT_ID);
    formData.append('filename', LOCALE_DATA_FILENAME);
    formData.append('file', blob, LOCALE_DATA_FILENAME);

    let response: Response;
    try {
        response = await fetch(API_UPLOAD_URL, {
            method: 'POST',
            body: formData,
        });
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        throw new Error(
            `Error: ${message}, while uploading: ${API_UPLOAD_URL}`,
            { cause: e },
        );
    }

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
            `Error: ${errorText}, while uploading: ${API_UPLOAD_URL}`,
        );
    }

    return response.json();
}
