/**
 * Pure helpers for reading InnerTube-style player JSON (no network).
 */

/**
 * User-facing reason for YouTube's bot-gated player responses.
 */
export const YOUTUBE_AUTOMATED_ACCESS_ERROR =
    'YouTube blocked automated access (try again in-browser)';

/**
 * Cheap guard for non-null object nodes while walking player JSON.
 *
 * @param value Unknown JSON value.
 * @returns Whether `value` is a non-null object record.
 */
export function isPlayerRecord(
    value: unknown,
): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}

/**
 * Reads `captions.playerCaptionsTracklistRenderer.captionTracks` from player
 * JSON.
 *
 * @param data Parsed InnerTube player JSON (`unknown`).
 * @returns Caption tracks array or `null`.
 */
export function readCaptionTracks(data: unknown): unknown[] | null {
    if (!isPlayerRecord(data)) {
        return null;
    }
    const captions = data['captions'];
    if (!isPlayerRecord(captions)) {
        return null;
    }
    const renderer = captions['playerCaptionsTracklistRenderer'];
    if (!isPlayerRecord(renderer)) {
        return null;
    }
    const tracks = renderer['captionTracks'];
    return Array.isArray(tracks) ? tracks : null;
}

/**
 * Returns the caption track URL as provided by InnerTube.
 *
 * We previously stripped `&fmt=srv3` (youtube-transcript-api style). On current
 * YouTube, that sometimes yields an **empty** timedtext body while captions
 * still render in the player — keep the server-provided `fmt`.
 *
 * @param baseUrl Track `baseUrl` from InnerTube.
 * @returns URL to GET for transcript XML.
 */
export function scrubCaptionBaseUrl(baseUrl: string): string {
    return baseUrl;
}

/**
 * Higher score = better candidate for a reliable timedtext GET (see debug logs:
 * `exp=xpe` URLs without `fmt` often return empty `text/html`).
 *
 * @param baseUrl Caption track `baseUrl`.
 * @returns Sorting score (non-negative).
 */
function timedtextUrlQuality(baseUrl: string): number {
    let q = 0;
    if (baseUrl.includes('fmt=srv3')) {
        q += 10;
    } else if (/[?&]fmt=/.test(baseUrl)) {
        q += 4;
    }
    if (!baseUrl.includes('exp=xpe')) {
        q += 6;
    }
    return q;
}

/**
 * Picks a caption track URL from InnerTube `captionTracks`, preferring English.
 *
 * @param tracks Raw `captionTracks` array from the player JSON.
 * @returns Selected `baseUrl` and language code, or an error message.
 */
export function pickCaptionBaseUrl(tracks: unknown):
    | {
          ok: true;
          baseUrl: string;
          languageCode: string;
      }
    | { ok: false; error: string } {
    if (!Array.isArray(tracks) || tracks.length === 0) {
        return { ok: false, error: 'No caption tracks in player response' };
    }

    /**
     * Normalized caption track fields read from untrusted player JSON.
     */
    type Track = Record<string, unknown> & {
        baseUrl?: unknown;
        languageCode?: unknown;
        kind?: unknown;
    };

    const normalized: Track[] = tracks.filter(isPlayerRecord);

    /**
     * Prefer `baseUrl` without `&exp=xpe` when YouTube offers multiple tracks per
     * language (experiment URLs may still work but standard timedtext is more
     * reliable from extensions).
     *
     * @param code Preferred language code.
     * @returns Matching track or `undefined`.
     */
    const pickForLanguage = (code: string): Track | undefined => {
        const matches = normalized.filter(
            (x) =>
                typeof x.languageCode === 'string' &&
                x.languageCode === code &&
                typeof x.baseUrl === 'string',
        );
        if (matches.length === 0) {
            return undefined;
        }
        return [...matches].sort(
            (a, b) =>
                timedtextUrlQuality(String(b.baseUrl)) -
                timedtextUrlQuality(String(a.baseUrl)),
        )[0];
    };

    const preferOrder = ['en', 'en-US', 'en-GB'];
    for (const code of preferOrder) {
        const t = pickForLanguage(code);
        if (t?.baseUrl && typeof t.baseUrl === 'string') {
            return {
                ok: true,
                baseUrl: scrubCaptionBaseUrl(t.baseUrl),
                languageCode: code,
            };
        }
    }

    const withUrl = normalized.filter((x) => typeof x.baseUrl === 'string');
    const first = [...withUrl].sort(
        (a, b) =>
            timedtextUrlQuality(String(b.baseUrl)) -
            timedtextUrlQuality(String(a.baseUrl)),
    )[0];
    if (first?.baseUrl && typeof first.baseUrl === 'string') {
        const lang =
            typeof first.languageCode === 'string'
                ? first.languageCode
                : 'unknown';
        return {
            ok: true,
            baseUrl: scrubCaptionBaseUrl(first.baseUrl),
            languageCode: lang,
        };
    }

    return { ok: false, error: 'Caption tracks missing baseUrl' };
}

/**
 * Lists caption tracks for sequential transcript fetch attempts (English first,
 * then by timedtext URL quality).
 *
 * @param tracks Raw `captionTracks` from player JSON.
 * @returns Non-empty list or empty array if no usable `baseUrl`.
 */
export function listCaptionTracksOrdered(
    tracks: unknown,
): Array<{ baseUrl: string; languageCode: string }> {
    if (!Array.isArray(tracks) || tracks.length === 0) {
        return [];
    }

    /**
     * Normalized caption track fields needed for ordered fetch attempts.
     */
    type Track = Record<string, unknown> & {
        baseUrl?: unknown;
        languageCode?: unknown;
    };

    const normalized: Track[] = tracks.filter(isPlayerRecord);
    const withUrl = normalized
        .filter((x) => typeof x.baseUrl === 'string')
        .map((x) => ({
            baseUrl: scrubCaptionBaseUrl(String(x.baseUrl)),
            languageCode:
                typeof x.languageCode === 'string' ? x.languageCode : 'unknown',
        }));

    const preferLang = new Set(['en', 'en-US', 'en-GB']);
    return [...withUrl].sort((a, b) => {
        const ap = preferLang.has(a.languageCode) ? 1 : 0;
        const bp = preferLang.has(b.languageCode) ? 1 : 0;
        if (bp !== ap) {
            return bp - ap;
        }
        return timedtextUrlQuality(b.baseUrl) - timedtextUrlQuality(a.baseUrl);
    });
}

/**
 * Checks InnerTube playability and returns an error string if not playable.
 *
 * @param data Parsed player JSON.
 * @returns Error message or `null` if OK.
 */
export function playabilityError(data: unknown): string | null {
    if (!isPlayerRecord(data)) {
        return 'Invalid player response';
    }
    const ps = data['playabilityStatus'];
    if (!isPlayerRecord(ps)) {
        return null;
    }
    const status = ps['status'];
    if (status === 'OK' || status === undefined) {
        return null;
    }
    const reason =
        typeof ps['reason'] === 'string' ? ps['reason'] : 'Video unplayable';
    if (status === 'LOGIN_REQUIRED' && reason.includes('not a bot')) {
        return YOUTUBE_AUTOMATED_ACCESS_ERROR;
    }
    return reason;
}
