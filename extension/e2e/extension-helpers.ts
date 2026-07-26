import {
    expect,
    type BrowserContext,
    type Page,
    type Worker,
} from '@playwright/test';

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
): Promise<Page> {
    const popupPage = await context.newPage();
    trackPageErrors(popupPage, 'popup', errors);
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
