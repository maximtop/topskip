import type { Runtime } from 'webextension-polyfill/namespaces/runtime';

import { getErrorMessage } from '@/shared/error';
import {
  TOPSKIP_MESSAGE,
  type GetChromePromptApiStatusResponse,
  type ProviderAvailabilityMessage,
  type TriggerChromeModelDownloadResponse,
} from '@/shared/messages';

/**
 * Resolves the current `LanguageModel.availability()` as a
 * `ProviderAvailabilityMessage` string. Returns `'unavailable'` when the
 * global API is absent.
 *
 * @returns Current availability mapping.
 */
async function resolveAvailability(): Promise<ProviderAvailabilityMessage> {
  const lm: unknown = Reflect.get(globalThis, 'LanguageModel');
  if (!lm || (typeof lm !== 'object' && typeof lm !== 'function')) {
    console.info(
      '[TopSkip] Chrome Built-in: LanguageModel global not found —'
      + ' requires Chrome 138+ with Prompt API enabled',
    );
    return 'unavailable';
  }
  const availFn: unknown = Reflect.get(lm, 'availability');
  if (typeof availFn !== 'function') {
    console.info(
      '[TopSkip] Chrome Built-in: LanguageModel.availability is not'
      + ' a function',
    );
    return 'unavailable';
  }
  const raw: unknown = await (availFn as () => Promise<unknown>).call(lm);
  const mapped: ProviderAvailabilityMessage = (() => {
    switch (raw) {
      case 'available':
        return 'available';
      case 'downloadable':
        return 'downloadable';
      case 'downloading':
        return 'downloading';
      default:
        return 'unavailable';
    }
  })();
  console.info(
    '[TopSkip] Chrome Built-in: LanguageModel.availability() →',
    raw, '→', mapped,
  );
  return mapped;
}

/**
 * Handles runtime messages for Chrome Built-in model status queries and
 * download triggers. Not instantiable — all members are static.
 *
 * Tracks `downloadProgress` (0–100) in memory so the options page can
 * poll for live progress while a model download is in flight.
 */
export class ChromePromptApiRuntimeMessages {
  private constructor() {}

  /**
   * Percentage 0–100 of the most recent download, or `null` if idle.
   */
  private static downloadProgress: number | null = null;

  /**
   * Dispatches `GET_CHROME_PROMPT_API_STATUS` and
   * `TRIGGER_CHROME_MODEL_DOWNLOAD` messages. Returns `undefined` for
   * messages this handler does not own.
   *
   * @param message - Opaque runtime message
   * @param _sender - Extension sender (unused)
   * @returns Response promise, or `undefined` when ignored
   */
  static handle(
    message: unknown,
    _sender: Runtime.MessageSender,
  ):
    | Promise<GetChromePromptApiStatusResponse>
    | TriggerChromeModelDownloadResponse
    | undefined {
    if (!message || typeof message !== 'object') {
      return undefined;
    }
    const typeRaw: unknown = Reflect.get(message, 'type');
    if (typeof typeRaw !== 'string') {
      return undefined;
    }

    if (typeRaw === TOPSKIP_MESSAGE.GET_CHROME_PROMPT_API_STATUS) {
      return ChromePromptApiRuntimeMessages.handleGetStatus();
    }
    if (typeRaw === TOPSKIP_MESSAGE.TRIGGER_CHROME_MODEL_DOWNLOAD) {
      return ChromePromptApiRuntimeMessages.handleTriggerDownload();
    }
    return undefined;
  }

  /**
   * Returns the current availability state and in-flight download progress.
   *
   * @returns Status response with availability and download progress.
   */
  private static async handleGetStatus(): Promise<
    GetChromePromptApiStatusResponse
  > {
    try {
      const availability = await resolveAvailability();
      return {
        ok: true,
        availability,
        downloadProgress: ChromePromptApiRuntimeMessages.downloadProgress,
      };
    } catch (e) {
      return { ok: false, error: getErrorMessage(e) };
    }
  }

  /**
   * Kicks off a `LanguageModel.create()` call with a `monitor` callback
   * that tracks download progress. Returns immediately after starting
   * the download — does **not** await completion. The created session is
   * destroyed in the background once `create()` resolves.
   *
   * @returns Immediate success/error response. Progress is tracked via
   * `downloadProgress` and exposed through `GET_CHROME_PROMPT_API_STATUS`.
   */
  private static handleTriggerDownload(): TriggerChromeModelDownloadResponse {
    const lm: unknown =
      Reflect.get(globalThis, 'LanguageModel');
    if (!lm || (typeof lm !== 'object' && typeof lm !== 'function')) {
      return { ok: false, error: 'Chrome Built-in AI is not available' };
    }
    const createFn: unknown = Reflect.get(lm, 'create');
    if (typeof createFn !== 'function') {
      return { ok: false, error: 'Chrome Built-in AI is not available' };
    }

    ChromePromptApiRuntimeMessages.downloadProgress = 0;
    console.info(
      '[TopSkip] Chrome Built-in: triggering model download via'
      + ' LanguageModel.create()',
    );

    /* Fire-and-forget: start download, track progress, clean up when done. */
    void (createFn as (
      opts: { monitor?: (m: unknown) => void },
    ) => Promise<{ destroy: () => void }>).call(lm, {
      monitor(m: unknown) {
        if (m && typeof m === 'object' && 'addEventListener' in m) {
          const monitor = m as {
            addEventListener: (
              name: string,
              cb: (ev: { loaded: number; total: number }) => void,
            ) => void;
          };
          monitor.addEventListener(
            'downloadprogress',
            (ev: { loaded: number; total: number }) => {
              /* `loaded` is a 0–1 fraction; `total` is always 1. */
              const pct = ev.total > 0
                ? (ev.loaded / ev.total) * 100
                : ev.loaded * 100;
              ChromePromptApiRuntimeMessages.downloadProgress =
                Math.round(pct * 10) / 10;
            },
          );
        }
      },
    }).then((session) => {
      session.destroy();
      console.info(
        '[TopSkip] Chrome Built-in: model download/create completed',
      );
      ChromePromptApiRuntimeMessages.downloadProgress = null;
    }).catch((e: unknown) => {
      console.warn(
        '[TopSkip] Chrome Built-in: model download failed:',
        getErrorMessage(e),
      );
      ChromePromptApiRuntimeMessages.downloadProgress = null;
    });

    return { ok: true };
  }
}
