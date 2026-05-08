import browser from '@/shared/browser';
import { YOUTUBE_TIMEDTEXT_URL } from '@/shared/constants';

/**
 * Result shape returned from the page-world `fetch` inject.
 */
type TimedtextInjectRow = { status: number; body: string; error?: string };

/**
 * Type guard for the inject result returned from the page-world script.
 *
 * @param value - Unknown value from `scripting.executeScript` result.
 * @returns Whether `value` matches the expected `TimedtextInjectRow` shape.
 */
function isTimedtextInjectRow(value: unknown): value is TimedtextInjectRow {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof Reflect.get(value, 'status') === 'number' &&
        typeof Reflect.get(value, 'body') === 'string'
    );
}

/**
 * Prefers `chrome.scripting` when present so MAIN-world injection matches
 * Chrome's native API.
 *
 * @returns `chrome.scripting` or the polyfill `browser.scripting`.
 */
function getScriptingApi(): typeof browser.scripting {
    const chromeProp = Reflect.get(globalThis, 'chrome');
    const scripting =
        chromeProp && typeof chromeProp === 'object'
            ? Reflect.get(chromeProp, 'scripting')
            : undefined;
    return (
        (scripting as typeof browser.scripting | undefined) ?? browser.scripting
    );
}

/**
 * Runs `fetch` in the **page** JS world via `scripting.executeScript`.
 * Content-script `fetch` to timedtext can return HTTP 200 with empty bodies;
 * the page world matches the player and receives transcript bytes.
 *
 * Uses a `.then()` chain (not `async`) in the injected function — some Chrome
 * builds fail to surface `results[0].result` for `async` MAIN-world injects.
 */
export class FetchTimedtextPageMessages {
    /**
     * Dispatches a timedtext fetch to a page-world `fetch` inject across
     * multiple `scripting.executeScript` strategies until one succeeds.
     *
     * @param url - Timedtext URL to fetch; must begin with the YouTube timedtext
     * API prefix.
     * @param tabId - Target tab id; when absent the fetch cannot proceed.
     * @returns Timedtext body on success, or a structured error response.
     */
    static fetch(
        url: string,
        tabId: number | undefined,
    ): Promise<
        | { ok: true; status: number; body: string }
        | { ok: false; error: string }
    > {
        if (!url.startsWith(YOUTUBE_TIMEDTEXT_URL)) {
            return Promise.resolve({
                ok: false,
                error: 'Invalid timedtext URL',
            });
        }
        if (tabId === undefined) {
            return Promise.resolve({ ok: false, error: 'No tab id' });
        }

        const scripting = getScriptingApi();

        const attempts: {
            label: string;
            world?: 'MAIN';
            frameIds?: number[];
        }[] = [
            { label: 'main_frame0', world: 'MAIN', frameIds: [0] },
            { label: 'main', world: 'MAIN' },
            { label: 'isolated_frame0', frameIds: [0] },
            { label: 'isolated', frameIds: undefined },
        ];

        type TimedtextAttemptResult =
            | { ok: true; status: number; body: string }
            | { ok: false; error: string };
        const run = attempts.reduce<Promise<TimedtextAttemptResult>>(
            (chain, att) =>
                chain.then(async (prev) => {
                    if (prev.ok) {
                        return prev;
                    }
                    try {
                        const results = await scripting.executeScript({
                            target: {
                                tabId,
                                ...(att.frameIds
                                    ? { frameIds: att.frameIds }
                                    : {}),
                            },
                            ...(att.world ? { world: att.world } : {}),
                            func: (u: string): Promise<TimedtextInjectRow> =>
                                fetch(u, {
                                    credentials: 'include',
                                    mode: 'cors',
                                    referrer:
                                        typeof location !== 'undefined'
                                            ? location.href
                                            : '',
                                    referrerPolicy:
                                        'strict-origin-when-cross-origin',
                                })
                                    .then((r) =>
                                        r.text().then((body) => ({
                                            status: r.status,
                                            body,
                                        })),
                                    )
                                    .catch((e: unknown) => ({
                                        status: 0,
                                        body: '',
                                        error: String(e),
                                    })),
                            args: [url],
                        });
                        const raw = results[0]?.result;
                        const row = isTimedtextInjectRow(raw) ? raw : undefined;
                        if (!row) {
                            return prev;
                        }
                        if (row.error) {
                            return { ok: false, error: row.error } as const;
                        }
                        return {
                            ok: true,
                            status: row.status,
                            body: row.body,
                        } as const;
                    } catch {
                        return prev;
                    }
                }),
            Promise.resolve({
                ok: false,
                error: 'No injection result',
            } as const),
        );

        return run.then((out) => {
            if (out.ok) {
                return out;
            }
            return {
                ok: false,
                error: 'No injection result (all executeScript strategies returned no row)',
            } as const;
        });
    }
}
