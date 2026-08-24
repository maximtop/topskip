import {
    expect,
    type BrowserContext,
    type Page,
    type Worker,
} from '@playwright/test';

import {
    TOPSKIP_MESSAGE,
    type DevSeedDebugLogPayload,
} from '../../src/shared/messages';

/**
 * Console API levels we treat as test failures (extension should not emit
 * these).
 */
const FAIL_CONSOLE_TYPES = new Set(['error', 'assert']);

/**
 * Bounds startup checks so a broken popup fails promptly in CI.
 */
const POPUP_UI_TIMEOUT_MS = 30_000;

function isBackgroundWorker(worker: Worker): boolean {
    return worker.url().includes('background');
}

/**
 * Record `error` / failed `assert` from the MV3 service worker (extension
 * "background"). Call immediately after creating the persistent context so
 * existing workers are hooked too.
 */
export function trackServiceWorkerConsoleErrors(
    context: BrowserContext,
    errors: string[],
): void {
    const attach = (worker: Worker) => {
        if (!isBackgroundWorker(worker)) return;
        worker.on('console', (msg) => {
            if (FAIL_CONSOLE_TYPES.has(msg.type())) {
                errors.push(`[service worker] ${msg.type()}: ${msg.text()}`);
            }
        });
    };
    context.on('serviceworker', attach);
    for (const w of context.serviceWorkers()) {
        attach(w);
    }
}

/**
 * Record `error` / failed `assert` from `console` and uncaught exceptions on a
 * normal Page (popup, fixture tab, etc.).
 */
export function trackPageErrors(
    page: Page,
    label: string,
    errors: string[],
): void {
    page.on('console', (msg) => {
        if (FAIL_CONSOLE_TYPES.has(msg.type())) {
            errors.push(`[${label}] ${msg.type()}: ${msg.text()}`);
        }
    });
    page.on('pageerror', (err) => {
        errors.push(`[${label}] pageerror: ${err.message}`);
    });
}

/**
 * Waits for the popup shell and fails immediately when React renders its
 * ErrorBoundary fallback instead.
 *
 * @param popupPage - Popup page whose initial render should settle.
 * @returns Promise resolving when the healthy popup UI is visible.
 */
export async function waitForPopupUi(popupPage: Page): Promise<void> {
    const popupShell = popupPage.getByTestId('popup-shell');
    const errorAlert = popupPage
        .getByRole('alert')
        .filter({ hasText: 'Something went wrong' });

    await expect(popupShell.or(errorAlert)).toBeVisible({
        timeout: POPUP_UI_TIMEOUT_MS,
    });
    if (await errorAlert.isVisible()) {
        const fallbackText = (await errorAlert.innerText()).trim();
        throw new Error(`Popup ErrorBoundary rendered: ${fallbackText}`);
    }

    await popupPage
        .getByRole('switch', { name: /enable/i })
        .waitFor({ state: 'visible', timeout: POPUP_UI_TIMEOUT_MS });
}

export async function openPopupAndWaitForUi(
    context: BrowserContext,
    extensionId: string,
    errors: string[],
    owningTab?: Page,
): Promise<Page> {
    const popupPage = await context.newPage();
    trackPageErrors(popupPage, 'popup', errors);
    if (owningTab !== undefined) {
        // A direct popup URL is a normal Playwright tab, unlike Chrome's
        // toolbar popup. Restore the tab whose detection state Chrome should
        // expose before popup startup sends GET_DETECTION_STATUS.
        await owningTab.bringToFront();
    }
    await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, {
        waitUntil: 'domcontentloaded',
    });
    await waitForPopupUi(popupPage);
    return popupPage;
}

export function expectNoCollectedErrors(errors: string[]): void {
    const msg = `Unexpected console/page errors:\n${errors.join('\n')}`;
    expect(errors, msg).toEqual([]);
}

/**
 * Bounds the wait for the MV3 background worker to register.
 */
const BACKGROUND_WORKER_TIMEOUT_MS = 30_000;

/**
 * Bounds Options-page startup checks the same way as the popup ones.
 */
const OPTIONS_UI_TIMEOUT_MS = 30_000;

/**
 * Page global the clipboard stub writes the last `writeText` payload into.
 */
