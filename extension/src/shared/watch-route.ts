/**
 * Exact YouTube origin receiving the declarative TopSkip bundles.
 */
export const YOUTUBE_ORIGIN = 'https://www.youtube.com';

/**
 * Chrome match pattern for the supported YouTube origin.
 */
export const YOUTUBE_CONTENT_SCRIPT_MATCH = `${YOUTUBE_ORIGIN}/*`;

/**
 * Standard long-form YouTube player route.
 */
export const YOUTUBE_WATCH_PATH = '/watch';

/**
 * Query parameter carrying the current YouTube video identity.
 */
export const YOUTUBE_WATCH_VIDEO_ID_PARAM = 'v';

/**
 * Exact local origin reserved for deterministic browser fixtures.
 */
export const DEV_E2E_ORIGIN = 'http://127.0.0.1:4173';

/**
 * Development-only Chrome match pattern for browser fixtures.
 */
export const DEV_E2E_CONTENT_SCRIPT_MATCH = `${DEV_E2E_ORIGIN}/*`;

/**
 * Stable synthetic identity used by the local fixture page.
 */
export const DEV_E2E_FIXTURE_VIDEO_ID = 'e2eFixture1';

/**
 * Recognizes only origins that receive the declarative isolated bundle.
 *
 * @param input - Absolute document URL supplied by the browser.
 * @returns Whether the document belongs to a statically matched origin.
 */
export function isTopSkipContentDocumentUrl(input: string | URL): boolean {
    let url: URL;
    try {
        url = new URL(input);
    } catch {
        return false;
    }
    if (url.username !== '' || url.password !== '') {
        return false;
    }
    return url.origin === YOUTUBE_ORIGIN || url.origin === DEV_E2E_ORIGIN;
}

/**
 * Keeps route ownership independent from DOM globals and Chrome APIs so the
 * same strict origin policy can be reused by every extension context.
 *
 * @param input - Absolute candidate URL.
 * @returns Current watch video identity, or `null` outside supported routes.
 */
export function getWatchVideoIdFromUrl(input: string | URL): string | null {
    let url: URL;
    try {
        url = new URL(input);
    } catch {
        return null;
    }
    if (url.username !== '' || url.password !== '') {
        return null;
    }
    if (url.origin === DEV_E2E_ORIGIN) {
        return DEV_E2E_FIXTURE_VIDEO_ID;
    }
    const isYouTubeWatchRoute =
        url.origin === YOUTUBE_ORIGIN && url.pathname === YOUTUBE_WATCH_PATH;
    if (!isYouTubeWatchRoute) {
        return null;
    }
    const videoId = url.searchParams.get(YOUTUBE_WATCH_VIDEO_ID_PARAM);
    return videoId === null || videoId.length === 0 ? null : videoId;
}
