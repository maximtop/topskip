import {
    DEV_E2E_FIXTURE_VIDEO_ID,
    DEV_E2E_ORIGIN,
    YOUTUBE_ORIGIN,
    YOUTUBE_WATCH_PATH,
    getWatchVideoIdFromUrl,
} from '@/shared/watch-route';

/**
 * Local static server host used by Playwright e2e (see `tests/e2e/fixtures`);
 * `null` outside development bundles.
 */
export const E2E_HOST: string | null =
    DEV_E2E_ORIGIN === null ? null : new URL(DEV_E2E_ORIGIN).hostname;

/**
 * Exact production hostname accepted by the legacy URL-parts boundary.
 */
const YOUTUBE_HOST = new URL(YOUTUBE_ORIGIN).hostname;

/**
 * Returns the YouTube `v` id from the URL, or a fixed id for the e2e fixture
 * host.
 *
 * @param hostname Current document hostname.
 * @param search `location.search` string (includes `?` prefix handling via
 * URLSearchParams).
 * @returns The watch video id, a fixture placeholder, or `null` when absent.
 */
export function getWatchVideoIdFromSearch(
    hostname: string,
    search: string,
): string | null {
    if (hostname === E2E_HOST) {
        return DEV_E2E_FIXTURE_VIDEO_ID;
    }
    if (hostname !== YOUTUBE_HOST) {
        return null;
    }
    return getWatchVideoIdFromUrl(
        `${YOUTUBE_ORIGIN}${YOUTUBE_WATCH_PATH}${search}`,
    );
}

/**
 * Whether the TopSkip content script should run on this URL (watch pages, e2e
 * fixture).
 *
 * @param input URL parts for the current document.
 * @returns `true` when the script should activate on this page.
 */
export function shouldActivateTopSkip(input: {
    hostname: string;
    pathname: string;
    search: string;
}): boolean {
    const { hostname, pathname, search } = input;
    const origin =
        DEV_E2E_ORIGIN !== null && hostname === E2E_HOST
            ? DEV_E2E_ORIGIN
            : `https://${hostname}`;
    return getWatchVideoIdFromUrl(`${origin}${pathname}${search}`) !== null;
}
