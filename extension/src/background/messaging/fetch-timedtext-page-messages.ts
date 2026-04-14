import type { Runtime } from 'webextension-polyfill/namespaces/runtime';

import browser from '@/shared/browser';
import { TOPSKIP_MESSAGE } from '@/shared/messages';

const TIMEDTEXT_PREFIX = 'https://www.youtube.com/api/timedtext';

/**
 * Result shape returned from the page-world `fetch` inject.
 */
type TimedtextInjectRow = { status: number; body: string; error?: string };

/**
 * Prefers `chrome.scripting` when present so MAIN-world injection matches
 * Chrome’s native API.
 *
 * @returns `chrome.scripting` or the polyfill `browser.scripting`.
 */
function getScriptingApi(): typeof browser.scripting {
  const g = globalThis as typeof globalThis & {
    chrome?: { scripting: typeof browser.scripting };
  };
  return g.chrome?.scripting ?? browser.scripting;
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
  private constructor() {}

  /**
   * @param message Opaque runtime message.
   * @param sender Message sender (must include a tab id).
   * @returns Timedtext body or `undefined` when ignored.
   */
  static handle(
    message: unknown,
    sender: Runtime.MessageSender,
  ):
    | Promise<
        | { ok: true; status: number; body: string }
        | { ok: false; error: string }
      >
    | undefined {
    if (!message || typeof message !== 'object') {
      return undefined;
    }
    if (Reflect.get(message, 'type') !== TOPSKIP_MESSAGE.FETCH_TIMEDTEXT_PAGE) {
      return undefined;
    }
    const urlRaw: unknown = Reflect.get(message, 'url');
    if (typeof urlRaw !== 'string' || !urlRaw.startsWith(TIMEDTEXT_PREFIX)) {
      return Promise.resolve({
        ok: false,
        error: 'Invalid timedtext URL',
      });
    }
    const tabId = sender.tab?.id;
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
                ...(att.frameIds ? { frameIds: att.frameIds } : {}),
              },
              ...(att.world ? { world: att.world } : {}),
              func: (u: string): Promise<TimedtextInjectRow> =>
                fetch(u, {
                  credentials: 'include',
                  mode: 'cors',
                  referrer:
                    typeof location !== 'undefined' ? location.href : '',
                  referrerPolicy: 'strict-origin-when-cross-origin',
                })
                  .then((r) =>
                    r.text().then((body) => ({ status: r.status, body })),
                  )
                  .catch((e: unknown) => ({
                    status: 0,
                    body: '',
                    error: String(e),
                  })),
              args: [urlRaw],
            });
            const row = results[0]?.result as TimedtextInjectRow | undefined;
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
      Promise.resolve({ ok: false, error: 'No injection result' } as const),
    );

    return run.then((out) => {
      if (out.ok) {
        return out;
      }
      return {
        ok: false,
        error:
          'No injection result (all executeScript strategies returned no row)',
      } as const;
    });
  }
}
