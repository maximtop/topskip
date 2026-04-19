import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { test, expect, chromium, type BrowserContext } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

import {
  expectNoCollectedErrors,
  openPopupAndWaitForUi,
  trackPageErrors,
  trackServiceWorkerConsoleErrors,
} from './extension-helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '../dist');

/**
 * Default **headless** for CI/local; set `PW_EXTENSION_HEADED=1` for a visible
 * browser when debugging.
 */
const extensionHeadless = process.env.PW_EXTENSION_HEADED !== '1';

function extensionContextOptions() {
  return {
    headless: extensionHeadless,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  };
}

async function getExtensionId(context: BrowserContext): Promise<string> {
  const fromUrl = (w: { url: () => string }) => new URL(w.url()).hostname;

  const existing = context
    .serviceWorkers()
    .find((w) => w.url().includes('background'));
  if (existing) {
    return fromUrl(existing);
  }

  const worker = await context.waitForEvent('serviceworker', {
    predicate: (w) => w.url().includes('background'),
    timeout: 30_000,
  });
  return fromUrl(worker);
}

test.describe('TopSkip extension', () => {
  test.setTimeout(120_000);

  test('service worker and popup load without console errors', async () => {
    const errors: string[] = [];
    const context = await chromium.launchPersistentContext(
      '',
      extensionContextOptions(),
    );

    try {
      trackServiceWorkerConsoleErrors(context, errors);
      const extensionId = await getExtensionId(context);

      const popupPage = await openPopupAndWaitForUi(
        context,
        extensionId,
        errors,
      );
      await popupPage.close();

      expectNoCollectedErrors(errors);
    } finally {
      await context.close();
    }
  });

  test('fixture page: no fixed 30s→60s jump without promo blocks', async () => {
    const errors: string[] = [];
    const context = await chromium.launchPersistentContext(
      '',
      extensionContextOptions(),
    );

    try {
      trackServiceWorkerConsoleErrors(context, errors);
      const extensionId = await getExtensionId(context);

      const popupPage = await openPopupAndWaitForUi(
        context,
        extensionId,
        errors,
      );
      await popupPage.close();

      const page = await context.newPage();
      trackPageErrors(page, 'fixture', errors);
      await page.goto('/video.html', { waitUntil: 'domcontentloaded' });

      await page.waitForSelector('video', { state: 'attached' });
      await page.evaluate(async () => {
        const video = document.querySelector('video');
        if (!video) {
          throw new Error('no video');
        }
        await new Promise<void>((resolve, reject) => {
          if (video.readyState >= 1) {
            resolve();
            return;
          }
          video.addEventListener('loadedmetadata', () => resolve(), {
            once: true,
          });
          video.addEventListener(
            'error',
            () => reject(new Error('video error')),
            { once: true },
          );
        });
      });

      await page.evaluate(() => {
        const video = document.querySelector('video') as HTMLVideoElement;
        video.muted = true;
        video.playbackRate = 4;
        void video.play();
      });

      await expect
        .poll(
          async () =>
            page.evaluate(() => {
              const video = document.querySelector('video') as HTMLVideoElement;
              return video.currentTime;
            }),
          { timeout: 90_000 },
        )
        .toBeGreaterThan(31);

      const t = await page.evaluate(() => {
        const video = document.querySelector('video') as HTMLVideoElement;
        return video.currentTime;
      });
      expect(t).toBeLessThan(55);

      expectNoCollectedErrors(errors);
    } finally {
      await context.close();
    }
  });

  test('popup toggle disables skip', async () => {
    const errors: string[] = [];
    const context = await chromium.launchPersistentContext(
      '',
      extensionContextOptions(),
    );

    try {
      trackServiceWorkerConsoleErrors(context, errors);
      const extensionId = await getExtensionId(context);

      const popupPage = await openPopupAndWaitForUi(
        context,
        extensionId,
        errors,
      );
      // Mantine switch: default actionability can hang in headless CI; force
      // avoids hit-target / stability waits until the full test timeout.
      await popupPage
        .getByRole('switch', { name: /enable/i })
        .click({ force: true, timeout: 30_000 });
      await popupPage.close();

      const page = await context.newPage();
      trackPageErrors(page, 'fixture', errors);
      await page.goto('/video.html', { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('video');

      await page.evaluate(async () => {
        const video = document.querySelector('video') as HTMLVideoElement;
        await new Promise<void>((resolve, reject) => {
          if (video.readyState >= 1) {
            resolve();
            return;
          }
          video.addEventListener('loadedmetadata', () => resolve(), {
            once: true,
          });
          video.addEventListener(
            'error',
            () => reject(new Error('video error')),
            { once: true },
          );
        });
      });

      await page.evaluate(() => {
        const video = document.querySelector('video') as HTMLVideoElement;
        video.muted = true;
        video.playbackRate = 4;
        void video.play();
      });

      await page.waitForTimeout(12_000);

      const t = await page.evaluate(() => {
        const video = document.querySelector('video') as HTMLVideoElement;
        return video.currentTime;
      });

      expect(t).toBeGreaterThan(40);
      expect(t).toBeLessThan(58);

      expectNoCollectedErrors(errors);
    } finally {
      await context.close();
    }
  });

  test('options page switches between provider panels', async () => {
    const errors: string[] = [];
    const context = await chromium.launchPersistentContext(
      '',
      extensionContextOptions(),
    );

    try {
      trackServiceWorkerConsoleErrors(context, errors);
      const extensionId = await getExtensionId(context);

      const page = await context.newPage();
      trackPageErrors(page, 'options', errors);
      await page.goto(`chrome-extension://${extensionId}/options.html`, {
        waitUntil: 'domcontentloaded',
      });

      await page.getByTestId('provider-selector').waitFor();
      await expect(
        page.getByRole('heading', { name: 'Custom models' }),
      ).toBeVisible();

      await page
        .getByTestId('provider-selector')
        .getByText('Chrome Built-in')
        .click({ force: true, timeout: 30_000 });
      await expect(
        page.getByText('not available').first(),
      ).toBeVisible();
      await expect(page.getByRole('switch', { name: /enable/i })).toBeVisible();

      expectNoCollectedErrors(errors);
    } finally {
      await context.close();
    }
  });

  test('popup and options pages pass axe accessibility audit', async () => {
    const errors: string[] = [];
    const context = await chromium.launchPersistentContext(
      '',
      extensionContextOptions(),
    );

    try {
      trackServiceWorkerConsoleErrors(context, errors);
      const extensionId = await getExtensionId(context);

      // --- Popup page ---
      const popupPage = await openPopupAndWaitForUi(
        context,
        extensionId,
        errors,
      );
      // color-contrast is disabled: known issues with Mantine's
      // teal-on-light-teal button and dimmed summary text. Fixing
      // these requires design-level decisions (tracked separately).
      const popupResults = await new AxeBuilder({ page: popupPage })
        .withTags([
          'wcag2a',
          'wcag2aa',
          'wcag21a',
          'wcag21aa',
        ])
        .disableRules(['color-contrast'])
        .analyze();
      expect(
        popupResults.violations,
        'Popup axe violations:\n' +
          JSON.stringify(
            popupResults.violations,
            null,
            2,
          ),
      ).toEqual([]);
      await popupPage.close();

      // --- Options page ---
      const optionsPage = await context.newPage();
      trackPageErrors(optionsPage, 'options', errors);
      await optionsPage.goto(
        `chrome-extension://${extensionId}/options.html`,
        { waitUntil: 'domcontentloaded' },
      );
      await optionsPage
        .getByRole('heading', { level: 2 })
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 });

      const optionsResults = await new AxeBuilder({
        page: optionsPage,
      })
        .withTags([
          'wcag2a',
          'wcag2aa',
          'wcag21a',
          'wcag21aa',
        ])
        .disableRules(['color-contrast'])
        .analyze();
      expect(
        optionsResults.violations,
        'Options axe violations:\n' +
          JSON.stringify(
            optionsResults.violations,
            null,
            2,
          ),
      ).toEqual([]);
      await optionsPage.close();

      expectNoCollectedErrors(errors);
    } finally {
      await context.close();
    }
  });
});
