import { YOUTUBE_WATCH_VIDEO_ID_PARAM } from '@/shared/constants';

/**
 * Local static server host used by Playwright e2e (see `e2e/fixtures`).
 */
export const E2E_HOST = '127.0.0.1';

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
        return 'e2e-fixture';
    }
    return new URLSearchParams(search).get(YOUTUBE_WATCH_VIDEO_ID_PARAM);
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
    if (hostname === E2E_HOST) {
        return true;
    }
    if (pathname.startsWith('/shorts/')) {
        return false;
    }
    return (
        pathname === '/watch' &&
        getWatchVideoIdFromSearch(hostname, search) !== null
    );
}
