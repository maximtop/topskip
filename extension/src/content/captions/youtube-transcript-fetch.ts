import {
    readInnertubeApiKeyFromPage,
    readInnertubeClientVersionFromPage,
    readYtInitialPlayerResponseFromPage,
} from '@/content/captions/page-player-response';
import {
    findGetTranscriptParams,
    findParamsOnCaptionTracks,
    segmentsFromGetTranscriptJson,
} from '@/shared/captions/get-transcript-innertube';
import {
    listCaptionTracksOrdered,
    playabilityError,
    readCaptionTracks,
} from '@/shared/captions/player-json';
import { parseTranscriptJson3 } from '@/shared/captions/transcript-json3';
import { parseTranscriptXml } from '@/shared/captions/transcript-xml';
import type { TranscriptFetchResult } from '@/shared/caption-types';
import {
    CAPTION_TRANSCRIPT_ALLOW_INNERTUBE_FALLBACK,
    MIME_APPLICATION_JSON,
    YOUTUBE_BASE_URL,
    YOUTUBE_TIMEDTEXT_URL,
    YOUTUBE_WATCH_URL_PATH,
} from '@/shared/constants';
import browser from '@/shared/browser';
import type { FetchTimedtextPageResponse } from '@/shared/messages';
import { TOPSKIP_MESSAGE } from '@/shared/messages';

const WATCH_URL = (videoId: string): string =>
    `${YOUTUBE_BASE_URL}${YOUTUBE_WATCH_URL_PATH}` +
    `?v=${encodeURIComponent(videoId)}`;

const INNERTUBE_PLAYER_URL = (apiKey: string): string =>
    `${YOUTUBE_BASE_URL}/youtubei/v1/player?key=${encodeURIComponent(apiKey)}`;

const INNERTUBE_BODY = (videoId: string) =>
    ({
        context: {
            client: { clientName: 'ANDROID', clientVersion: '20.10.38' },
        },
        videoId,
    }) as const;

const API_KEY_PATTERN = /"INNERTUBE_API_KEY":\s*"([a-zA-Z0-9_-]+)"/;

const GET_TRANSCRIPT_URL = (apiKey: string): string =>
    [
        `${YOUTUBE_BASE_URL}/youtubei/v1/get_transcript`,
        `?key=${encodeURIComponent(apiKey)}`,
        '&prettyPrint=false',
    ].join('');

/**
 * Fetches `youtubei/v1/player` with the **ANDROID** InnerTube client (same body
 * as the legacy watch-page path). The embedded page player can omit caption
 * metadata; this response usually includes full `captionTracks`.
 *
 * @param videoId Watch video id.
 * @returns Parsed player JSON or `null` on failure.
 */
async function fetchInnertubePlayerSupplemental(
    videoId: string,
): Promise<unknown> {
    const apiKey = readInnertubeApiKeyFromPage();
    if (!apiKey) {
        return null;
    }
    try {
        const playerHeaders: Record<string, string> = {
            Accept: MIME_APPLICATION_JSON,
            'Content-Type': MIME_APPLICATION_JSON,
            Origin: YOUTUBE_BASE_URL,
            Referer: WATCH_URL(videoId),
        };
        if (typeof navigator !== 'undefined' && navigator.userAgent) {
            playerHeaders['User-Agent'] = navigator.userAgent;
        }
        const playerRes = await fetch(INNERTUBE_PLAYER_URL(apiKey), {
            method: 'POST',
            ...youtubeFetchInit(playerHeaders),
            body: JSON.stringify(INNERTUBE_BODY(videoId)),
        });
        let json: unknown;
        try {
            json = (await playerRes.json()) as unknown;
        } catch {
            return null;
        }
        if (!playerRes.ok) {
            return null;
        }
        return json;
    } catch {
        return null;
    }
}

/**
 * Innertube `get_transcript` when timedtext GET returns empty (e.g. missing
 * `pot`). Uses `params` from caption tracks or `getTranscriptEndpoint` in the
 * player JSON.
 *
 * @param videoId Watch video id.
 * @param languageCode Best-effort language label for the result.
 * @param tracks Caption tracks array (same as player).
 * @param playerJson Full player object for deep `params` search.
 * @returns Parsed transcript, error, or `null` if no API key / params.
 */
