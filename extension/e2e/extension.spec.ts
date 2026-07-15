import path from 'node:path';
import {
    createServer,
    type IncomingMessage,
    type ServerResponse,
} from 'node:http';
import { fileURLToPath } from 'node:url';

import {
    test,
    expect,
    chromium,
    type BrowserContext,
    type Page,
} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

import {
    SERVER_ANALYSIS_SUPPORTED_CAPABILITIES,
    TOPSKIP_CAPABILITIES_HEADER_NAME,
} from '@topskip/common/server-analysis-contract';

import {
    expectNoCollectedErrors,
    openPopupAndWaitForUi,
    trackPageErrors,
    trackServiceWorkerConsoleErrors,
} from './extension-helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '../dist');
const E2E_SERVER_ALGORITHM_VERSION = 'server-v4';
const E2E_INSTALLATION_TOKEN =
    'e2e-installation-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const E2E_INSTALLATION_EXPIRES_AT_MS = 4_102_444_800_000;
const E2E_CAPABILITIES_HEADER =
    SERVER_ANALYSIS_SUPPORTED_CAPABILITIES.join(',');

/**
 * Serves the public bootstrap endpoints shared by every server-mode fixture.
 *
 * @param req - Fixture backend request.
 * @param res - Fixture backend response.
 * @returns Whether the request was fully handled.
 */
function handlePublicApiBootstrap(
    req: IncomingMessage,
    res: ServerResponse,
): boolean {
    if (req.method === 'OPTIONS') {
        const origin = req.headers.origin;
        if (typeof origin === 'string') {
            res.setHeader('access-control-allow-origin', origin);
        }
        res.writeHead(204, {
            'access-control-allow-methods': 'GET, POST, OPTIONS',
            'access-control-allow-headers':
                'Authorization, Content-Type, X-TopSkip-Capabilities',
        });
        res.end();
        return true;
    }

    if (req.method === 'GET' && req.url === '/v1/config') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
            JSON.stringify({
                apiVersion: 'v1',
                algorithmVersion: E2E_SERVER_ALGORITHM_VERSION,
                supportedCapabilities: [
                    ...SERVER_ANALYSIS_SUPPORTED_CAPABILITIES,
                ],
                supportIssueBaseUrl:
                    'https://github.com/maximtop/topskip/issues/new',
            }),
        );
        return true;
    }

    if (req.method === 'POST' && req.url === '/v1/installations/register') {
        expect(
            req.headers[TOPSKIP_CAPABILITIES_HEADER_NAME.toLowerCase()],
        ).toBe(E2E_CAPABILITIES_HEADER);
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(
            JSON.stringify({
                status: 'registered',
                token: E2E_INSTALLATION_TOKEN,
                expiresAtMs: E2E_INSTALLATION_EXPIRES_AT_MS,
            }),
        );
        return true;
    }

    return false;
}

/**
 * Verifies that analysis traffic uses the background-owned installation.
 *
 * @param req - Fixture backend request.
 */
function expectAuthenticatedServerRequest(req: IncomingMessage): void {
    expect(req.headers.authorization).toBe(`Bearer ${E2E_INSTALLATION_TOKEN}`);
    expect(req.headers[TOPSKIP_CAPABILITIES_HEADER_NAME.toLowerCase()]).toBe(
        E2E_CAPABILITIES_HEADER,
    );
}

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

/**
 * Seeds detected promo blocks through a dev-only background message.
 *
 * @param popupPage - Open extension popup page.
 */
