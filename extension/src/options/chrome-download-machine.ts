import { assign, fromCallback, fromPromise, setup } from 'xstate';

import { getErrorMessage } from '@/shared/error';

type DownloadContext = {
  progress: number;
  extracting: boolean;
  error: string | null;
};

type DownloadEvent =
  | { type: 'DOWNLOAD' }
  | { type: 'RETRY' }
  | { type: 'PROGRESS'; loaded: number }
  | { type: 'DOWNLOAD_COMPLETE' }
  | { type: 'DOWNLOAD_ERROR'; error: string };

type Availability =
  | 'unavailable'
  | 'downloadable'
  | 'downloading'
  | 'available';

/**
 * Checks `LanguageModel.availability()` directly on the global scope.
 * The options page is an extension page with access to the same web
 * platform APIs as regular pages, including the Chrome Prompt API.
 *
 * @returns Availability string, or `'unavailable'` if the API is absent.
 */
async function checkAvailability(): Promise<Availability> {
  if (!('LanguageModel' in globalThis)) {
    return 'unavailable';
  }
  const lm: unknown = Reflect.get(globalThis, 'LanguageModel');
  const availFn: unknown = lm
    && (typeof lm === 'object' || typeof lm === 'function')
    ? Reflect.get(lm, 'availability')
    : undefined;
  if (typeof availFn !== 'function') {
    return 'unavailable';
  }
  const raw: unknown = await (availFn as () => Promise<unknown>).call(lm);
  switch (raw) {
    case 'available':
    case 'downloadable':
    case 'downloading':
      return raw;
    default:
      return 'unavailable';
  }
}

/**
 * Callback actor that calls `LanguageModel.create({ monitor })` directly.
 * Sends `PROGRESS`, `DOWNLOAD_COMPLETE`, or `DOWNLOAD_ERROR` events back
 * to the parent machine. Uses an `AbortController` so the download is
 * cancelled if the actor is stopped (e.g. user navigates away).
 *
 * Follows the official Chrome pattern from
 * https://developer.chrome.com/docs/ai/inform-users-of-model-download
 */
const downloadModel = fromCallback<DownloadEvent>(({ sendBack }) => {
  const controller = new AbortController();

  const lm: unknown = Reflect.get(globalThis, 'LanguageModel');
  if (!lm || (typeof lm !== 'object' && typeof lm !== 'function')) {
    sendBack({ type: 'DOWNLOAD_ERROR', error: 'LanguageModel not available' });
    return () => {};
  }
  const createFn: unknown = Reflect.get(lm, 'create');
  if (typeof createFn !== 'function') {
    sendBack({
      type: 'DOWNLOAD_ERROR',
      error: 'LanguageModel.create not available',
    });
    return () => {};
  }

  void (createFn as (
    opts: { signal?: AbortSignal; monitor?: (m: unknown) => void },
  ) => Promise<{ destroy: () => void }>).call(lm, {
    signal: controller.signal,
    monitor(m: unknown) {
      if (m && typeof m === 'object' && 'addEventListener' in m) {
        const monitor = m as {
          addEventListener: (
            name: string,
            cb: (ev: { loaded: number }) => void,
          ) => void;
        };
        monitor.addEventListener(
          'downloadprogress',
          (ev: { loaded: number }) => {
            /* `loaded` is a 0–1 fraction per the Chrome Prompt API spec. */
            sendBack({ type: 'PROGRESS', loaded: ev.loaded });
          },
        );
      }
    },
  }).then((session) => {
    session.destroy();
    sendBack({ type: 'DOWNLOAD_COMPLETE' });
  }).catch((e: unknown) => {
    /* Ignore abort errors — they're expected when the actor is stopped. */
    if (!controller.signal.aborted) {
      sendBack({ type: 'DOWNLOAD_ERROR', error: getErrorMessage(e) });
    }
  });

  return () => {
    controller.abort();
  };
});

/**
 * XState machine modelling the Chrome Built-in model download lifecycle.
 *
 * Calls `LanguageModel.availability()` and `LanguageModel.create()` directly
 * from the options page — no background message relay or polling needed.
 * Progress events come in real-time from the `monitor` callback.
 *
 * States: checking → unavailable | downloadable | downloading | ready | error
 *
 * Follows the official Chrome pattern from
 * https://developer.chrome.com/docs/ai/inform-users-of-model-download
 */
export const chromeDownloadMachine = setup({
  types: {
    context: {} as DownloadContext,
    events: {} as DownloadEvent,
  },
  actors: {
    checkAvailability: fromPromise(checkAvailability),
    downloadModel,
  },
  delays: {
    POLL_SLOW: 3000,
  },
}).createMachine({
  id: 'chromeDownload',
  initial: 'checking',
  context: {
    progress: 0,
    extracting: false,
    error: null,
  },

  states: {
    checking: {
      invoke: {
        src: 'checkAvailability',
        onDone: [
          {
            guard: ({ event }) => event.output === 'unavailable',
            target: 'unavailable',
          },
          {
            guard: ({ event }) => event.output === 'available',
            target: 'ready',
          },
          {
            guard: ({ event }) => event.output === 'downloading',
            /* Already downloading (e.g. started from another tab) —
             * jump straight into the downloading state so we can
             * attach a monitor and track progress. */
            target: 'downloading',
          },
          {
            /* 'downloadable' (default) */
            target: 'downloadable',
          },
        ],
        onError: {
          target: 'error',
          actions: assign({
            error: ({ event }) => getErrorMessage(event.error),
          }),
        },
      },
    },

    unavailable: {
      type: 'final',
    },

    downloadable: {
      on: {
        DOWNLOAD: 'downloading',
      },
      /* Re-check periodically in case model becomes available
       * via chrome://flags or another tab. */
      after: {
        POLL_SLOW: 'checking',
      },
    },

    downloading: {
      entry: assign({
        progress: 0,
        extracting: false,
        error: null,
      }),
      invoke: {
        src: 'downloadModel',
      },
      on: {
        PROGRESS: {
          actions: assign({
            progress: ({ event }) => event.loaded * 100,
            /* When loaded reaches 1, Chrome still needs to extract and
             * load the model into memory — show indeterminate UI. */
            extracting: ({ event }) => event.loaded >= 1,
          }),
        },
        DOWNLOAD_COMPLETE: {
          target: 'ready',
          actions: assign({
            progress: 100,
            extracting: false,
          }),
        },
        DOWNLOAD_ERROR: {
          target: 'error',
          actions: assign({
            error: ({ event }) => event.error,
            progress: 0,
            extracting: false,
          }),
        },
      },
    },

    ready: {
      /* Poll slowly to detect model removal (storage pressure). */
      after: {
        POLL_SLOW: 'checking',
      },
    },

    error: {
      on: {
        RETRY: 'checking',
        DOWNLOAD: 'downloading',
      },
    },
  },
});
