import { YOUTUBE_BASE_URL } from '@/shared/constants';

/**
 * URL patterns for programmatic registration of the watch content script
 * (`content.js`). `127.0.0.1:4173` is included only in **dev** builds (E2E
 * fixtures); see `rspack.config.ts` `DefinePlugin`.
 *
 * @returns Match patterns for `browser.scripting.registerContentScripts`
 */
export function getWatchContentScriptMatches(): string[] {
    const matches = [`${YOUTUBE_BASE_URL}/*`];
    if (
        typeof __TOPSKIP_INCLUDE_DEV_LOCAL__ !== 'undefined' &&
        __TOPSKIP_INCLUDE_DEV_LOCAL__
    ) {
        matches.push('http://127.0.0.1:4173/*');
    }
    return matches;
}
