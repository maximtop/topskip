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
    waitForPopupUi,
} from './extension-helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '../dist');
const E2E_SERVER_API_VERSION = 1;
const E2E_SERVER_ALGORITHM_VERSION = 'server-v5';
const E2E_VIDEO_ID = 'e2eFixture1';
const E2E_CAPTION_LANGUAGE = 'en';
const E2E_CAPTION_SEGMENTS = [
    {
        startSec: 0,
        durationSec: 1,
        text: 'TopSkip deterministic caption fixture',
    },
] as const;
const E2E_TRANSCRIPT_HASH =
    '7587903459454f21f7b2d9a0b3e22f21617a4d80a2622137ba8db86675887542';
const E2E_TRANSCRIPT_IDENTITY = {
    videoId: E2E_VIDEO_ID,
    languageCode: E2E_CAPTION_LANGUAGE,
    transcriptHash: E2E_TRANSCRIPT_HASH,
    algorithmVersion: E2E_SERVER_ALGORITHM_VERSION,
} as const;
const E2E_INSTALLATION_TOKEN =
    'e2e-installation-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const E2E_INSTALLATION_EXPIRES_AT_MS = 4_102_444_800_000;
const E2E_CAPABILITIES_HEADER =
    SERVER_ANALYSIS_SUPPORTED_CAPABILITIES.join(',');
const POPUP_RACE_TEST_TIMEOUT_MS = 20_000;
const RUNTIME_MESSAGE_GATE_TIMEOUT_MS = 5_000;
const GET_MODEL_SETTINGS_MESSAGE_TYPE = 'TOPSKIP_GET_MODEL_SETTINGS';
const GET_PREFS_MESSAGE_TYPE = 'TOPSKIP_GET_PREFS';
const BYOK_ANALYSIS_MODE = 'byok';
const RUNTIME_MESSAGE_GATE_STATE_KEY = '__topskipE2eRuntimeMessageGateState';
const RUNTIME_MESSAGE_GATE_RELEASE_KEY =
    '__topskipE2eReleaseRuntimeMessageGate';
const RUNTIME_MESSAGE_GATE_HELD_STATE = 'held';
const RUNTIME_MESSAGE_GATE_RELEASED_STATE = 'released';

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
                apiVersion: E2E_SERVER_API_VERSION,
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

