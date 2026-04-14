/**
 * Extracts the watch-page `v` id from a YouTube URL (navigation / address bar).
 * Ignores Shorts, embeds, and non-watch paths.
 *
 * @param urlString Full URL (e.g. from `window.location` or messaging).
 * @returns The video id, or `null` when not a standard watch URL.
 */
export function videoIdFromYoutubeWatchUrl(urlString: string): string | null {
  try {
    const u = new URL(urlString);
    const hostOk =
      u.hostname === 'www.youtube.com' || u.hostname === 'm.youtube.com';
    if (!hostOk) {
      return null;
    }
    if (u.pathname !== '/watch') {
      return null;
    }
    const v = u.searchParams.get('v');
    if (typeof v !== 'string' || v.length === 0) {
      return null;
    }
    return v;
  } catch {
    return null;
  }
}