async function seedDetectedPopupState(popupPage: Page): Promise<void> {
    await popupPage.evaluate(async () => {
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

        const message = {
            type: 'TOPSKIP_DEV_SET_DETECTION_STATUS',
            state: {
                videoId: 'visual-fixture',
                status: 'detected',
                durationSec: 600,
                promoBlocks: [
                    { startSec: 92, endSec: 125 },
                    { startSec: 490, endSec: 522 },
                ],
            },
        };
        const response: unknown = await new Promise((resolve, reject) => {
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

        if (
            typeof response !== 'object' ||
            response === null ||
            Reflect.get(response, 'ok') !== true
        ) {
            throw new Error('Failed to seed detected popup state');
        }
    });
}

/**
 * Seeds a ready server result through extension storage for no-network e2e.
 *
 * @param popupPage - Open extension popup page.
 */
async function seedFreshLocalServerCache(popupPage: Page): Promise<void> {
    await popupPage.evaluate(async () => {
        const chromeApi = Reflect.get(globalThis, 'chrome');
        if (typeof chromeApi !== 'object' || chromeApi === null) {
            throw new Error('Missing chrome API');
        }
        const storage = Reflect.get(chromeApi, 'storage');
        if (typeof storage !== 'object' || storage === null) {
            throw new Error('Missing chrome.storage API');
        }
        const local = Reflect.get(storage, 'local');
        if (typeof local !== 'object' || local === null) {
            throw new Error('Missing chrome.storage.local API');
        }
        const set = Reflect.get(local, 'set');
        if (typeof set !== 'function') {
            throw new Error('Missing chrome.storage.local.set API');
        }

        const key = 'topskip:server-result-cache:server-v4:e2eFixture1';
        await new Promise<void>((resolve, reject) => {
            Reflect.apply(set, local, [
                {
                    [key]: {
                        videoId: 'e2eFixture1',
                        algorithmVersion: 'server-v4',
                        sourceResultId: 'result-e2eFixture1-server-v4',
                        freshness: { expiresAtMs: 4_102_444_800_000 },
                        promoBlocks: [
                            { startSec: 4, endSec: 24, confidence: 'high' },
                        ],
                        storedAtMs: 1_900_000_000_000,
                    },
                },
                () => {
                    const runtime = Reflect.get(chromeApi, 'runtime');
                    const lastError =
                        typeof runtime === 'object' && runtime !== null
                            ? Reflect.get(runtime, 'lastError')
                            : undefined;
                    if (typeof lastError === 'object' && lastError !== null) {
                        reject(
                            new Error(
                                String(Reflect.get(lastError, 'message')),
                            ),
                        );
                        return;
                    }
                    resolve();
                },
            ]);
        });
    });
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
                const video = document.querySelector(
                    'video',
                ) as HTMLVideoElement;
                video.muted = true;
                video.playbackRate = 4;
                void video.play();
            });

            await expect
                .poll(
                    async () =>
                        page.evaluate(() => {
                            const video = document.querySelector(
                                'video',
                            ) as HTMLVideoElement;
                            return video.currentTime;
                        }),
                    { timeout: 90_000 },
                )
                .toBeGreaterThan(31);

            const t = await page.evaluate(() => {
                const video = document.querySelector(
                    'video',
                ) as HTMLVideoElement;
                return video.currentTime;
            });
            expect(t).toBeLessThan(55);

            expectNoCollectedErrors(errors);
        } finally {
            await context.close();
        }
    });

    test('server mode reports pending analysis from local backend', async () => {
        const jobId = 'local-e2eFixture1-server-v4';
        const processingResponse = {
            status: 'processing',
            videoId: 'e2eFixture1',
            algorithmVersion: 'server-v4',
            jobId,
            pollAfterSec: 3,
        };
        let resolveRequestSeen: () => void = () => {};
        const requestSeen = new Promise<void>((resolve) => {
            resolveRequestSeen = resolve;
        });
        const backend = createServer((req, res) => {
            if (handlePublicApiBootstrap(req, res)) {
                return;
            }
            if (
                req.method === 'GET' &&
                req.url === `/v1/analysis/jobs/${jobId}`
            ) {
                expectAuthenticatedServerRequest(req);
                res.writeHead(202, { 'content-type': 'application/json' });
                res.end(JSON.stringify(processingResponse));
                return;
            }
            if (req.method !== 'POST' || req.url !== '/v1/analysis') {
                res.writeHead(404);
                res.end();
                return;
            }
            expectAuthenticatedServerRequest(req);
            let body = '';
            req.setEncoding('utf8');
            req.on('data', (chunk) => {
                body = body + chunk;
            });
            req.on('end', () => {
                expect(JSON.parse(body)).toMatchObject({
                    videoId: 'e2eFixture1',
                    extensionVersion: '0.1.0',
                    client: {
                        source: 'chrome-extension',
                        capabilities: [
                            ...SERVER_ANALYSIS_SUPPORTED_CAPABILITIES,
                        ],
                    },
                });
                expect(JSON.parse(body)).not.toHaveProperty('algorithmVersion');
                expect(body).not.toContain('transcript');
                res.writeHead(202, { 'content-type': 'application/json' });
                res.end(JSON.stringify(processingResponse));
                resolveRequestSeen();
            });
        });
        await new Promise<void>((resolve) => {
            backend.listen(8787, '127.0.0.1', () => resolve());
        });

        const errors: string[] = [];
        const context = await chromium.launchPersistentContext(
            '',
            extensionContextOptions(),
        );

        try {
            trackServiceWorkerConsoleErrors(context, errors);
            const extensionId = await getExtensionId(context);
            const warmupPopup = await openPopupAndWaitForUi(
                context,
                extensionId,
                errors,
            );
            await warmupPopup.close();

            const page = await context.newPage();
            trackPageErrors(page, 'fixture', errors);
            await page.goto('/video.html', { waitUntil: 'domcontentloaded' });
            await Promise.race([
                requestSeen,
                new Promise<never>((_resolve, reject) => {
                    setTimeout(
                        () =>
                            reject(
                                new Error(
                                    'Timed out waiting for server analysis request.',
                                ),
                            ),
                        15_000,
                    );
                }),
            ]);

            const popupPage = await openPopupAndWaitForUi(
                context,
                extensionId,
                errors,
            );
            await page.bringToFront();
            await expect(
                popupPage.getByText('Server analysis pending'),
            ).toBeVisible({ timeout: 10_000 });
            await expect(
                popupPage.getByText('Promo blocks detected', { exact: true }),
            ).toHaveCount(0);
            await expect(
                popupPage.getByText('0 blocks', { exact: true }),
            ).toHaveCount(0);
            await popupPage.close();
            expectNoCollectedErrors(errors);
        } finally {
            await context.close();
            await new Promise<void>((resolve) => {
                backend.close(() => resolve());
            });
        }
    });

    test('server cache hit applies promo blocks and skips fixture playback', async () => {
        let resolveRequestSeen: () => void = () => {};
        const requestSeen = new Promise<void>((resolve) => {
            resolveRequestSeen = resolve;
        });
        const backend = createServer((req, res) => {
            if (handlePublicApiBootstrap(req, res)) {
                return;
            }
            if (req.method !== 'POST' || req.url !== '/v1/analysis') {
                res.writeHead(404);
                res.end();
                return;
            }
            expectAuthenticatedServerRequest(req);
            let body = '';
            req.setEncoding('utf8');
            req.on('data', (chunk) => {
                body = body + chunk;
            });
            req.on('end', () => {
                expect(JSON.parse(body)).toMatchObject({
                    videoId: 'e2eFixture1',
                    extensionVersion: '0.1.0',
                });
                expect(JSON.parse(body)).not.toHaveProperty('algorithmVersion');
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(
                    JSON.stringify({
                        status: 'ready',
                        videoId: 'e2eFixture1',
                        algorithmVersion: 'server-v4',
                        source: 'server_cache',
                        sourceResultId: 'result-e2eFixture1-server-v4',
                        freshness: { expiresAtMs: 4_102_444_800_000 },
                        promoBlocks: [
                            { startSec: 4, endSec: 24, confidence: 'high' },
                        ],
                    }),
                );
                resolveRequestSeen();
            });
        });
        await new Promise<void>((resolve) => {
            backend.listen(8787, '127.0.0.1', () => resolve());
        });

        const errors: string[] = [];
        const context = await chromium.launchPersistentContext(
            '',
            extensionContextOptions(),
        );

        try {
            trackServiceWorkerConsoleErrors(context, errors);
            const extensionId = await getExtensionId(context);
            const warmupPopup = await openPopupAndWaitForUi(
                context,
                extensionId,
                errors,
            );
            await warmupPopup.close();

            const page = await context.newPage();
            trackPageErrors(page, 'fixture-ready', errors);
            await page.goto('/video.html', { waitUntil: 'domcontentloaded' });
            await Promise.race([
                requestSeen,
                new Promise<never>((_resolve, reject) => {
                    setTimeout(
                        () =>
                            reject(
                                new Error(
                                    'Timed out waiting for server ready request.',
                                ),
                            ),
                        15_000,
                    );
                }),
            ]);

            await page.evaluate(async () => {
                const video = document.querySelector('video');
                if (!(video instanceof HTMLVideoElement)) {
                    throw new Error('Missing fixture video.');
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
                video.muted = true;
                video.playbackRate = 1;
                void video.play();
            });

            await expect
                .poll(
                    async () =>
                        page.evaluate(() => {
                            const video = document.querySelector(
                                'video',
                            ) as HTMLVideoElement;
                            return video.currentTime;
                        }),
                    { timeout: 12_000 },
                )
                .toBeGreaterThan(23);

            const popupPage = await openPopupAndWaitForUi(
                context,
                extensionId,
                errors,
            );
            await page.bringToFront();
            await expect(
                popupPage.getByText('Server-detected blocks ready'),
            ).toBeVisible({ timeout: 10_000 });
            await popupPage.close();

            expectNoCollectedErrors(errors);
        } finally {
            await context.close();
            await new Promise<void>((resolve) => {
                backend.close(() => resolve());
            });
        }
    });

    test('server processing job polls fixture completion and skips only future blocks', async () => {
        const jobId = 'local-e2eFixture1-server-v4';
        let terminalReady = false;
        let resolveRequestSeen: () => void = () => {};
        let resolveProcessingPollSeen: () => void = () => {};
        let resolveReadyPollSeen: () => void = () => {};
        const requestSeen = new Promise<void>((resolve) => {
            resolveRequestSeen = resolve;
        });
        const processingPollSeen = new Promise<void>((resolve) => {
            resolveProcessingPollSeen = resolve;
        });
        const readyPollSeen = new Promise<void>((resolve) => {
            resolveReadyPollSeen = resolve;
        });
        const readyResponse = {
            status: 'ready',
            videoId: 'e2eFixture1',
            algorithmVersion: 'server-v4',
            source: 'server_cache',
            sourceResultId: 'result-e2eFixture1-server-v4',
            freshness: { expiresAtMs: 4_102_444_800_000 },
            promoBlocks: [
                { startSec: 4, endSec: 24, confidence: 'high' },
                { startSec: 35, endSec: 45, confidence: 'medium' },
            ],
        };
        const backend = createServer((req, res) => {
            if (handlePublicApiBootstrap(req, res)) {
                return;
            }
            if (req.method === 'POST' && req.url === '/v1/analysis') {
                expectAuthenticatedServerRequest(req);
                let body = '';
                req.setEncoding('utf8');
                req.on('data', (chunk) => {
                    body = body + chunk;
                });
                req.on('end', () => {
                    expect(JSON.parse(body)).toMatchObject({
                        videoId: 'e2eFixture1',
                        extensionVersion: '0.1.0',
                    });
                    expect(JSON.parse(body)).not.toHaveProperty(
                        'algorithmVersion',
                    );
                    res.writeHead(202, {
                        'content-type': 'application/json',
                    });
                    res.end(
                        JSON.stringify({
                            status: 'processing',
                            videoId: 'e2eFixture1',
                            algorithmVersion: 'server-v4',
                            jobId,
                            pollAfterSec: 1,
                        }),
                    );
                    resolveRequestSeen();
                });
                return;
            }

            if (
                req.method === 'GET' &&
                req.url === `/v1/analysis/jobs/${jobId}`
            ) {
                expectAuthenticatedServerRequest(req);
                if (terminalReady) {
                    res.writeHead(200, {
                        'content-type': 'application/json',
                    });
                    res.end(JSON.stringify(readyResponse));
                    resolveReadyPollSeen();
                    return;
                }
                res.writeHead(202, { 'content-type': 'application/json' });
                res.end(
                    JSON.stringify({
                        status: 'processing',
                        videoId: 'e2eFixture1',
                        algorithmVersion: 'server-v4',
                        jobId,
                        pollAfterSec: 1,
                    }),
                );
                resolveProcessingPollSeen();
                return;
            }

            if (
                req.method === 'POST' &&
                req.url === `/v1/analysis/jobs/${jobId}/fixture-result`
            ) {
                terminalReady = true;
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(JSON.stringify(readyResponse));
                return;
            }

            res.writeHead(404);
            res.end();
        });
        await new Promise<void>((resolve) => {
            backend.listen(8787, '127.0.0.1', () => resolve());
        });

        const errors: string[] = [];
        const context = await chromium.launchPersistentContext(
            '',
            extensionContextOptions(),
        );

        try {
            trackServiceWorkerConsoleErrors(context, errors);
            const extensionId = await getExtensionId(context);
            const warmupPopup = await openPopupAndWaitForUi(
                context,
                extensionId,
                errors,
            );
            await warmupPopup.close();

            const page = await context.newPage();
            trackPageErrors(page, 'fixture-polling', errors);
            await page.goto('/video.html', { waitUntil: 'domcontentloaded' });
            await requestSeen;
            await processingPollSeen;

            const completed = await fetch(
                `http://127.0.0.1:8787/v1/analysis/jobs/${jobId}/fixture-result`,
                {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ status: 'ready' }),
                },
            );
            expect(completed.status).toBe(200);
            await readyPollSeen;
            await page.waitForTimeout(300);

            const resultPopup = await openPopupAndWaitForUi(
                context,
                extensionId,
                errors,
            );
            await page.bringToFront();
            await expect(
                resultPopup.getByText('2 promo blocks found'),
            ).toBeVisible({ timeout: 10_000 });
            await expect(
                resultPopup.getByText('Server cache hit.', { exact: true }),
            ).toHaveCount(0);
            await expect(
                resultPopup
                    .getByTestId('popup-promo-timeline')
                    .getByText('2:00', { exact: true }),
            ).toBeVisible();
            await resultPopup.close();

            await page.evaluate(async () => {
                const video = document.querySelector('video');
                if (!(video instanceof HTMLVideoElement)) {
                    throw new Error('Missing fixture video.');
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
                video.muted = true;
                video.playbackRate = 1;
                video.currentTime = 12;
                void video.play();
            });
            await page.waitForTimeout(900);
            await page.evaluate(() => {
                const video = document.querySelector(
                    'video',
                ) as HTMLVideoElement;
                video.pause();
            });
            const afterEarlyBlock = await page.evaluate(() => {
                const video = document.querySelector(
                    'video',
                ) as HTMLVideoElement;
                return video.currentTime;
            });
            expect(afterEarlyBlock).toBeLessThan(20);

            await page.evaluate(() => {
                const video = document.querySelector(
                    'video',
                ) as HTMLVideoElement;
                video.currentTime = 34.5;
                void video.play();
            });
            await expect
                .poll(
                    async () =>
                        page.evaluate(() => {
                            const video = document.querySelector(
                                'video',
                            ) as HTMLVideoElement;
                            return video.currentTime;
                        }),
                    { timeout: 8_000 },
                )
                .toBeGreaterThan(44);

            expectNoCollectedErrors(errors);
        } finally {
            await context.close();
            await new Promise<void>((resolve) => {
                backend.close(() => resolve());
            });
        }
    });

    test('prefs update cancellation stops scheduled server status polling', async () => {
        const jobId = 'local-e2eFixture1-server-v4';
        let statusRequestCount = 0;
        let resolveRequestSeen: () => void = () => {};
        const requestSeen = new Promise<void>((resolve) => {
            resolveRequestSeen = resolve;
        });
        const backend = createServer((req, res) => {
            if (handlePublicApiBootstrap(req, res)) {
                return;
            }
            if (req.method === 'POST' && req.url === '/v1/analysis') {
                expectAuthenticatedServerRequest(req);
                res.writeHead(202, { 'content-type': 'application/json' });
                res.end(
                    JSON.stringify({
                        status: 'processing',
                        videoId: 'e2eFixture1',
                        algorithmVersion: 'server-v4',
                        jobId,
                        pollAfterSec: 4,
                    }),
                );
                resolveRequestSeen();
                return;
            }

            if (
                req.method === 'GET' &&
                req.url === `/v1/analysis/jobs/${jobId}`
            ) {
                expectAuthenticatedServerRequest(req);
                statusRequestCount += 1;
                res.writeHead(202, { 'content-type': 'application/json' });
                res.end(
                    JSON.stringify({
                        status: 'processing',
                        videoId: 'e2eFixture1',
                        algorithmVersion: 'server-v4',
                        jobId,
                        pollAfterSec: 4,
                    }),
                );
                return;
            }

            res.writeHead(404);
            res.end();
        });
        await new Promise<void>((resolve) => {
            backend.listen(8787, '127.0.0.1', () => resolve());
        });

        const errors: string[] = [];
        const context = await chromium.launchPersistentContext(
            '',
            extensionContextOptions(),
        );

        try {
            trackServiceWorkerConsoleErrors(context, errors);
            const extensionId = await getExtensionId(context);
            const warmupPopup = await openPopupAndWaitForUi(
                context,
                extensionId,
                errors,
            );
            await warmupPopup.close();

            const page = await context.newPage();
            trackPageErrors(page, 'fixture-polling-cancel', errors);
            await page.goto('/video.html', { waitUntil: 'domcontentloaded' });
            await requestSeen;

            const popupPage = await openPopupAndWaitForUi(
                context,
                extensionId,
                errors,
            );
            await popupPage
                .getByRole('switch', { name: /enable/i })
                .click({ force: true, timeout: 30_000 });
            await popupPage.close();

            await page.waitForTimeout(4_800);
            expect(statusRequestCount).toBe(0);

            expectNoCollectedErrors(errors);
        } finally {
            await context.close();
            await new Promise<void>((resolve) => {
                backend.close(() => resolve());
            });
        }
    });

    test('Private BYOK keeps the local backend idle until a fresh Server watch lifecycle', async () => {
        const backendRequests: string[] = [];
        let resolveServerRequestSeen: () => void = () => {};
        const serverRequestSeen = new Promise<void>((resolve) => {
            resolveServerRequestSeen = resolve;
        });
        const backend = createServer((req, res) => {
            backendRequests.push(`${req.method ?? 'UNKNOWN'} ${req.url ?? ''}`);
            if (handlePublicApiBootstrap(req, res)) {
                return;
            }
            if (req.method === 'POST' && req.url === '/v1/analysis') {
                expectAuthenticatedServerRequest(req);
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(
                    JSON.stringify({
                        status: 'no_promo',
                        videoId: 'e2eFixture1',
                        algorithmVersion: 'server-v4',
                        sourceResultId: 'result-e2eFixture1-server-v4',
                        freshness: { expiresAtMs: 4_102_444_800_000 },
                    }),
                );
                resolveServerRequestSeen();
                return;
            }
            res.writeHead(404);
            res.end();
        });
        await new Promise<void>((resolve) => {
            backend.listen(8787, '127.0.0.1', () => resolve());
        });

        const errors: string[] = [];
        const context = await chromium.launchPersistentContext(
            '',
            extensionContextOptions(),
        );

        try {
            trackServiceWorkerConsoleErrors(context, errors);
            const extensionId = await getExtensionId(context);
            const optionsPage = await context.newPage();
            trackPageErrors(optionsPage, 'options-byok-route-smoke', errors);
            await optionsPage.goto(
                `chrome-extension://${extensionId}/options.html`,
                { waitUntil: 'domcontentloaded' },
            );
            const serverMode = optionsPage.getByRole('radio', {
                name: 'TopSkip Server',
            });
            const byokMode = optionsPage.getByRole('radio', {
                name: 'Private BYOK',
            });
            await expect(serverMode).toBeChecked({ timeout: 30_000 });
            await optionsPage
                .getByText('Private BYOK', { exact: true })
                .click();
            await expect(byokMode).toBeChecked();

            const byokWatchPage = await context.newPage();
            trackPageErrors(byokWatchPage, 'fixture-byok-route-smoke', errors);
            await byokWatchPage.goto('/video.html', {
                waitUntil: 'domcontentloaded',
            });
            const popupPage = await openPopupAndWaitForUi(
                context,
                extensionId,
                errors,
            );
            await byokWatchPage.bringToFront();
            await expect(
                popupPage.getByText('Private BYOK setup required'),
            ).toBeVisible({ timeout: 10_000 });
            await popupPage.close();
            await byokWatchPage.waitForTimeout(1_200);
            expect(backendRequests).toEqual([]);

            await optionsPage.bringToFront();
            await optionsPage
                .getByText('TopSkip Server', { exact: true })
                .click();
            await expect(serverMode).toBeChecked();
            await byokWatchPage.bringToFront();
            await byokWatchPage.waitForTimeout(1_200);
            expect(backendRequests).toEqual([]);

            await byokWatchPage.close();
            const serverWatchPage = await context.newPage();
            trackPageErrors(
                serverWatchPage,
                'fixture-server-route-smoke',
                errors,
            );
            await serverWatchPage.goto('/video.html', {
                waitUntil: 'domcontentloaded',
            });
            await Promise.race([
                serverRequestSeen,
                new Promise<never>((_resolve, reject) => {
                    setTimeout(
                        () =>
                            reject(
                                new Error(
                                    'Timed out waiting for resumed Server request.',
                                ),
                            ),
                        15_000,
                    );
                }),
            ]);
            expect(backendRequests).toEqual([
                'GET /v1/config',
                'POST /v1/installations/register',
                'POST /v1/analysis',
            ]);
            expectNoCollectedErrors(errors);
        } finally {
            await context.close();
            await new Promise<void>((resolve) => {
                backend.close(() => resolve());
            });
        }
    });

    test('fresh local cache hit skips fixture playback without a backend', async () => {
        const errors: string[] = [];
        const context = await chromium.launchPersistentContext(
            '',
            extensionContextOptions(),
        );

        try {
            trackServiceWorkerConsoleErrors(context, errors);
            const extensionId = await getExtensionId(context);
            const warmupPopup = await openPopupAndWaitForUi(
                context,
                extensionId,
                errors,
            );
            await seedFreshLocalServerCache(warmupPopup);
            await warmupPopup.close();

            const page = await context.newPage();
            trackPageErrors(page, 'fixture-local-cache', errors);
            await page.goto('/video.html', { waitUntil: 'domcontentloaded' });
            await page.evaluate(async () => {
                const video = document.querySelector('video');
                if (!(video instanceof HTMLVideoElement)) {
                    throw new Error('Missing fixture video.');
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
                video.muted = true;
                video.playbackRate = 1;
                void video.play();
            });

            await expect
                .poll(
                    async () =>
                        page.evaluate(() => {
                            const video = document.querySelector(
                                'video',
                            ) as HTMLVideoElement;
                            return video.currentTime;
                        }),
                    { timeout: 12_000 },
                )
                .toBeGreaterThan(23);

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
                const video = document.querySelector(
                    'video',
                ) as HTMLVideoElement;
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
                const video = document.querySelector(
                    'video',
                ) as HTMLVideoElement;
                video.muted = true;
                video.playbackRate = 4;
                void video.play();
            });

            await page.waitForTimeout(12_000);

            const t = await page.evaluate(() => {
                const video = document.querySelector(
                    'video',
                ) as HTMLVideoElement;
                return video.currentTime;
            });

            expect(t).toBeGreaterThan(40);
            expect(t).toBeLessThan(58);

            expectNoCollectedErrors(errors);
        } finally {
            await context.close();
        }
    });

    test('popup renders reference layout sections', async () => {
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
            await seedDetectedPopupState(popupPage);

            await popupPage.setViewportSize({ width: 340, height: 700 });
            await expect(popupPage.getByTestId('popup-shell')).toBeVisible();
            await expect(
                popupPage.getByTestId('popup-current-video'),
            ).toBeVisible();
            await expect(
                popupPage.getByTestId('popup-auto-skip'),
            ).toBeVisible();
            await expect(
                popupPage.getByTestId('popup-promo-blocks'),
            ).toBeVisible();
            await expect(
                popupPage.getByText(/auto-skip promo segments/i),
            ).toBeVisible();
            await expect(
                popupPage.getByText(/promo blocks detected/i),
            ).toBeVisible();
            await expect(popupPage.getByText('2 blocks')).toBeVisible();
            await expect(popupPage.getByText('1:32 - 2:05')).toBeVisible();
            await expect(popupPage.getByText('8:10 - 8:42')).toBeVisible();
            await expect(
                popupPage.getByRole('switch', { name: /enable/i }),
            ).toBeVisible();
            const settingsButton = popupPage.getByRole('button', {
                name: /open settings|continue setup/i,
            });
            await expect(settingsButton).toBeVisible();
            await expect(settingsButton).toBeEnabled();
            await expect(popupPage.getByTestId('popup-footer')).toHaveCount(0);
            await expect(
                popupPage.getByRole('button', { name: /open options/i }),
            ).toHaveCount(0);
            await expect(popupPage.getByText(/version/i)).toHaveCount(0);

            const horizontalOverflow = await popupPage.evaluate(() => {
                return (
                    document.documentElement.scrollWidth >
                    document.documentElement.clientWidth
                );
            });
            expect(horizontalOverflow).toBe(false);

            expectNoCollectedErrors(errors);
            await popupPage.close();
        } finally {
            await context.close();
        }
    });

    test('options page renders redesigned shell', async () => {
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

            await expect(page.getByTestId('options-shell')).toBeVisible();
            await expect(page.getByTestId('options-sidebar')).toBeVisible();
            await expect(
                page.getByRole('heading', { name: 'TopSkip Settings' }),
            ).toBeVisible();
            await expect(
                page.getByRole('button', { name: 'General' }),
            ).toHaveAttribute('aria-current', 'page');
            await expect(
                page.getByRole('button', { name: 'Detection' }),
            ).toBeVisible();
            await expect(
                page.getByRole('button', { name: 'Appearance' }),
            ).toBeVisible();
            await expect(
                page.getByRole('button', { name: 'Shortcuts' }),
            ).toBeVisible();
            await expect(
                page.getByRole('button', { name: 'About' }),
            ).toBeVisible();
            await page.getByRole('button', { name: 'About' }).click();
            await expect(
                page.getByRole('button', { name: 'About' }),
            ).toHaveAttribute('aria-current', 'page');
            await expect(
                page.getByRole('heading', { name: 'About TopSkip' }),
            ).toBeVisible();
            await expect(page.getByText('Version')).toBeVisible();
            const extensionVersion = await page.evaluate(() => {
                return chrome.runtime.getManifest().version;
            });
            await expect(page.getByText(`v${extensionVersion}`)).toBeVisible();

            expectNoCollectedErrors(errors);
        } finally {
            await context.close();
        }
    });

    test('options page has no horizontal overflow at supported widths', async () => {
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

            for (const width of [360, 768, 1024]) {
                await page.setViewportSize({ width, height: 900 });
                await page.goto(
                    `chrome-extension://${extensionId}/options.html`,
                    { waitUntil: 'domcontentloaded' },
                );
                await page
                    .getByTestId('options-shell')
                    .waitFor({ state: 'visible' });
                const hasOverflow = await page.evaluate(() => {
                    return (
                        document.documentElement.scrollWidth >
                        document.documentElement.clientWidth
                    );
                });
                expect(hasOverflow, `horizontal overflow at ${width}px`).toBe(
                    false,
                );
            }

            expectNoCollectedErrors(errors);
        } finally {
            await context.close();
        }
    });

    test('options page defaults to Server and reveals Private BYOK settings intentionally', async () => {
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

            await page
                .getByTestId('options-shell')
                .waitFor({ state: 'visible' });
            await expect(
                page.getByRole('heading', { name: 'Analysis mode' }),
            ).toBeVisible();
            const serverMode = page.getByRole('radio', {
                name: 'TopSkip Server',
            });
            const byokMode = page.getByRole('radio', {
                name: 'Private BYOK',
            });
            await expect(serverMode).toBeChecked();
            await expect(
                page.getByRole('heading', { name: 'Detection model' }),
            ).toBeHidden();
            await expect(
                page.getByRole('heading', { name: 'Connections' }),
            ).toBeHidden();

            await page.getByText('Private BYOK', { exact: true }).click();
            await expect(byokMode).toBeChecked();
            await expect(
                page.getByRole('heading', { name: 'Detection model' }),
            ).toBeVisible();
            await expect(
                page.getByRole('heading', { name: 'Connections' }),
            ).toBeVisible();
            await expect(page.getByText('OpenAI').first()).toBeVisible();
            await expect(page.getByText('OpenRouter').first()).toBeVisible();

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
                .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
                .disableRules(['color-contrast'])
                .analyze();
            expect(
                popupResults.violations,
                'Popup axe violations:\n' +
                    JSON.stringify(popupResults.violations, null, 2),
            ).toEqual([]);
            await popupPage.close();

            // --- Options page: intentional Server and BYOK states ---
            const optionsPage = await context.newPage();
            trackPageErrors(optionsPage, 'options', errors);
            await optionsPage.goto(
                `chrome-extension://${extensionId}/options.html`,
                { waitUntil: 'domcontentloaded' },
            );
            const serverMode = optionsPage.getByRole('radio', {
                name: 'TopSkip Server',
            });
            const byokMode = optionsPage.getByRole('radio', {
                name: 'Private BYOK',
            });
            await expect(serverMode).toBeChecked({ timeout: 30_000 });

            const serverOptionsResults = await new AxeBuilder({
                page: optionsPage,
            })
                .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
                .disableRules(['color-contrast'])
                .analyze();
            expect(
                serverOptionsResults.violations,
                'Server options axe violations:\n' +
                    JSON.stringify(serverOptionsResults.violations, null, 2),
            ).toEqual([]);

            await optionsPage
                .getByText('Private BYOK', { exact: true })
                .click();
            await expect(byokMode).toBeChecked();
            await expect(
                optionsPage.getByRole('combobox', { name: 'Model' }),
            ).toBeVisible();
            const byokOptionsResults = await new AxeBuilder({
                page: optionsPage,
            })
                .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
                .disableRules(['color-contrast'])
                .analyze();
            expect(
                byokOptionsResults.violations,
                'Private BYOK options axe violations:\n' +
                    JSON.stringify(byokOptionsResults.violations, null, 2),
            ).toEqual([]);
            await optionsPage.close();

            expectNoCollectedErrors(errors);
        } finally {
            await context.close();
        }
    });
});
