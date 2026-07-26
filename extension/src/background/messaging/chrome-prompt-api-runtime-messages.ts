import { LOG_PREFIX_TOPSKIP, PERCENT_SCALE } from '@/shared/constants';
import {
    DOWNLOAD_PROGRESS_EVENT,
    LANGUAGE_MODEL_GLOBAL,
    LANGUAGE_MODEL_METHOD,
    PROVIDER_AVAILABILITY,
} from '@/shared/chrome-prompt-api';
import { getErrorMessage } from '@/shared/error';
import {
    type GetChromePromptApiStatusResponse,
    type ProviderAvailabilityMessage,
    type TriggerChromeModelDownloadResponse,
} from '@/shared/messages';

/**
 * Log sub-prefix for this bundle's Chrome Built-in messaging.
 */
const CHROME_BUILTIN_LOG = 'Chrome Built-in:';

/**
 * User-facing error string when the LanguageModel global is absent.
 */
const UNAVAILABLE_ERROR = 'Chrome Built-in AI is not available';

/**
 * Divisor used to round download progress to 1 decimal place.
 */
const PROGRESS_ROUND_FACTOR = 10;

/**
 * Look-up table mapping raw Prompt API availability strings to the canonical
 * `ProviderAvailabilityMessage`. Falls back to unavailable when the runtime
 * emits an unexpected value.
 */
const AVAILABILITY_MAP: Readonly<Record<string, ProviderAvailabilityMessage>> =
    Object.freeze({
        [PROVIDER_AVAILABILITY.AVAILABLE]: PROVIDER_AVAILABILITY.AVAILABLE,
        [PROVIDER_AVAILABILITY.DOWNLOADABLE]:
            PROVIDER_AVAILABILITY.DOWNLOADABLE,
        [PROVIDER_AVAILABILITY.DOWNLOADING]: PROVIDER_AVAILABILITY.DOWNLOADING,
        [PROVIDER_AVAILABILITY.UNAVAILABLE]: PROVIDER_AVAILABILITY.UNAVAILABLE,
    });

/**
 * Resolves the current `LanguageModel.availability()` as a
 * `ProviderAvailabilityMessage` string. Returns `'unavailable'` when the
 * global API is absent.
 *
 * @returns Current availability mapping.
 */
async function resolveAvailability(): Promise<ProviderAvailabilityMessage> {
    const lm: unknown = Reflect.get(globalThis, LANGUAGE_MODEL_GLOBAL);
    if (!lm || (typeof lm !== 'object' && typeof lm !== 'function')) {
        console.info(
            `${LOG_PREFIX_TOPSKIP} ${CHROME_BUILTIN_LOG} ${LANGUAGE_MODEL_GLOBAL}` +
                ' global not found — requires Chrome 138+ with Prompt API enabled',
        );
        return PROVIDER_AVAILABILITY.UNAVAILABLE;
    }
    const availFn: unknown = Reflect.get(
        lm,
        LANGUAGE_MODEL_METHOD.AVAILABILITY,
    );
    if (typeof availFn !== 'function') {
        console.info(
            `${LOG_PREFIX_TOPSKIP} ${CHROME_BUILTIN_LOG}` +
                ` ${LANGUAGE_MODEL_GLOBAL}.${LANGUAGE_MODEL_METHOD.AVAILABILITY} is` +
                ' not a function',
        );
        return PROVIDER_AVAILABILITY.UNAVAILABLE;
    }
    const raw: unknown = await (availFn as () => Promise<unknown>).call(lm);
    const mapped: ProviderAvailabilityMessage =
        typeof raw === 'string' && raw in AVAILABILITY_MAP
            ? AVAILABILITY_MAP[raw]
            : PROVIDER_AVAILABILITY.UNAVAILABLE;
    console.info(
        `${LOG_PREFIX_TOPSKIP} ${CHROME_BUILTIN_LOG}` +
            ` ${LANGUAGE_MODEL_GLOBAL}.${LANGUAGE_MODEL_METHOD.AVAILABILITY}() →`,
        raw,
        '→',
        mapped,
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
    /**
     * Percentage 0–100 of the most recent download, or `null` if idle.
     */
    private static downloadProgress: number | null = null;

    /**
     * Returns the current availability state and in-flight download progress.
     *
     * @returns Status response with availability and download progress.
     */
    static async handleGetStatus(): Promise<GetChromePromptApiStatusResponse> {
        try {
            const availability = await resolveAvailability();
            return {
                ok: true,
                availability,
                downloadProgress:
                    ChromePromptApiRuntimeMessages.downloadProgress,
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
    static handleTriggerDownload(): TriggerChromeModelDownloadResponse {
        const lm: unknown = Reflect.get(globalThis, LANGUAGE_MODEL_GLOBAL);
        if (!lm || (typeof lm !== 'object' && typeof lm !== 'function')) {
            return { ok: false, error: UNAVAILABLE_ERROR };
        }
        const createFn: unknown = Reflect.get(lm, LANGUAGE_MODEL_METHOD.CREATE);
        if (typeof createFn !== 'function') {
            return { ok: false, error: UNAVAILABLE_ERROR };
        }

        ChromePromptApiRuntimeMessages.downloadProgress = 0;
        console.info(
            `${LOG_PREFIX_TOPSKIP} ${CHROME_BUILTIN_LOG}` +
                ` triggering model download via ${LANGUAGE_MODEL_GLOBAL}.` +
                `${LANGUAGE_MODEL_METHOD.CREATE}()`,
        );

        // Fire-and-forget: start download, track progress, clean up when done.
        void (
            createFn as (opts: {
                monitor?: (m: unknown) => void;
            }) => Promise<{ destroy: () => void }>
        )
            .call(lm, {
                monitor(m: unknown) {
                    if (m && typeof m === 'object' && 'addEventListener' in m) {
                        const monitor = m as {
                            addEventListener: (
                                name: string,
                                cb: (ev: {
                                    loaded: number;
                                    total: number;
                                }) => void,
                            ) => void;
                        };
                        monitor.addEventListener(
                            DOWNLOAD_PROGRESS_EVENT,
                            (ev: { loaded: number; total: number }) => {
                                // `loaded` is a 0–1 fraction; `total` is always 1.
                                const pct =
                                    ev.total > 0
                                        ? (ev.loaded / ev.total) * PERCENT_SCALE
                                        : ev.loaded * PERCENT_SCALE;
                                ChromePromptApiRuntimeMessages.downloadProgress =
                                    Math.round(pct * PROGRESS_ROUND_FACTOR) /
                                    PROGRESS_ROUND_FACTOR;
                            },
                        );
                    }
                },
            })
            .then((session) => {
                session.destroy();
                console.info(
                    `${LOG_PREFIX_TOPSKIP} ${CHROME_BUILTIN_LOG}`,
                    'model download/create completed',
                );
                ChromePromptApiRuntimeMessages.downloadProgress = null;
            })
            .catch((e: unknown) => {
                console.warn(
                    `${LOG_PREFIX_TOPSKIP} ${CHROME_BUILTIN_LOG}`,
                    'model download failed:',
                    getErrorMessage(e),
                );
                ChromePromptApiRuntimeMessages.downloadProgress = null;
            });

        return { ok: true };
    }
}