function extensionContextOptions(headless = extensionHeadless) {
    return {
        headless,
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
 * Seeds one tab's detection snapshot through a dev-only background message.
 *
 * @param extensionPage - Extension page whose tab owns the snapshot.
 * @param state - Serializable detection snapshot to store.
 */
async function seedPopupState(
    extensionPage: Page,
    state: unknown,
): Promise<void> {
    await extensionPage.evaluate(async (state) => {
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
            state,
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
            throw new Error('Failed to seed popup state');
        }
    }, state);
}

/**
 * Holds one runtime message until the test explicitly releases it, making the
 * popup's intermediate provider-loading state deterministic.
 *
 * @param popupPage - Popup page before its extension URL is loaded.
 * @param messageType - Runtime message type whose dispatch should be held.
 */
async function installRuntimeMessageGate(
    popupPage: Page,
    messageType: string,
): Promise<void> {
    await popupPage.addInitScript(
        ({ messageType, stateKey, releaseKey, heldState, releasedState }) => {
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

            let heldCalls: unknown[][] = [];
            const gatedSendMessage = (...args: unknown[]): unknown => {
                const matchingMessage = args.find(
                    (argument) =>
                        typeof argument === 'object' &&
                        argument !== null &&
                        Reflect.get(argument, 'type') === messageType,
                );
                if (matchingMessage === undefined) {
                    return Reflect.apply(sendMessage, runtime, args);
                }

                heldCalls.push(args);
                Reflect.set(globalThis, stateKey, heldState);
                return undefined;
            };

            const release = (): void => {
                if (heldCalls.length === 0) {
                    throw new Error('Runtime message gate has no held call');
                }
                const calls = heldCalls;
                heldCalls = [];
                Reflect.set(globalThis, stateKey, releasedState);
                for (const args of calls) {
                    Reflect.apply(sendMessage, runtime, args);
                }
            };

            Reflect.set(globalThis, releaseKey, release);
            if (!Reflect.set(runtime, 'sendMessage', gatedSendMessage)) {
                throw new Error('Could not gate chrome.runtime.sendMessage');
            }
        },
        {
            messageType,
            stateKey: RUNTIME_MESSAGE_GATE_STATE_KEY,
            releaseKey: RUNTIME_MESSAGE_GATE_RELEASE_KEY,
            heldState: RUNTIME_MESSAGE_GATE_HELD_STATE,
            releasedState: RUNTIME_MESSAGE_GATE_RELEASED_STATE,
        },
    );
}

/**
 * Waits until the popup has actually attempted the gated runtime request.
 *
 * @param popupPage - Popup page with an installed runtime-message gate.
 * @returns Promise resolving only after the message is held.
 */
async function waitForHeldRuntimeMessage(popupPage: Page): Promise<void> {
    await expect
        .poll(
            () =>
                popupPage.evaluate((stateKey) => {
                    const state: unknown = Reflect.get(globalThis, stateKey);
                    return state;
                }, RUNTIME_MESSAGE_GATE_STATE_KEY),
            { timeout: RUNTIME_MESSAGE_GATE_TIMEOUT_MS },
        )
        .toBe(RUNTIME_MESSAGE_GATE_HELD_STATE);
}

/**
 * Releases the held runtime request after the intermediate UI is verified.
 *
 * @param popupPage - Popup page with a held runtime request.
 * @returns Promise resolving after the real Chrome API receives the request.
 */
async function releaseHeldRuntimeMessage(popupPage: Page): Promise<void> {
    await popupPage.evaluate(
        ({ releaseKey, stateKey, releasedState }) => {
            const release: unknown = Reflect.get(globalThis, releaseKey);
            if (typeof release !== 'function') {
                throw new Error('Missing runtime message gate release');
            }
            Reflect.apply(release, globalThis, []);
            if (Reflect.get(globalThis, stateKey) !== releasedState) {
                throw new Error('Runtime message gate did not release');
            }
        },
        {
            releaseKey: RUNTIME_MESSAGE_GATE_RELEASE_KEY,
            stateKey: RUNTIME_MESSAGE_GATE_STATE_KEY,
            releasedState: RUNTIME_MESSAGE_GATE_RELEASED_STATE,
        },
    );
}

/**
 * Confirms the background persisted a mode instead of trusting optimistic UI.
 *
 * @param extensionPage - Extension page allowed to call the runtime API.
 * @param expectedMode - Analysis mode expected from background preferences.
 * @returns Promise resolving after GET_PREFS reports the expected mode.
 */
async function waitForStoredAnalysisMode(
    extensionPage: Page,
    expectedMode: string,
): Promise<void> {
    await expect
        .poll(
            () =>
                extensionPage.evaluate(async (messageType) => {
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
                        throw new Error(
                            'Missing chrome.runtime.sendMessage API',
                        );
                    }

                    const response: unknown = await new Promise(
                        (resolve, reject) => {
                            Reflect.apply(sendMessage, runtime, [
                                { type: messageType },
                                (result: unknown) => {
                                    const lastError = Reflect.get(
                                        runtime,
                                        'lastError',
                                    );
                                    if (
                                        typeof lastError === 'object' &&
                                        lastError !== null
                                    ) {
                                        reject(
                                            new Error(
                                                String(
                                                    Reflect.get(
                                                        lastError,
                                                        'message',
                                                    ) ??
                                                        'runtime.sendMessage failed',
                                                ),
                                            ),
                                        );
                                        return;
                                    }
                                    resolve(result);
                                },
                            ]);
                        },
                    );
                    if (typeof response !== 'object' || response === null) {
                        return null;
                    }
                    const prefs: unknown = Reflect.get(response, 'prefs');
                    if (typeof prefs !== 'object' || prefs === null) {
                        return null;
                    }
                    const analysisMode: unknown = Reflect.get(
                        prefs,
                        'analysisMode',
                    );
                    return analysisMode;
                }, GET_PREFS_MESSAGE_TYPE),
            { timeout: RUNTIME_MESSAGE_GATE_TIMEOUT_MS },
        )
        .toBe(expectedMode);
}