async function fetchTranscriptViaGetTranscript(
    videoId: string,
    languageCode: string,
    tracks: unknown[],
    playerJson: unknown,
): Promise<TranscriptFetchResult | null> {
    const apiKey = readInnertubeApiKeyFromPage();
    const params =
        findParamsOnCaptionTracks(tracks) ??
        findGetTranscriptParams(playerJson);
    const clientVersionFromPage = readInnertubeClientVersionFromPage();
    const clientVersion = clientVersionFromPage ?? '2.20241126.01.00';
    if (!apiKey || !params) {
        return null;
    }
    try {
        const res = await fetch(GET_TRANSCRIPT_URL(apiKey), {
            method: 'POST',
            ...youtubeFetchInit({
                Accept: MIME_APPLICATION_JSON,
                'Content-Type': MIME_APPLICATION_JSON,
                Origin: YOUTUBE_BASE_URL,
                Referer: WATCH_URL(videoId),
            }),
            body: JSON.stringify({
                context: {
                    client: {
                        hl: 'en',
                        gl: 'US',
                        clientName: 'WEB',
                        clientVersion,
                    },
                },
                videoId,
                params,
            }),
        });
        const bodyText = await res.text();
        let json: unknown;
        try {
            json = JSON.parse(bodyText) as unknown;
        } catch {
            return {
                ok: false,
                error: res.ok
                    ? 'get_transcript response was not JSON'
                    : `get_transcript HTTP ${String(res.status)}`,
            };
        }
        if (!res.ok) {
            return {
                ok: false,
                error: `get_transcript HTTP ${String(res.status)}`,
            };
        }
        const segments = segmentsFromGetTranscriptJson(json);
        if (!segments || segments.length === 0) {
            return {
                ok: false,
                error: 'No segments in get_transcript response',
            };
        }
        return {
            ok: true,
            videoId,
            languageCode,
            segments,
        };
    } catch (e) {
        return {
            ok: false,
            error: `get_transcript failed: ${String(e)}`,
        };
    }
}

/**
 * Minimal `v`+`lang`+`fmt` URL (no InnerTube tokens). Compare with DevTools →
 * Network → filter `timedtext`: the page often sends extra params (`pot`,
 * `signature`, etc.); without them YouTube may return **200 with an empty
 * body**.
 *
 * @param videoId YouTube video id.
 * @param languageCode Track language (e.g. `ru`, `en`).
 * @param fmt Response format.
 * @returns `https://www.youtube.com/api/timedtext?...` URL.
 */
function buildMinimalTimedtextUrl(
    videoId: string,
    languageCode: string,
    fmt: 'srv3' | 'json3',
): string {
    const lang = languageCode === 'unknown' ? 'en' : languageCode;
    const p = new URLSearchParams({ v: videoId, fmt, lang });
    return `${YOUTUBE_TIMEDTEXT_URL}?${p.toString()}`;
}

/**
 * Last-resort timedtext fetch from the **content script** (isolated world).
 * Used when `scripting.executeScript` yields no serializable result.
 *
 * @param url Timedtext URL (`https://www.youtube.com/api/timedtext?...`).
 * @returns Fetch result with body or an error string.
 */
async function fetchTimedtextBodyContentScriptDirect(
    url: string,
): Promise<FetchTimedtextPageResponse> {
    try {
        const r = await fetch(url, {
            credentials: 'include',
            mode: 'cors',
            ...youtubeFetchInit({
                Accept: '*/*',
                Referer:
                    typeof location !== 'undefined'
                        ? location.href
                        : `${YOUTUBE_BASE_URL}/`,
            }),
            referrerPolicy: 'strict-origin-when-cross-origin',
        });
        const body = await r.text();
        return { ok: true, status: r.status, body };
    } catch (e) {
        return { ok: false, error: `content-fetch: ${String(e)}` };
    }
}

/**
 * Fetches timedtext in the **page** MAIN world (see background handler).
 * Isolated content-script `fetch` returned HTTP 200 with empty bodies on
 * youtube.com.
 *
 * @param url Must be `https://www.youtube.com/api/timedtext?...`.
 * @returns Timedtext body or an error.
 */