const CLIPBOARD_CAPTURE_KEY = '__topskipE2eClipboardText';

/**
 * English sidebar label of the Options Diagnostics section.
 */
const DIAGNOSTICS_SECTION_LABEL = 'Diagnostics';

/**
 * Deep link that opens Options directly on the Diagnostics section.
 */
const OPTIONS_DIAGNOSTICS_HASH = '#diagnostics';

/**
 * Worker global the recording `chrome.tabs.create` writes the last URL into.
 */
const ISSUE_TAB_CAPTURE_KEY = '__topskipE2eIssueTabUrl';

/**
 * Worker global marking the `chrome.tabs.create` recorder as installed, so a
 * second capture reuses the first recorder instead of stacking another (the
 * polyfill caches the wrapped method it saw first).
 */
const ISSUE_TAB_CAPTURE_INSTALLED_KEY = '__topskipE2eIssueTabCaptureInstalled';

/**
 * How a stubbed `navigator.clipboard.writeText` should behave.
 */
export type ClipboardCaptureMode = 'capture' | 'reject';

/**
 * Resolves the MV3 background worker, waiting for it when the context is
 * still starting up.
 *
 * @param context - Persistent context hosting the unpacked extension.
 * @returns The extension's background service worker.
 */
export async function getBackgroundWorker(
    context: BrowserContext,
): Promise<Worker> {
    const existing = context.serviceWorkers().find(isBackgroundWorker);
    if (existing !== undefined) {
        return existing;
    }
    return context.waitForEvent('serviceworker', {
        predicate: isBackgroundWorker,
        timeout: BACKGROUND_WORKER_TIMEOUT_MS,
    });
}

/**
 * Sends one runtime message from an extension document and resolves with the
 * background's reply, rejecting on `runtime.lastError`.
 *
 * @param extensionPage - Popup or options page with extension API access.
 * @param message - Serializable runtime message.
 * @returns The background's reply as received.
 */
export async function sendExtensionRuntimeMessage(
    extensionPage: Page,
    message: Record<string, unknown>,
): Promise<unknown> {
    return extensionPage.evaluate(async (message) => {
        const chromeApi = Reflect.get(globalThis, 'chrome');
        if (typeof chromeApi !== 'object' || chromeApi === null) {
            throw new Error('Missing chrome API');
        }
        const runtime = Reflect.get(chromeApi, 'runtime');
        if (typeof runtime !== 'object' || runtime === null) {
            throw new Error('Missing chrome.runtime API');
        }
        const sendMessage = Reflect.get(runtime, 'sendMessage');
        if (typeof sendMessage !== 'function') {
            throw new Error('Missing chrome.runtime.sendMessage API');
        }
        return new Promise<unknown>((resolve, reject) => {
            Reflect.apply(sendMessage, runtime, [
                message,
                (result: unknown) => {
                    const lastError = Reflect.get(runtime, 'lastError');
                    if (typeof lastError === 'object' && lastError !== null) {
                        reject(
                            new Error(
                                String(
                                    Reflect.get(lastError, 'message') ??
                                        'runtime.sendMessage failed',
                                ),
                            ),
                        );
                        return;
                    }
                    resolve(result);
                },
            ]);
        });
    }, message);
}

/**
 * Opens Options on the Diagnostics deep link and waits for the section.
 *
 * @param context - Persistent context hosting the unpacked extension.
 * @param extensionId - Extension id derived from the worker URL.
 * @param errors - Collector for console/page errors.
 * @param prepare - Optional hook run before navigation, for init scripts.
 * @returns The Options page showing the Diagnostics section.
 */
export async function openOptionsDiagnostics(
    context: BrowserContext,
    extensionId: string,
    errors: string[],
    prepare?: (page: Page) => Promise<void>,
): Promise<Page> {
    const page = await context.newPage();
    trackPageErrors(page, 'options-diagnostics', errors);
    if (prepare !== undefined) {
        await prepare(page);
    }
    await page.goto(
        `chrome-extension://${extensionId}/options.html${OPTIONS_DIAGNOSTICS_HASH}`,
        { waitUntil: 'domcontentloaded' },
    );
    await page
        .getByTestId('options-diagnostics-section')
        .waitFor({ state: 'visible', timeout: OPTIONS_UI_TIMEOUT_MS });
    await expect(
        page.getByRole('button', { name: DIAGNOSTICS_SECTION_LABEL }),
    ).toHaveAttribute('aria-current', 'page');
    return page;
}

