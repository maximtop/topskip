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
  await popupPage
    .getByRole('switch', { name: /enable/i })
    .waitFor({ state: 'visible' });
  return popupPage;
}

export function expectNoCollectedErrors(errors: string[]): void {
  const msg = `Unexpected console/page errors:\n${errors.join('\n')}`;
  expect(errors, msg).toEqual([]);
}
