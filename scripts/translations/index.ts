import process from 'node:process';

import { program } from 'commander';

import { downloadAndSave } from './download.ts';
import { cliLog } from './helpers.ts';
import { LANGUAGES } from './locales-constants.ts';
import { checkUnusedMessages } from './unused.ts';
import { uploadBaseLocale } from './upload.ts';
import { addRequiredFields, checkTranslations } from './validate.ts';

const LOCALES = Object.keys(LANGUAGES);

/**
 * Reports a failure and stops with a non-zero status.
 *
 * @param error - Thrown value.
 * @param prefix - Optional context for the message.
 * @returns Never; the process exits.
 */
function fail(error: unknown, prefix = ''): never {
    const message = error instanceof Error ? error.message : String(error);
    cliLog.error(`${prefix}${message}`);
    process.exit(1);
}

/**
 * Downloads the given locales.
 *
 * @param locales - Locale codes to fetch.
 * @returns Nothing.
 */
async function download(locales: string[]): Promise<void> {
    try {
        await downloadAndSave(locales);
        cliLog.success('Download was successful');
    } catch (e) {
        fail(e);
    }
}

/**
 * Uploads the base locale after checking for unused messages.
 *
 * @returns Nothing.
 */
async function upload(): Promise<void> {
    try {
        await checkUnusedMessages();
        const result = await uploadBaseLocale();
        cliLog.success(
            `Upload was successful with response: ${JSON.stringify(result)}`,
        );
    } catch (e) {
        fail(e);
    }
}

/**
 * Validates the given locales.
 *
 * @param locales - Locale codes to validate.
 * @param isMinimum - Restricts checks to critical errors when true.
 * @returns Nothing.
 */
async function validate(locales: string[], isMinimum?: boolean): Promise<void> {
    try {
        await checkTranslations(locales, { isMinimum });
    } catch (e) {
        fail(e);
    }
}

/**
 * Prints readiness for every locale without failing.
 *
 * @returns Nothing.
 */
async function summary(): Promise<void> {
    try {
        await checkTranslations(LOCALES, { isInfo: true });
    } catch (e) {
        fail(e);
    }
}

/**
 * Prints base-locale messages that no source file references.
 *
 * @returns Nothing.
 */
async function unused(): Promise<void> {
    try {
        await checkUnusedMessages();
    } catch (e) {
        fail(e);
    }
}

/**
 * Copies persistent messages from the base locale where they are missing.
 *
 * @param locales - Locale codes to top up.
 * @returns Nothing.
 */
async function addRequired(locales: string[]): Promise<void> {
    try {
        cliLog.info(await addRequiredFields(locales));
    } catch (e) {
        fail(e, 'An error during adding required occurred: ');
    }
}

program
    .command('download')
    .description('Downloads messages from localization service')
    .option(
        '-l,--locales [list...]',
        'specific list of space-separated locales',
    )
    .action(async (opts: { locales?: string[] }) => {
        let locales = LOCALES;
        let isMinimum = true;
        if (opts.locales !== undefined && opts.locales.length > 0) {
            locales = opts.locales;
            isMinimum = false;
        }
        await download(locales);
        await addRequired(locales);
        await validate(locales, isMinimum);
    });

program
    .command('upload')
    .description('Uploads base messages to the localization service')
    .action(upload);

program
    .command('validate')
    .description('Validates translations')
    .option(
        '-R,--min',
        'for critical errors of all locales and translations readiness of ours',
    )
    .option(
        '-l,--locales [list...]',
        'for specific list of space-separated locales',
    )
    .action(async (opts: { min?: boolean; locales?: string[] }) => {
        let locales = LOCALES;
        let isMinimum: boolean | undefined;
        if (opts.min === true) {
            isMinimum = true;
        } else if (opts.locales !== undefined && opts.locales.length > 0) {
            locales = opts.locales;
        }
        await validate(locales, isMinimum);
    });

program
    .command('info')
    .description('Shows locales info')
    .option('-s,--summary', 'for all locales translations readiness')
    .option('-N,--unused', 'for unused base-lang strings')
    .action(async (opts: { summary?: boolean; unused?: boolean }) => {
        if (opts.summary === true) {
            await summary();
            return;
        }
        if (opts.unused === true) {
            await unused();
            return;
        }
        await summary();
        await unused();
    });

program.parse(process.argv);