/**
 * Replaces `navigator.clipboard.writeText` before the page loads so Copy log
 * can be observed (or refused) without real clipboard permissions, which
 * Playwright cannot grant reliably on `chrome-extension://` origins.
 *
 * @param page - Page before its extension URL is loaded.
 * @param mode - Capture the text or reject like a denied permission.
 * @returns Promise resolving once the init script is registered.
 */
export async function installClipboardCapture(
    page: Page,
    mode: ClipboardCaptureMode,
): Promise<void> {
    await page.addInitScript(
        ({ key, mode }) => {
            const writeText = (text: string): Promise<void> => {
                if (mode === 'reject') {
                    return Promise.reject(
                        new DOMException(
                            'Write permission denied.',
                            'NotAllowedError',
                        ),
                    );
                }
                Reflect.set(globalThis, key, text);
                return Promise.resolve();
            };
            Object.defineProperty(navigator, 'clipboard', {
                configurable: true,
                value: { writeText },
            });
        },
        { key: CLIPBOARD_CAPTURE_KEY, mode },
    );
}

/**
 * Reads the last text the stubbed clipboard received.
 *
 * @param page - Page prepared with `installClipboardCapture`.
 * @returns The captured text, or `null` when nothing was written.
 */
export async function readCapturedClipboardText(
    page: Page,
): Promise<string | null> {
    const text: unknown = await page.evaluate(
        // Reflect.get returns `any`; surface it as `unknown` for the caller.
        (key): unknown => Reflect.get(globalThis, key),
        CLIPBOARD_CAPTURE_KEY,
    );
    return typeof text === 'string' ? text : null;
}

/**
 * Forgets the captured clipboard text so the next Copy click is observable on
 * its own.
 *
 * @param page - Page prepared with `installClipboardCapture`.
 * @returns Promise resolving once the page global is cleared.
 */
export async function clearCapturedClipboardText(page: Page): Promise<void> {
    await page.evaluate(
        (key) => Reflect.deleteProperty(globalThis, key),
        CLIPBOARD_CAPTURE_KEY,
    );
}

/**
 * Installs a debug-log store state through the dev-only seeding message
 * (refused outside dev builds, so this only works on the E2E artifact).
 *
 * @param extensionPage - Extension page allowed to call the runtime API.
 * @param payload - Store state to install.
 * @returns Promise resolving once the background acknowledged the seed.
 */
export async function seedDebugLog(
    extensionPage: Page,
    payload: DevSeedDebugLogPayload,
): Promise<void> {
    const response = await sendExtensionRuntimeMessage(extensionPage, {
        type: TOPSKIP_MESSAGE.DEV_SEED_DEBUG_LOG,
        payload,
    });
    if (
        typeof response !== 'object' ||
        response === null ||
        Reflect.get(response, 'ok') !== true
    ) {
        throw new Error(
            `Failed to seed the debug log: ${JSON.stringify(response)}`,
        );
    }
}

/**
 * Measures the persisted debug-log footprint inside the worker the way Chrome
 * accounts quota (UTF-8 bytes of the JSON value plus the key).
 *
 * @param context - Persistent context hosting the unpacked extension.
 * @param keyPrefix - `storage.local` key prefix owned by the debug log.
 * @returns Total persisted bytes under the prefix.
 */