async function fetchTimedtextBodyPageWorld(
    url: string,
): Promise<FetchTimedtextPageResponse> {
    const res: unknown = await browser.runtime.sendMessage({
        type: TOPSKIP_MESSAGE.FETCH_TIMEDTEXT_PAGE,
        url,
    });
    if (!res || typeof res !== 'object') {
        return { ok: false, error: 'Invalid timedtext fetch response' };
    }
    const okField: unknown = Reflect.get(res, 'ok');
    if (okField === true) {
        const statusRaw: unknown = Reflect.get(res, 'status');
        const bodyRaw: unknown = Reflect.get(res, 'body');
        if (typeof statusRaw === 'number' && typeof bodyRaw === 'string') {
            return { ok: true, status: statusRaw, body: bodyRaw };
        }
    }
    if (okField === false) {
        const errRaw: unknown = Reflect.get(res, 'error');
        if (typeof errRaw === 'string') {
            if (errRaw.includes('injection result')) {
                return fetchTimedtextBodyContentScriptDirect(url);
            }
            return { ok: false, error: errRaw };
        }
    }
    return { ok: false, error: 'Invalid timedtext fetch response' };
}

/**
 * Parses timedtext body (XML or JSON) into segments.
 *
 * @param body Response text.
 * @returns Parsed segments or an error string.
 */
function parseTranscriptBody(
    body: string,
): ReturnType<typeof parseTranscriptXml> {
    const t = body.trim();
    if (t.length === 0) {
        return { ok: false, error: 'Empty transcript response' };
    }
    if (t.startsWith('{')) {
        return parseTranscriptJson3(body);
    }
    return parseTranscriptXml(body);
}

/**
 * Default headers for same-origin YouTube requests from the content script.
 *
 * @param extra Optional header fields merged over defaults.
 * @returns Headers for caption / watch fetches.
 */
function youtubeFetchInit(extra: Record<string, string> = {}): RequestInit {
    return {
        credentials: 'include',
        headers: {
            'Accept-Language': 'en-US,en;q=0.9',
            ...extra,
        },
    };
}

/**
 * Downloads timedtext XML and parses segments.
 *
 * @param baseUrl Caption track URL.
 * @param videoId Watch video id for success payload.
 * @param languageCode Selected track language code.
 * @returns Parsed transcript or error.
 */
async function fetchAndParseTimedtext(
    baseUrl: string,
    videoId: string,
    languageCode: string,
): Promise<TranscriptFetchResult> {
    const attempts: { tag: string; url: string }[] = [
        { tag: 'exact', url: baseUrl },
        {
            tag: 'minimalSrv3',
            url: buildMinimalTimedtextUrl(videoId, languageCode, 'srv3'),
        },
        {
            tag: 'minimalJson3',
            url: buildMinimalTimedtextUrl(videoId, languageCode, 'json3'),
        },
    ];

    let lastError = 'Empty transcript response';

    try {
        for (const { url } of attempts) {
            let fetchRes: FetchTimedtextPageResponse;
            try {
                fetchRes = await fetchTimedtextBodyPageWorld(url);
            } catch (e) {
                lastError = `Network error loading transcript: ${String(e)}`;
                continue;
            }
            if (!fetchRes.ok) {
                lastError = fetchRes.error;
                continue;
            }
            if (fetchRes.status < 200 || fetchRes.status >= 300) {
                lastError = `Transcript HTTP ${String(fetchRes.status)}`;
                continue;
            }
            const body = fetchRes.body;
            const parsed = parseTranscriptBody(body);
            if (parsed.ok) {
                return {
                    ok: true,
                    videoId,
                    languageCode,
                    segments: parsed.segments,
                };
            }
            lastError = parsed.error;
        }
    } catch (e) {
        return {
            ok: false,
            error: `Network error loading transcript: ${String(e)}`,
        };
    }

    return { ok: false, error: lastError };
}

/**
 * Builds a transcript from InnerTube-style player JSON (already parsed).
 *
 * @param playerJson Player response object.
 * @param videoId YouTube video id.
 * @param supplementalPlayerFetched When `true`, skips the extra ANDROID
 *   `player` API round-trip (see {@link fetchInnertubePlayerSupplemental}).
 * @returns Parsed result or structured error.
 */
async function transcriptFromPlayerJson(
    playerJson: unknown,
    videoId: string,
    supplementalPlayerFetched = false,
): Promise<TranscriptFetchResult> {
    const playErr = playabilityError(playerJson);
    if (playErr) {
        return { ok: false, error: playErr };
    }

    const tracks = readCaptionTracks(playerJson);
    if (!tracks) {
        return {
            ok: false,
            error: [
                'No captions in player response',
                '(transcripts disabled or unavailable)',
            ].join(' '),
        };
    }

    const ordered = listCaptionTracksOrdered(tracks);
    if (ordered.length === 0) {
        return { ok: false, error: 'Caption tracks missing baseUrl' };
    }

    let lastError = 'Transcript unavailable';
    for (const { baseUrl, languageCode } of ordered) {
        const r = await fetchAndParseTimedtext(baseUrl, videoId, languageCode);
        if (r.ok) {
            return r;
        }
        lastError = r.error;
    }
    const fallbackLang = ordered[0]?.languageCode ?? 'unknown';
    const viaGt = await fetchTranscriptViaGetTranscript(
        videoId,
        fallbackLang,
        tracks,
        playerJson,
    );
    if (viaGt) {
        if (viaGt.ok) {
            return viaGt;
        }
        lastError = viaGt.error;
    } else if (!supplementalPlayerFetched) {
        const rich = await fetchInnertubePlayerSupplemental(videoId);
        if (rich) {
            return transcriptFromPlayerJson(rich, videoId, true);
        }
    }
    return { ok: false, error: lastError };
}