/**
 * Seeds a ready server result through extension storage for no-network e2e.
 *
 * @param popupPage - Open extension popup page.
 * @param transcriptHash - Cache identity used to exercise exact hits or misses.
 */
async function seedFreshLocalServerCache(
    popupPage: Page,
    transcriptHash = E2E_TRANSCRIPT_HASH,
): Promise<void> {
    await popupPage.evaluate(
        async (fixture) => {
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
            const remove = Reflect.get(local, 'remove');
            if (typeof set !== 'function' || typeof remove !== 'function') {
                throw new Error('Missing chrome.storage.local mutation API');
            }

            const keyForHash = (hash: string): string =>
                [
                    'topskip:server-result-cache',
                    fixture.algorithmVersion,
                    fixture.videoId,
                    fixture.languageCode,
                    hash,
                ].join(':');
            const key = keyForHash(fixture.transcriptHash);
            await new Promise<void>((resolve, reject) => {
                Reflect.apply(remove, local, [
                    [keyForHash(fixture.defaultTranscriptHash), key],
                    () => {
                        const runtime = Reflect.get(chromeApi, 'runtime');
                        const lastError =
                            typeof runtime === 'object' && runtime !== null
                                ? Reflect.get(runtime, 'lastError')
                                : undefined;
                        if (
                            typeof lastError === 'object' &&
                            lastError !== null
                        ) {
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
            const storedAtMs = Date.now();
            await new Promise<void>((resolve, reject) => {
                Reflect.apply(set, local, [
                    {
                        'topskip:server-config': {
                            config: {
                                apiVersion: fixture.apiVersion,
                                algorithmVersion: fixture.algorithmVersion,
                                supportedCapabilities: fixture.capabilities,
                                supportIssueBaseUrl:
                                    'https://github.com/maximtop/topskip/issues/new',
                            },
                            fetchedAtMs: storedAtMs,
                        },
                        'topskip:server-config-refresh-attempt': storedAtMs,
                        [key]: {
                            status: 'ready',
                            videoId: fixture.videoId,
                            languageCode: fixture.languageCode,
                            transcriptHash: fixture.transcriptHash,
                            algorithmVersion: fixture.algorithmVersion,
                            sourceResultId: 'result-e2eFixture1-server-v5',
                            freshness: { expiresAtMs: 4_102_444_800_000 },
                            promoBlocks: [
                                { startSec: 4, endSec: 24, confidence: 'high' },
                            ],
                            storedAtMs,
                        },
                    },
                    () => {
                        const runtime = Reflect.get(chromeApi, 'runtime');
                        const lastError =
                            typeof runtime === 'object' && runtime !== null
                                ? Reflect.get(runtime, 'lastError')
                                : undefined;
                        if (
                            typeof lastError === 'object' &&
                            lastError !== null
                        ) {
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
        },
        {
            apiVersion: E2E_SERVER_API_VERSION,
            algorithmVersion: E2E_SERVER_ALGORITHM_VERSION,
            capabilities: [...SERVER_ANALYSIS_SUPPORTED_CAPABILITIES],
            videoId: E2E_VIDEO_ID,
            languageCode: E2E_CAPTION_LANGUAGE,
            transcriptHash,
            defaultTranscriptHash: E2E_TRANSCRIPT_HASH,
        },
    );
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

    test('headless popup survives delayed BYOK provider metadata', async () => {
        test.setTimeout(POPUP_RACE_TEST_TIMEOUT_MS);
        const errors: string[] = [];
        const context = await chromium.launchPersistentContext(
            '',
            extensionContextOptions(true),
        );

        try {
            trackServiceWorkerConsoleErrors(context, errors);
            const extensionId = await getExtensionId(context);
            const setupPage = await context.newPage();
            trackPageErrors(setupPage, 'popup-race-setup', errors);
            await setupPage.goto(
                `chrome-extension://${extensionId}/options.html`,
                { waitUntil: 'domcontentloaded' },
            );
            const byokMode = setupPage.getByRole('radio', {
                name: 'Private BYOK',
            });
            await setupPage.getByText('Private BYOK', { exact: true }).click();
            await expect(byokMode).toBeChecked();
            await waitForStoredAnalysisMode(setupPage, BYOK_ANALYSIS_MODE);
            const popupState = {
                videoId: 'popup-provider-race',
                status: 'not_configured',
                source: 'local_provider',
            };
            await seedPopupState(setupPage, popupState);

            const popupPage = await context.newPage();
            trackPageErrors(popupPage, 'popup-provider-race', errors);
            await installRuntimeMessageGate(
                popupPage,
                GET_MODEL_SETTINGS_MESSAGE_TYPE,
            );
            await setupPage.bringToFront();
            await popupPage.goto(
                `chrome-extension://${extensionId}/popup.html`,
                { waitUntil: 'domcontentloaded' },
            );
            await waitForPopupUi(popupPage);
            await waitForHeldRuntimeMessage(popupPage);
            await setupPage.bringToFront();
            await seedPopupState(setupPage, popupState);

            await expect(
                popupPage.getByText('Private BYOK setup required'),
            ).toBeVisible();
            await expect(
                popupPage.getByText(
                    'Configure Private BYOK in settings before promo analysis can run.',
                ),
            ).toBeVisible();
            await releaseHeldRuntimeMessage(popupPage);
            await expect(popupPage.getByRole('alert')).toHaveCount(0);
            await expect(
                popupPage.getByText('Something went wrong'),
            ).toHaveCount(0);
            await expect(
                popupPage.getByText(/Value 'provider' for 'placeholder'/),
            ).toHaveCount(0);
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

    test('server transcript contract fixture reaches analysis phase', async () => {
        const jobId = 'local-e2eFixture1-server-v5';
        const processingResponse = {
            status: 'processing',
            ...E2E_TRANSCRIPT_IDENTITY,
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
                const request: unknown = JSON.parse(body) as unknown;
                expect(request).toMatchObject({
                    videoId: E2E_VIDEO_ID,
                    extensionVersion: '0.1.0',
                    languageCode: E2E_CAPTION_LANGUAGE,
                    segments: E2E_CAPTION_SEGMENTS,
                    client: {
                        source: 'chrome-extension',
                        capabilities: [
                            ...SERVER_ANALYSIS_SUPPORTED_CAPABILITIES,
                        ],
                    },
                });
                expect(request).not.toHaveProperty('algorithmVersion');
                expect(request).not.toHaveProperty('transcriptHash');
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
                    videoId: E2E_VIDEO_ID,
                    extensionVersion: '0.1.0',
                    languageCode: E2E_CAPTION_LANGUAGE,
                    segments: E2E_CAPTION_SEGMENTS,
                });
                expect(JSON.parse(body)).not.toHaveProperty('algorithmVersion');
                expect(JSON.parse(body)).not.toHaveProperty('transcriptHash');
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(
                    JSON.stringify({
                        status: 'ready',
                        ...E2E_TRANSCRIPT_IDENTITY,
                        source: 'server_cache',
                        sourceResultId: 'result-e2eFixture1-server-v5',
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

    test('caption phase reaches ready and skips only future blocks', async () => {
        const jobId = 'local-e2eFixture1-server-v5';
        let terminalReady = false;
        const heldAnalysis: { response: ServerResponse | null } = {
            response: null,
        };
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
            ...E2E_TRANSCRIPT_IDENTITY,
            source: 'server_cache',
            sourceResultId: 'result-e2eFixture1-server-v5',
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
                        videoId: E2E_VIDEO_ID,
                        extensionVersion: '0.1.0',
                        languageCode: E2E_CAPTION_LANGUAGE,
                        segments: E2E_CAPTION_SEGMENTS,
                    });
                    expect(JSON.parse(body)).not.toHaveProperty(
                        'algorithmVersion',
                    );
                    expect(JSON.parse(body)).not.toHaveProperty(
                        'transcriptHash',
                    );
                    heldAnalysis.response = res;
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
                        ...E2E_TRANSCRIPT_IDENTITY,
                        jobId,
                        pollAfterSec: 1,
                    }),
                );
                resolveProcessingPollSeen();
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

            const acquisitionPopup = await openPopupAndWaitForUi(
                context,
                extensionId,
                errors,
            );
            await page.bringToFront();
            await expect(
                acquisitionPopup.getByText('Getting captions'),
            ).toBeVisible({ timeout: 10_000 });
            await acquisitionPopup.close();

            const pendingAnalysisResponse = heldAnalysis.response;
            if (pendingAnalysisResponse === null) {
                throw new Error('Missing held analysis response.');
            }
            pendingAnalysisResponse.writeHead(202, {
                'content-type': 'application/json',
            });
            pendingAnalysisResponse.end(
                JSON.stringify({
                    status: 'processing',
                    ...E2E_TRANSCRIPT_IDENTITY,
                    jobId,
                    pollAfterSec: 1,
                }),
            );
            heldAnalysis.response = null;
            await processingPollSeen;

            const analysisPopup = await openPopupAndWaitForUi(
                context,
                extensionId,
                errors,
            );
            await page.bringToFront();
            await expect(
                analysisPopup.getByText('Server analysis pending'),
            ).toBeVisible({ timeout: 10_000 });
            await analysisPopup.close();

            terminalReady = true;
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
                resultPopup.getByText('0:04 - 0:24', { exact: true }),
            ).toBeVisible();
            await expect(
                resultPopup.getByText('0:35 - 0:45', { exact: true }),
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
        const jobId = 'local-e2eFixture1-server-v5';
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
                        ...E2E_TRANSCRIPT_IDENTITY,
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
                        ...E2E_TRANSCRIPT_IDENTITY,
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

    test('job loss resubmits one exact captured transcript', async () => {
        const jobId = 'lost-e2eFixture1-server-v5';
        const requestBodies: string[] = [];
        let pollRequestCount = 0;
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
                    requestBodies.push(body);
                    res.writeHead(requestBodies.length === 1 ? 202 : 200, {
                        'content-type': 'application/json',
                    });
                    if (requestBodies.length === 1) {
                        res.end(
                            JSON.stringify({
                                status: 'processing',
                                ...E2E_TRANSCRIPT_IDENTITY,
                                jobId,
                                pollAfterSec: 1,
                            }),
                        );
                        return;
                    }
                    res.end(
                        JSON.stringify({
                            status: 'ready',
                            ...E2E_TRANSCRIPT_IDENTITY,
                            source: 'server_cache',
                            sourceResultId:
                                'result-e2eFixture1-resubmitted-server-v5',
                            freshness: {
                                expiresAtMs: 4_102_444_800_000,
                            },
                            promoBlocks: [
                                {
                                    startSec: 35,
                                    endSec: 45,
                                    confidence: 'high',
                                },
                            ],
                        }),
                    );
                });
                return;
            }
            if (
                req.method === 'GET' &&
                req.url === `/v1/analysis/jobs/${jobId}`
            ) {
                expectAuthenticatedServerRequest(req);
                pollRequestCount += 1;
                res.writeHead(404, { 'content-type': 'application/json' });
                res.end(
                    JSON.stringify({
                        status: 'error',
                        ...E2E_TRANSCRIPT_IDENTITY,
                        error: { code: 'job_not_found' },
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
            trackPageErrors(page, 'fixture-job-resubmit', errors);
            await page.goto('/video.html', { waitUntil: 'domcontentloaded' });

            await expect
                .poll(() => requestBodies.length, { timeout: 15_000 })
                .toBe(2);
            expect(requestBodies[1]).toBe(requestBodies[0]);
            expect(pollRequestCount).toBe(1);

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
            await page.waitForTimeout(1_200);
            expect(requestBodies).toHaveLength(2);
            expect(pollRequestCount).toBe(1);
            expectNoCollectedErrors(errors);
        } finally {
            await context.close();
            await new Promise<void>((resolve) => {
                backend.close(() => resolve());
            });
        }
    });

    test('caption failure never contacts TopSkip', async () => {
        const backendRequests: string[] = [];
        const backend = createServer((req, res) => {
            backendRequests.push(`${req.method ?? 'UNKNOWN'} ${req.url ?? ''}`);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ status: 'unexpected-request' }));
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
            const setupPage = await context.newPage();
            trackPageErrors(setupPage, 'fixture-caption-failure', errors);
            await setupPage.goto(
                `chrome-extension://${extensionId}/options.html`,
                { waitUntil: 'domcontentloaded' },
            );
            const baseFailureState = {
                videoId: E2E_VIDEO_ID,
                sessionId: '00000000-0000-4000-8000-000000000012',
                source: 'server',
                serverFailure: {
                    apiVersion: E2E_SERVER_API_VERSION,
                    extensionVersion: '0.1.0',
                },
            } as const;
            await seedPopupState(setupPage, {
                videoId: baseFailureState.videoId,
                sessionId: baseFailureState.sessionId,
                status: 'analyzing',
                source: 'server',
                serverAnalysisPhase: 'caption_acquisition',
            });
            await seedPopupState(setupPage, {
                ...baseFailureState,
                status: 'unavailable',
                serverFailure: {
                    ...baseFailureState.serverFailure,
                    code: 'captions_unavailable',
                },
            });

            const popupPage = await openPopupAndWaitForUi(
                context,
                extensionId,
                errors,
            );
            await setupPage.bringToFront();
            await expect(
                popupPage.getByRole('button', {
                    name: 'Report if this seems wrong',
                }),
            ).toBeVisible();
            await expect(popupPage.getByText(/support id/iu)).toHaveCount(0);

            await seedPopupState(setupPage, {
                ...baseFailureState,
                status: 'error',
                serverFailure: {
                    ...baseFailureState.serverFailure,
                    code: 'caption_extraction_failed',
                },
            });
            await expect(
                popupPage.getByRole('button', { name: 'Report on GitHub' }),
            ).toBeVisible({ timeout: 10_000 });
            await popupPage.close();

            expect(backendRequests).toEqual([]);
            expectNoCollectedErrors(errors);
        } finally {
            await context.close();
            await new Promise<void>((resolve) => {
                backend.close(() => resolve());
            });
        }
    });

    test('stale navigation session cannot replace the current result', async () => {
        const errors: string[] = [];
        const context = await chromium.launchPersistentContext(
            '',
            extensionContextOptions(),
        );

        try {
            trackServiceWorkerConsoleErrors(context, errors);
            const extensionId = await getExtensionId(context);
            const setupPage = await context.newPage();
            trackPageErrors(setupPage, 'fixture-stale-session', errors);
            await setupPage.goto(
                `chrome-extension://${extensionId}/options.html`,
                { waitUntil: 'domcontentloaded' },
            );
            const popupPage = await openPopupAndWaitForUi(
                context,
                extensionId,
                errors,
            );
            await setupPage.bringToFront();

            const staleSessionId = '00000000-0000-4000-8000-000000000021';
            const currentSessionId = '00000000-0000-4000-8000-000000000022';
            await seedPopupState(setupPage, {
                videoId: 'stale-video',
                sessionId: staleSessionId,
                status: 'analyzing',
                source: 'server',
                serverAnalysisPhase: 'caption_acquisition',
            });
            await seedPopupState(setupPage, {
                videoId: E2E_VIDEO_ID,
                sessionId: currentSessionId,
                status: 'analyzing',
                source: 'server',
                serverAnalysisPhase: 'caption_acquisition',
            });
            await seedPopupState(setupPage, {
                videoId: E2E_VIDEO_ID,
                sessionId: currentSessionId,
                status: 'detected',
                source: 'server_cache',
                durationSec: 60,
                promoBlocks: [{ startSec: 35, endSec: 45, confidence: 'high' }],
            });
            await seedPopupState(setupPage, {
                videoId: 'stale-video',
                sessionId: staleSessionId,
                status: 'error',
                source: 'server',
                serverFailure: {
                    code: 'internal_error',
                    apiVersion: E2E_SERVER_API_VERSION,
                    algorithmVersion: E2E_SERVER_ALGORITHM_VERSION,
                    extensionVersion: '0.1.0',
                },
            });

            await expect(
                popupPage.getByText('Server-detected blocks ready'),
            ).toBeVisible({ timeout: 10_000 });
            await expect(
                popupPage.getByText('0:35 - 0:45', { exact: true }),
            ).toBeVisible();
            await expect(
                popupPage.getByText('TopSkip Server error'),
            ).toHaveCount(0);
            await popupPage.close();
            expectNoCollectedErrors(errors);
        } finally {
            await context.close();
        }
    });

    test('Private BYOK remains isolated', async () => {
        const backendRequests: string[] = [];
        const backend = createServer((req, res) => {
            backendRequests.push(`${req.method ?? 'UNKNOWN'} ${req.url ?? ''}`);
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ status: 'unexpected-request' }));
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
            expectNoCollectedErrors(errors);
        } finally {
            await context.close();
            await new Promise<void>((resolve) => {
                backend.close(() => resolve());
            });
        }
    });

    test('local cache requires recaptured exact transcript identity', async () => {
        const backendRequests: string[] = [];
        const backend = createServer((req, res) => {
            backendRequests.push(`${req.method ?? 'UNKNOWN'} ${req.url ?? ''}`);
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
                    const request: unknown = JSON.parse(body) as unknown;
                    expect(request).toMatchObject({
                        videoId: E2E_VIDEO_ID,
                        languageCode: E2E_CAPTION_LANGUAGE,
                        segments: E2E_CAPTION_SEGMENTS,
                    });
                    expect(request).not.toHaveProperty('transcriptHash');
                    res.writeHead(200, {
                        'content-type': 'application/json',
                    });
                    res.end(
                        JSON.stringify({
                            status: 'no_promo',
                            ...E2E_TRANSCRIPT_IDENTITY,
                            sourceResultId:
                                'result-e2eFixture1-exact-miss-server-v5',
                            freshness: {
                                expiresAtMs: 4_102_444_800_000,
                            },
                        }),
                    );
                });
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
            expect(backendRequests).toEqual([]);

            await page.close();
            const setupPage = await context.newPage();
            trackPageErrors(setupPage, 'fixture-local-cache-miss', errors);
            await setupPage.goto(
                `chrome-extension://${extensionId}/options.html`,
                { waitUntil: 'domcontentloaded' },
            );
            await seedFreshLocalServerCache(setupPage, 'f'.repeat(64));
            await setupPage.close();

            const recapturedPage = await context.newPage();
            trackPageErrors(recapturedPage, 'fixture-recaptured-cache', errors);
            await recapturedPage.goto('/video.html', {
                waitUntil: 'domcontentloaded',
            });
            await expect
                .poll(
                    () =>
                        backendRequests.filter(
                            (request) => request === 'POST /v1/analysis',
                        ).length,
                    { timeout: 15_000 },
                )
                .toBe(1);
            expect(backendRequests).toEqual([
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
            await seedPopupState(popupPage, {
                videoId: 'visual-fixture',
                status: 'detected',
                durationSec: 600,
                promoBlocks: [
                    { startSec: 92, endSec: 125 },
                    { startSec: 490, endSec: 522 },
                ],
            });

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