export async function readDebugLogStorageBytes(
    context: BrowserContext,
    keyPrefix: string,
): Promise<number> {
    const worker = await getBackgroundWorker(context);
    return worker.evaluate(async (prefix) => {
        const chromeApi = Reflect.get(globalThis, 'chrome');
        if (typeof chromeApi !== 'object' || chromeApi === null) {
            throw new Error('Missing chrome API');
        }
        const storage = Reflect.get(chromeApi, 'storage');
        const local =
            typeof storage === 'object' && storage !== null
                ? Reflect.get(storage, 'local')
                : undefined;
        if (typeof local !== 'object' || local === null) {
            throw new Error('Missing chrome.storage.local API');
        }
        const get = Reflect.get(local, 'get');
        if (typeof get !== 'function') {
            throw new Error('Missing chrome.storage.local.get API');
        }
        // Mirror readGrantedExtensionPermissions: keep `any` out of `await`.
        const pendingSnapshot: unknown = Reflect.apply(get, local, [null]);
        const all: unknown = await Promise.resolve(pendingSnapshot);
        if (typeof all !== 'object' || all === null) {
            throw new Error('Missing storage snapshot');
        }
        const encoder = new TextEncoder();
        let bytes = 0;
        for (const [key, value] of Object.entries(all)) {
            if (!key.startsWith(prefix)) {
                continue;
            }
            bytes +=
                encoder.encode(JSON.stringify(value)).byteLength +
                encoder.encode(key).byteLength;
        }
        return bytes;
    }, keyPrefix);
}

/**
 * Clicks the popup's report button and returns the GitHub URL the background
 * opened. The worker's `chrome.tabs.create` is replaced with a recorder, so
 * the URL is captured verbatim and no tab (or network request) is created —
 * `context.route` stubs cannot intercept an extension-opened tab's first
 * navigation, which let real github.com redirect the page-based capture to
 * its login screen before any URL committed.
 *
 * @param context - Persistent context hosting the unpacked extension.
 * @param popupPage - Popup showing a reportable server failure.
 * @param owningTab - Tab whose detection state the popup shows; it must be the
 *   active tab when the background resolves the report.
 * @returns The full issue URL including the prefilled query.
 */
export async function captureIssueReportUrl(
    context: BrowserContext,
    popupPage: Page,
    owningTab: Page,
): Promise<string> {
    const worker = await getBackgroundWorker(context);
    await worker.evaluate(
        ({ captureKey, installedKey }) => {
            Reflect.deleteProperty(globalThis, captureKey);
            if (Reflect.get(globalThis, installedKey) === true) {
                return;
            }
            const chromeApi = Reflect.get(globalThis, 'chrome');
            if (typeof chromeApi !== 'object' || chromeApi === null) {
                throw new Error('Missing chrome API');
            }
            const tabs = Reflect.get(chromeApi, 'tabs');
            if (typeof tabs !== 'object' || tabs === null) {
                throw new Error('Missing chrome.tabs API');
            }
            const recordingCreate = (
                createProperties: unknown,
                callback: unknown,
            ): void => {
                // Reflect.get returns `any`; surface it as `unknown`.
                const url: unknown =
                    typeof createProperties === 'object' &&
                    createProperties !== null
                        ? Reflect.get(createProperties, 'url')
                        : undefined;
                Reflect.set(globalThis, captureKey, url);
                if (typeof callback === 'function') {
                    // Chrome invokes the callback asynchronously; mirror that
                    // so the polyfill resolves its promise off this stack.
                    setTimeout(() => {
                        Reflect.apply(callback, undefined, [{ id: -1 }]);
                    }, 0);
                }
            };
            if (!Reflect.set(tabs, 'create', recordingCreate)) {
                throw new Error('Could not record chrome.tabs.create');
            }
            Reflect.set(globalThis, installedKey, true);
        },
        {
            captureKey: ISSUE_TAB_CAPTURE_KEY,
            installedKey: ISSUE_TAB_CAPTURE_INSTALLED_KEY,
        },
    );
    await owningTab.bringToFront();
    await popupPage.getByTestId('popup-report-server-issue').click();
    await expect
        .poll(
            () =>
                worker.evaluate(
                    // Reflect.get returns `any`; surface it as `unknown`.
                    (key): unknown => Reflect.get(globalThis, key),
                    ISSUE_TAB_CAPTURE_KEY,
                ),
            { timeout: OPTIONS_UI_TIMEOUT_MS },
        )
        .not.toBeUndefined();
    const url: unknown = await worker.evaluate(
        // Reflect.get returns `any`; surface it as `unknown`.
        (key): unknown => Reflect.get(globalThis, key),
        ISSUE_TAB_CAPTURE_KEY,
    );
    if (typeof url !== 'string') {
        throw new Error('Issue report opened no URL.');
    }
    return url;
}