/**
 * Legacy path: watch HTML → InnerTube POST → timedtext.
 *
 * @param videoId YouTube video id.
 * @returns Parsed transcript or error.
 */
async function fetchYoutubeTranscriptViaInnertube(
    videoId: string,
): Promise<TranscriptFetchResult> {
    let html: string;
    try {
        const watchRes = await fetch(WATCH_URL(videoId), {
            ...youtubeFetchInit({
                Accept: 'text/html,application/xhtml+xml',
            }),
        });
        if (!watchRes.ok) {
            return {
                ok: false,
                error: `Watch page HTTP ${String(watchRes.status)}`,
            };
        }
        html = await watchRes.text();
    } catch (e) {
        return {
            ok: false,
            error: `Network error loading watch page: ${String(e)}`,
        };
    }

    if (html.includes('action="https://consent.youtube.com/s"')) {
        return {
            ok: false,
            error: [
                'YouTube showed a consent interstitial —',
                'open youtube.com in a tab and retry',
            ].join(' '),
        };
    }

    const keyMatch = API_KEY_PATTERN.exec(html);
    if (!keyMatch?.[1]) {
        if (html.includes('class="g-recaptcha"')) {
            return {
                ok: false,
                error: 'YouTube blocked the request (captcha / bot check)',
            };
        }
        return {
            ok: false,
            error: 'Could not find InnerTube API key in watch page HTML',
        };
    }
    const apiKey = keyMatch[1];

    let playerJson: unknown;
    try {
        const playerHeaders: Record<string, string> = {
            Accept: MIME_APPLICATION_JSON,
            'Accept-Language': 'en-US,en;q=0.9',
            'Content-Type': MIME_APPLICATION_JSON,
            Origin: YOUTUBE_BASE_URL,
            Referer: WATCH_URL(videoId),
        };
        if (typeof navigator !== 'undefined' && navigator.userAgent) {
            playerHeaders['User-Agent'] = navigator.userAgent;
        }

        const playerRes = await fetch(INNERTUBE_PLAYER_URL(apiKey), {
            method: 'POST',
            ...youtubeFetchInit(playerHeaders),
            body: JSON.stringify(INNERTUBE_BODY(videoId)),
        });

        if (!playerRes.ok) {
            return {
                ok: false,
                error: `InnerTube player HTTP ${String(playerRes.status)}`,
            };
        }
        playerJson = (await playerRes.json()) as unknown;
    } catch (e) {
        return {
            ok: false,
            error: `Network error calling InnerTube player: ${String(e)}`,
        };
    }

    return transcriptFromPlayerJson(playerJson, videoId);
}

/**
 * Prefers `window.ytInitialPlayerResponse` (page bridge), then optional legacy
 * InnerTube chain. **Content script only.**
 *
 * @param videoId YouTube video id (`v` query).
 * @returns Parsed transcript or a human-readable error.
 */
export async function fetchYoutubeTranscript(
    videoId: string,
): Promise<TranscriptFetchResult> {
    const fromPage = await readYtInitialPlayerResponseFromPage();
    if (fromPage) {
        const direct = await transcriptFromPlayerJson(fromPage, videoId);
        if (direct.ok) {
            return direct;
        }
        if (!CAPTION_TRANSCRIPT_ALLOW_INNERTUBE_FALLBACK) {
            return direct;
        }
    } else if (!CAPTION_TRANSCRIPT_ALLOW_INNERTUBE_FALLBACK) {
        return {
            ok: false,
            error: [
                'No in-page player data yet — wait for the player, or set',
                'CAPTION_TRANSCRIPT_ALLOW_INNERTUBE_FALLBACK for the legacy fetch path',
            ].join(' '),
        };
    }

    return fetchYoutubeTranscriptViaInnertube(videoId);
}
