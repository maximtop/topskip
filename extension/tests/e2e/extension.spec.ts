import fs from 'node:fs/promises';
import path from 'node:path';
import {
    createServer,
    type IncomingMessage,
    type Server,
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
    CAPTION_PAGE_BRIDGE_COMMAND,
    CAPTION_PAGE_BRIDGE_EVENT,
    CAPTION_PAGE_BRIDGE_KIND,
    CAPTION_PAGE_BRIDGE_PROTOCOL_VERSION,
    CAPTION_PAGE_BRIDGE_SOURCE,
} from '../../src/content/captions/caption-page-bridge-contract';
import {
    CONTENT_SCRIPT_PROTOCOL_VERSION,
    DEV_DEBUG_LOG_SEED_STATE,
    TOPSKIP_MESSAGE,
} from '../../src/shared/messages';
import {
    BYTES_PER_KIB,
    STORAGE_KEY_DEBUG_LOG_PREFIX,
} from '../../src/shared/constants';
import {
    DEBUG_LOG_CAP_BYTES,
    DEBUG_LOG_PERSISTED_OVERHEAD_BYTES,
} from '../../src/shared/debug-log-constants';
import { DEBUG_LOG_EVENT } from '../../src/shared/debug-log-events';
import { buildDebugLogFileName } from '../../src/shared/debug-log-format';
import { E2E_BACKEND_ORIGIN } from './global-setup';

import {
    captureIssueReportUrl,
    clearCapturedClipboardText,
    expectNoCollectedErrors,
    installClipboardCapture,
    openOptionsDiagnostics,
    openPopupAndWaitForUi,
    readCapturedClipboardText,
    readDebugLogStorageBytes,
    seedDebugLog,
    trackPageErrors,
    trackServiceWorkerConsoleErrors,
    waitForPopupUi,
} from './extension-helpers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '../../dist');
const E2E_SERVER_API_VERSION = 1;
const E2E_SERVER_ALGORITHM_VERSION = 'server-v7';
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
const GET_DETECTION_STATUS_MESSAGE_TYPE = 'TOPSKIP_GET_DETECTION_STATUS';
const BYOK_ANALYSIS_MODE = 'byok';
const RUNTIME_MESSAGE_GATE_STATE_KEY = '__topskipE2eRuntimeMessageGateState';
const RUNTIME_MESSAGE_GATE_RELEASE_KEY =
    '__topskipE2eReleaseRuntimeMessageGate';
const RUNTIME_MESSAGE_GATE_HELD_STATE = 'held';
const RUNTIME_MESSAGE_GATE_RELEASED_STATE = 'released';
const OPTIONAL_PROVIDER_ORIGINS = [
    'https://openrouter.ai/*',
    'https://api.openai.com/*',
] as const;
const CAPTION_PAGE_BRIDGE_INSTALL_FLAG = '__topskipCaptionCaptureInstalled';
const CAPTION_PAGE_BRIDGE_TEARDOWN_FLAG = '__topskipCaptionCaptureTeardown';
// Several orphan-poll ticks: a live context must never be torn down.
const ORPHAN_FALSE_POSITIVE_WINDOW_MS = 3_500;
// Orphan poll cadence plus the bounded bridge command timeout, with slack.
const ORPHAN_TEARDOWN_TIMEOUT_MS = 15_000;
// Popup-open probe plus the background's bounded settle wait, with slack.
const POPUP_REATTACH_TIMEOUT_MS = 15_000;
// Page global holding the bridge generation a spec fingerprinted.
const PAGE_BRIDGE_IDENTITY_MARKER_KEY = '__topskipE2eBridgeIdentity';
// English strings of the Diagnostics section and popup indicator; the E2E
// profile runs with the English locale.
const DEBUG_LOG_SWITCH_LABEL = 'Debug logging';
const DEBUG_LOG_ON_PATTERN = /^Debug logging on since /u;
const DEBUG_LOG_OFF_PATTERN = /^Debug logging off — /u;
const POPUP_DEBUG_LOGGING_TEXT = 'Debug logging on';
// Bounds Diagnostics/popup status expectations; covers two 5 s status polls.
const DEBUG_LOG_UI_TIMEOUT_MS = 10_000;
const DEBUG_LOG_COPY_LABEL = 'Copy log';
const DEBUG_LOG_DOWNLOAD_LABEL = 'Download log';
const DEBUG_LOG_COPIED_TEXT = 'Log copied to the clipboard';
const DEBUG_LOG_COPY_FAILED_TEXT =
    'Could not copy the log — try again or use Download log';
const DEBUG_LOG_EXPORT_FAILED_TEXT = 'Could not read the log — try again';
const DEBUG_LOG_DOWNLOAD_STARTED_TEXT = 'Download started';
const DEBUG_LOG_OFF_STORED_PATTERN =
    /^Debug logging off — [1-9]\d* events stored, /u;
const DEBUG_LOG_EVICTED_COUNTER_PATTERN = /^Evicted: [1-9]\d*/u;
const DEBUG_LOG_PREVIEW_TRUNCATED_PATTERN = /^Showing the last /u;
const DEBUG_LOG_ISSUE_HINT_PREFIX =
    'If you enabled Debug logging in Options → Diagnostics';
// Event lines start with the background-assigned UTC timestamp; the header
// block precedes the first such line.
const ISO_TIMESTAMP_LENGTH = 24;
const ISO_TIMESTAMP_PATTERN =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DEBUG_LOG_EVENT_LINE_PATTERN =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /u;
// Header keys written by DebugLogExport.buildBundle.
const DEBUG_LOG_HEADER_EXPORTED_AT = 'exportedAt';
const DEBUG_LOG_HEADER_EVENTS = 'events';
const DEBUG_LOG_HEADER_EVICTED = 'evicted';
const DEBUG_LOG_HEADER_OLDEST_RETAINED = 'oldestRetained';
const DEBUG_LOG_FILE_NAME_PATTERN = /^topskip-debug-log-\d{8}T\d{6}Z\.txt$/u;
// Content flush delay + store debounce + slack before a snapshot is read.
const DEBUG_LOG_SETTLE_MS = 1_500;
// Long enough for a released (late) bundle reply to reach the page.
const DEBUG_LOG_LATE_REPLY_WAIT_MS = 500;
// Block delivery settles shortly after the ready poll (see the polling test).
const BLOCK_DELIVERY_SETTLE_MS = 300;
// Processing polls before the mocked job turns ready.
const POLLING_BACKEND_PROCESSING_POLLS = 2;
// Fixture loads after a near-cap seed; each adds several events.
const FIXTURE_VISITS_PAST_CAP = 2;
const DEBUG_LOG_OFF_EMPTY_TEXT = 'Debug logging off — no log stored';
// Seeded preview content for the overflow/axe checks: many lines, each wider
// than the 360 px column.
const DEBUG_LOG_OVERFLOW_SEED_BYTES = 64 * BYTES_PER_KIB;
// SC-005: one fresh Server-mode analysis (polls + one skip) stays under this
// many events; the switch is cycled off→on right before the flow, so the log
// holds nothing else. This E2E is the full-flow check at
// POLLING_BACKEND_PROCESSING_POLLS (2) polls; the 10-poll cadence of SC-005
// is covered by Task D5's interim-summary unit test (12 polls, ≤ 40 events).
const DEBUG_LOG_FRESH_ANALYSIS_MAX_EVENTS = 40;
const E2E_POLLING_JOB_ID = 'local-e2eFixture1-server-v7';
const E2E_RESULT_FRESHNESS_EXPIRES_AT_MS = 4_102_444_800_000;
const E2E_BACKEND_URL = new URL(E2E_BACKEND_ORIGIN);
const E2E_BACKEND_HOST_SENTINEL = E2E_BACKEND_URL.host;
const JSON_RESPONSE_HEADERS = { 'content-type': 'application/json' } as const;

type GrantedExtensionPermissions = {
    permissions: string[];
    origins: string[];
};

/**
 * Reads the browser-owned grant snapshot from an extension document.
 *
 * @param extensionPage - Popup or options page with extension API access.
 * @returns Sorted required and optional grants currently held by TopSkip.
 */
async function readGrantedExtensionPermissions(
    extensionPage: Page,
): Promise<GrantedExtensionPermissions> {
    return extensionPage.evaluate(async () => {
        const chromeApi = Reflect.get(globalThis, 'chrome');
        if (typeof chromeApi !== 'object' || chromeApi === null) {
            throw new Error('Missing chrome API');
        }
        const permissionsApi = Reflect.get(chromeApi, 'permissions');
        if (typeof permissionsApi !== 'object' || permissionsApi === null) {
            throw new Error('Missing chrome.permissions API');
        }
        const getAll = Reflect.get(permissionsApi, 'getAll');
        if (typeof getAll !== 'function') {
            throw new Error('Missing chrome.permissions.getAll API');
        }
        const pendingResult: unknown = Reflect.apply(
            getAll,
            permissionsApi,
            [],
        );
        const result: unknown = await Promise.resolve(pendingResult);
        if (typeof result !== 'object' || result === null) {
            throw new Error('Invalid extension grant snapshot');
        }
        const rawPermissions: unknown = Reflect.get(result, 'permissions');
        const rawOrigins: unknown = Reflect.get(result, 'origins');
        if (!Array.isArray(rawPermissions) || !Array.isArray(rawOrigins)) {
            throw new Error('Incomplete extension grant snapshot');
        }
        const permissions = rawPermissions.filter(
            (value): value is string => typeof value === 'string',
        );
        const origins = rawOrigins.filter(
            (value): value is string => typeof value === 'string',
        );
        return {
            permissions: permissions.sort(),
            origins: origins.sort(),
        };
    });
}

/**
 * Proves the declarative MAIN bundle answers the document-local protocol.
 *
 * @param page - Fresh fixture document receiving both manifest entries.
 * @returns Parsed command-result envelope emitted by the MAIN bridge.
 */
async function probeDeclarativeCaptionBridge(page: Page): Promise<unknown> {
    return page.evaluate(
        async (contract) =>
            new Promise<unknown>((resolve, reject) => {
                const requestId = 'e2e-declarative-main-probe';
                const timeoutId = globalThis.setTimeout(() => {
                    document.removeEventListener(
                        contract.resultEvent,
                        onResult,
                    );
                    reject(new Error('Timed out waiting for MAIN bridge'));
                }, contract.timeoutMs);
                const onResult = (event: Event): void => {
                    if (!(event instanceof CustomEvent)) {
                        return;
                    }
                    const detail: unknown = event.detail;
                    if (typeof detail !== 'string') {
                        return;
                    }
                    const parsed: unknown = JSON.parse(detail) as unknown;
                    if (
                        typeof parsed !== 'object' ||
                        parsed === null ||
                        Reflect.get(parsed, 'requestId') !== requestId
                    ) {
                        return;
                    }
                    globalThis.clearTimeout(timeoutId);
                    document.removeEventListener(
                        contract.resultEvent,
                        onResult,
                    );
                    resolve(parsed);
                };
                document.addEventListener(contract.resultEvent, onResult);
                document.dispatchEvent(
                    new CustomEvent(contract.commandEvent, {
                        detail: JSON.stringify({
                            source: contract.isolatedSource,
                            kind: contract.commandKind,
                            protocolVersion: contract.protocolVersion,
                            requestId,
                            command: contract.probeCommand,
                        }),
                    }),
                );
            }),
        {
            commandEvent: CAPTION_PAGE_BRIDGE_EVENT.Command,
            resultEvent: CAPTION_PAGE_BRIDGE_EVENT.CommandResult,
            isolatedSource: CAPTION_PAGE_BRIDGE_SOURCE.Isolated,
            commandKind: CAPTION_PAGE_BRIDGE_KIND.Command,
            protocolVersion: CAPTION_PAGE_BRIDGE_PROTOCOL_VERSION,
            probeCommand: CAPTION_PAGE_BRIDGE_COMMAND.Probe,
            timeoutMs: 5_000,
        },
    );
}

/**
 * Observable MAIN-world footprint of the declarative caption bridge.
 */
type PageBridgeInstallState = {
    installed: boolean;
    fetchNative: boolean;
    xhrOpenNative: boolean;
    xhrSendNative: boolean;
};

/**
 * Reads whether the MAIN bridge still shadows the page's fetch/XHR.
 *
 * Native functions stringify with `[native code]`; the bridge wrappers are
 * ordinary closures, so the page can tell the two apart without the test
 * having to reach into either extension world.
 *
 * @param page - Fixture document receiving both manifest entries.
 * @returns Install flag plus whether each patched API is native again.
 */
async function readPageBridgeInstallState(
    page: Page,
): Promise<PageBridgeInstallState> {
    return page.evaluate((flags) => {
        const isNative = (value: unknown): boolean =>
            typeof value === 'function' &&
            Function.prototype.toString
                .call(value)
                .includes('[native code]');
        return {
            installed: Reflect.get(globalThis, flags.installFlag) === true,
            fetchNative: isNative(Reflect.get(globalThis, 'fetch')),
            xhrOpenNative: isNative(
                Reflect.get(XMLHttpRequest.prototype, 'open'),
            ),
            xhrSendNative: isNative(
                Reflect.get(XMLHttpRequest.prototype, 'send'),
            ),
        };
    }, { installFlag: CAPTION_PAGE_BRIDGE_INSTALL_FLAG });
}

/**
 * Records the current MAIN bridge's teardown hook on the page.
 *
 * Each bridge generation publishes its own teardown closure, so the identity
 * of that function is the page-visible fingerprint of one installation.
 *
 * @param page - Fixture document whose current bridge should be fingerprinted.
 * @returns Resolves once the reference is stored on the page.
 */
async function markPageBridgeIdentity(page: Page): Promise<void> {
    await page.evaluate(
        (flags) => {
            Reflect.set(
                globalThis,
                flags.markerKey,
                Reflect.get(globalThis, flags.teardownFlag),
            );
        },
        {
            markerKey: PAGE_BRIDGE_IDENTITY_MARKER_KEY,
            teardownFlag: CAPTION_PAGE_BRIDGE_TEARDOWN_FLAG,
        },
    );
}

/**
 * Reports whether the bridge recorded by `markPageBridgeIdentity` is still the
 * one installed on the page.
 *
 * @param page - Fixture document previously fingerprinted.
 * @returns Whether no newer bridge generation replaced the recorded one.
 */
async function isPageBridgeIdentityUnchanged(page: Page): Promise<boolean> {
    return page.evaluate(
        (flags) => {
            const marked: unknown = Reflect.get(globalThis, flags.markerKey);
            return (
                typeof marked === 'function' &&
                Reflect.get(globalThis, flags.teardownFlag) === marked
            );
        },
        {
            markerKey: PAGE_BRIDGE_IDENTITY_MARKER_KEY,
            teardownFlag: CAPTION_PAGE_BRIDGE_TEARDOWN_FLAG,
        },
    );
}

/**
 * Checks whether a retired bridge left its global teardown hook behind.
 *
 * @param page - Fixture document receiving both manifest entries.
 * @returns Whether the MAIN teardown hook is still exposed on the page.
 */
async function readPageBridgeTeardownFlagPresent(page: Page): Promise<boolean> {
    return page.evaluate(
        (flag) => typeof Reflect.get(globalThis, flag) === 'function',
        CAPTION_PAGE_BRIDGE_TEARDOWN_FLAG,
    );
}

/**
 * Reloads the extension from inside its own service worker, exactly as a
 * Web Store update or a manual chrome://extensions Reload would, which orphans
 * every content script already running in open tabs.
 *
 * @param context - Persistent context hosting the unpacked extension.
 * @returns Resolves once the reload was requested; the old worker may already
 *   be gone, so a rejected evaluate is treated as success.
 */
async function reloadExtension(context: BrowserContext): Promise<void> {
    const worker =
        context.serviceWorkers().find((w) => w.url().includes('background')) ??
        (await context.waitForEvent('serviceworker', {
            predicate: (w) => w.url().includes('background'),
            timeout: 30_000,
        }));
    await worker
        .evaluate(() => {
            const chromeApi = Reflect.get(globalThis, 'chrome');
            if (typeof chromeApi !== 'object' || chromeApi === null) {
                throw new Error('Missing chrome API');
            }
            const runtime = Reflect.get(chromeApi, 'runtime');
            if (typeof runtime !== 'object' || runtime === null) {
                throw new Error('Missing chrome.runtime API');
            }
            const reload = Reflect.get(runtime, 'reload');
            if (typeof reload !== 'function') {
                throw new Error('Missing chrome.runtime.reload API');
            }
            Reflect.apply(reload, runtime, []);
        })
        .catch(() => undefined);
}

/**
 * Sends the worker's route probe to the active fixture tab without reading its URL.
 *
 * @param extensionPage - Extension document allowed to call Tabs messaging.
 * @returns Current ISOLATED route-status response.
 */
async function readActiveContentRouteStatus(
    extensionPage: Page,
): Promise<unknown> {
    return extensionPage.evaluate(async (messageType) => {
        const chromeApi = Reflect.get(globalThis, 'chrome');
        if (typeof chromeApi !== 'object' || chromeApi === null) {
            throw new Error('Missing chrome API');
        }
        const tabs = Reflect.get(chromeApi, 'tabs');
        if (typeof tabs !== 'object' || tabs === null) {
            throw new Error('Missing chrome.tabs API');
        }
        const query = Reflect.get(tabs, 'query');
        const sendMessage = Reflect.get(tabs, 'sendMessage');
        if (typeof query !== 'function' || typeof sendMessage !== 'function') {
            throw new Error('Missing chrome.tabs messaging API');
        }
        const pendingTabs: unknown = Reflect.apply(query, tabs, [
            { active: true, currentWindow: true },
        ]);
        const activeTabs: unknown = await Promise.resolve(pendingTabs);
        if (!Array.isArray(activeTabs) || activeTabs.length !== 1) {
            throw new Error('Missing active fixture tab');
        }
        const tabId: unknown = Reflect.get(activeTabs[0], 'id');
        if (typeof tabId !== 'number') {
            throw new Error('Active fixture tab has no id');
        }
        const pendingStatus: unknown = Reflect.apply(sendMessage, tabs, [
            tabId,
            { type: messageType },
        ]);
        return Promise.resolve(pendingStatus);
    }, TOPSKIP_MESSAGE.CONTENT_ROUTE_STATUS);
}

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
            let released = false;
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
                if (released) {
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
                released = true;
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
                            sourceResultId: 'result-e2eFixture1-server-v7',
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

/**
 * Waits until the Diagnostics section left its loading state.
 *
 * @param optionsPage - Options page showing the Diagnostics section.
 * @returns Promise resolving once the switch accepts input.
 */
async function expectDiagnosticsReady(optionsPage: Page): Promise<void> {
    await expect(
        optionsPage.getByRole('switch', { name: DEBUG_LOG_SWITCH_LABEL }),
    ).toBeEnabled({ timeout: DEBUG_LOG_UI_TIMEOUT_MS });
}

/**
 * Drives the Debug logging switch to a state and waits for the status line,
 * so later steps observe background state rather than optimistic UI.
 *
 * @param optionsPage - Options page showing the Diagnostics section.
 * @param enabled - Desired switch state.
 * @returns Promise resolving once the background confirmed the state.
 */
async function setDebugLoggingSwitch(
    optionsPage: Page,
    enabled: boolean,
): Promise<void> {
    const debugSwitch = optionsPage.getByRole('switch', {
        name: DEBUG_LOG_SWITCH_LABEL,
    });
    await expectDiagnosticsReady(optionsPage);
    if ((await debugSwitch.isChecked()) !== enabled) {
        // Mantine hides the native input; force like the popup switch tests.
        await debugSwitch.click({ force: true });
    }
    const status = optionsPage.getByTestId('options-debug-log-status');
    if (enabled) {
        await expect(debugSwitch).toBeChecked({
            timeout: DEBUG_LOG_UI_TIMEOUT_MS,
        });
        await expect(status).toHaveText(DEBUG_LOG_ON_PATTERN, {
            timeout: DEBUG_LOG_UI_TIMEOUT_MS,
        });
        return;
    }
    await expect(debugSwitch).not.toBeChecked({
        timeout: DEBUG_LOG_UI_TIMEOUT_MS,
    });
    await expect(status).toHaveText(DEBUG_LOG_OFF_PATTERN, {
        timeout: DEBUG_LOG_UI_TIMEOUT_MS,
    });
}

type DebugLogBundle = {
    header: string[];
    events: string[];
};

/**
 * Splits an exported bundle into the header block and its event lines.
 *
 * @param text - Bundle text as copied or downloaded.
 * @returns Header lines and event lines.
 */
function splitDebugLogBundle(text: string): DebugLogBundle {
    const lines = text.split('\n');
    const firstEvent = lines.findIndex((line) =>
        DEBUG_LOG_EVENT_LINE_PATTERN.test(line),
    );
    return {
        header: firstEvent === -1 ? lines : lines.slice(0, firstEvent),
        events: lines.filter((line) => DEBUG_LOG_EVENT_LINE_PATTERN.test(line)),
    };
}

/**
 * Reads one `key=value` pair from the header block.
 *
 * @param header - Header lines of a bundle.
 * @param key - Header key without the `=`.
 * @returns The value or `null` when the key is absent.
 */
function readBundleHeaderValue(
    header: readonly string[],
    key: string,
): string | null {
    const pattern = new RegExp(`(?:^|\\s)${key}=(\\S+)`, 'u');
    for (const line of header) {
        const value = pattern.exec(line)?.[1];
        if (value !== undefined) {
            return value;
        }
    }
    return null;
}

/**
 * Reads a header value that must be present.
 *
 * @param header - Header lines of a bundle.
 * @param key - Header key without the `=`.
 * @returns The value.
 */
function requireBundleHeaderValue(
    header: readonly string[],
    key: string,
): string {
    const value = readBundleHeaderValue(header, key);
    if (value === null) {
        throw new Error(`Bundle header lacks ${key}=`);
    }
    return value;
}

/**
 * Removes the snapshot-timestamp header line so two exports of an unchanged
 * log can be compared byte for byte.
 *
 * @param text - Bundle text.
 * @returns The text without the `exportedAt` line.
 */
function stripExportedAtLine(text: string): string {
    const pattern = new RegExp(
        `(?:^|\\s)${DEBUG_LOG_HEADER_EXPORTED_AT}=`,
        'u',
    );
    return text
        .split('\n')
        .filter((line) => !pattern.test(line))
        .join('\n');
}

/**
 * Orders by the timestamp prefix; append order interleaves batched content
 * events with background events, the timestamps restore the logical order.
 *
 * @param left - Event line.
 * @param right - Event line.
 * @returns Sort order of the two lines.
 */
function compareTimestampPrefix(left: string, right: string): number {
    const leftTs = left.slice(0, ISO_TIMESTAMP_LENGTH);
    const rightTs = right.slice(0, ISO_TIMESTAMP_LENGTH);
    if (leftTs < rightTs) {
        return -1;
    }
    if (leftTs > rightTs) {
        return 1;
    }
    return 0;
}

/**
 * Sorts event lines by timestamp (stable for equal timestamps).
 *
 * @param events - Event lines in append order.
 * @returns Event lines in timestamp order.
 */
function sortEventLinesByTimestamp(events: readonly string[]): string[] {
    return [...events].sort(compareTimestampPrefix);
}

/**
 * Matches the event-name token of a formatted line.
 *
 * @param eventName - Event name from the allow-list.
 * @returns Regex matching a whitespace-delimited event token.
 */
function eventLinePattern(eventName: string): RegExp {
    return new RegExp(`\\s${eventName}(?:\\s|$)`, 'u');
}

/**
 * Finds the first line carrying an event (and required `key=value` fields)
 * after a given index.
 *
 * @param events - Event lines.
 * @param eventName - Event name from the allow-list.
 * @param requiredFields - Substrings each matching line must contain.
 * @param after - Only consider lines after this index.
 * @returns Matching index or -1.
 */
function findEventLineIndex(
    events: readonly string[],
    eventName: string,
    requiredFields: readonly string[] = [],
    after = -1,
): number {
    const pattern = eventLinePattern(eventName);
    return events.findIndex(
        (line, index) =>
            index > after &&
            pattern.test(line) &&
            requiredFields.every((field) => line.includes(field)),
    );
}

/**
 * Asserts that the listed events appear in this order (each after the
 * previous match).
 *
 * @param events - Event lines, already in timestamp order.
 * @param steps - Event name followed by required field substrings.
 */
function expectEventsInOrder(
    events: readonly string[],
    steps: ReadonlyArray<readonly [string, ...string[]]>,
): void {
    let previous = -1;
    for (const [eventName, ...fields] of steps) {
        const index = findEventLineIndex(events, eventName, fields, previous);
        expect(
            index,
            `missing ${eventName} ${fields.join(' ')} after line ${previous}`,
        ).toBeGreaterThan(previous);
        previous = index;
    }
}

type PollingBackend = {
    server: Server;
    readyPollSeen: Promise<void>;
};

/**
 * Serves one processing job that turns ready after a fixed number of polls so
 * the content session emits a terminal polling summary; bootstrap routes are
 * shared with the other fixture backends.
 *
 * @param processingPolls - Polls answered `processing` before `ready`.
 * @returns Listening server and a promise for the ready poll.
 */
async function startPollingBackend(
    processingPolls: number,
): Promise<PollingBackend> {
    let polls = 0;
    let resolveReadyPollSeen: () => void = () => {};
    const readyPollSeen = new Promise<void>((resolve) => {
        resolveReadyPollSeen = resolve;
    });
    const processingResponse = {
        status: 'processing',
        ...E2E_TRANSCRIPT_IDENTITY,
        jobId: E2E_POLLING_JOB_ID,
        pollAfterSec: 1,
    };
    const readyResponse = {
        status: 'ready',
        ...E2E_TRANSCRIPT_IDENTITY,
        source: 'server_cache',
        sourceResultId: 'result-e2eFixture1-server-v7',
        freshness: { expiresAtMs: E2E_RESULT_FRESHNESS_EXPIRES_AT_MS },
        promoBlocks: [
            { startSec: 4, endSec: 24, confidence: 'high' },
            { startSec: 35, endSec: 45, confidence: 'medium' },
        ],
    };
    const server = createServer((req, res) => {
        if (handlePublicApiBootstrap(req, res)) {
            return;
        }
        if (req.method === 'POST' && req.url === '/v1/analysis') {
            expectAuthenticatedServerRequest(req);
            req.resume();
            req.on('end', () => {
                res.writeHead(202, JSON_RESPONSE_HEADERS);
                res.end(JSON.stringify(processingResponse));
            });
            return;
        }
        if (
            req.method === 'GET' &&
            req.url === `/v1/analysis/jobs/${E2E_POLLING_JOB_ID}`
        ) {
            expectAuthenticatedServerRequest(req);
            polls += 1;
            if (polls <= processingPolls) {
                res.writeHead(202, JSON_RESPONSE_HEADERS);
                res.end(JSON.stringify(processingResponse));
                return;
            }
            res.writeHead(200, JSON_RESPONSE_HEADERS);
            res.end(JSON.stringify(readyResponse));
            resolveReadyPollSeen();
            return;
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise<void>((resolve) => {
        server.listen(
            Number(E2E_BACKEND_URL.port),
            E2E_BACKEND_URL.hostname,
            () => resolve(),
        );
    });
    return { server, readyPollSeen };
}

/**
 * Closes a fixture backend and waits for the port to free up.
 *
 * @param server - Listening fixture backend.
 * @returns Promise resolving after close.
 */
async function closeBackend(server: Server): Promise<void> {
    await new Promise<void>((resolve) => {
        server.close(() => resolve());
    });
}

/**
 * Loads the fixture in Server mode, waits for the ready poll, then plays from
 * just before the second promo block so exactly one skip decision is logged.
 *
 * @param context - Persistent context hosting the unpacked extension.
 * @param errors - Collector for console/page errors.
 * @param backend - Polling backend started for this flow.
 * @returns The fixture page (still open).
 */
async function runServerPollingFlow(
    context: BrowserContext,
    errors: string[],
    backend: PollingBackend,
): Promise<Page> {
    const page = await context.newPage();
    trackPageErrors(page, 'fixture-debug-log', errors);
    await page.goto('/video.html', { waitUntil: 'domcontentloaded' });
    await backend.readyPollSeen;
    await page.waitForTimeout(BLOCK_DELIVERY_SETTLE_MS);
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
        video.currentTime = 34.5;
        void video.play();
    });
    await expect
        .poll(
            async () =>
                page.evaluate(() => {
                    const video = document.querySelector('video');
                    return video instanceof HTMLVideoElement
                        ? video.currentTime
                        : -1;
                }),
            { timeout: 8_000 },
        )
        .toBeGreaterThan(44);
    // Let the content client flush its batch and the store persist it.
    await page.waitForTimeout(DEBUG_LOG_SETTLE_MS);
    return page;
}

/**
 * Presses Copy log and returns the text the stubbed clipboard received.
 *
 * @param optionsPage - Options page prepared with the capturing clipboard.
 * @returns Bundle text.
 */
async function copyDebugLog(optionsPage: Page): Promise<string> {
    await clearCapturedClipboardText(optionsPage);
    await optionsPage
        .getByRole('button', { name: DEBUG_LOG_COPY_LABEL })
        .click();
    await expect
        .poll(() => readCapturedClipboardText(optionsPage), {
            timeout: DEBUG_LOG_UI_TIMEOUT_MS,
        })
        .not.toBeNull();
    await expect(
        optionsPage.getByTestId('options-debug-log-feedback'),
    ).toHaveText(DEBUG_LOG_COPIED_TEXT, { timeout: DEBUG_LOG_UI_TIMEOUT_MS });
    const text = await readCapturedClipboardText(optionsPage);
    if (text === null) {
        throw new Error('Copy log wrote nothing to the clipboard stub.');
    }
    return text;
}

type DownloadedDebugLog = {
    fileName: string;
    text: string;
};

/**
 * Presses Download log and reads the offered file before the context closes
 * (Playwright deletes downloads with the context).
 *
 * @param optionsPage - Options page showing the Diagnostics section.
 * @returns Suggested file name and file text.
 */
async function downloadDebugLog(optionsPage: Page): Promise<DownloadedDebugLog> {
    const downloadPromise = optionsPage.waitForEvent('download');
    await optionsPage
        .getByRole('button', { name: DEBUG_LOG_DOWNLOAD_LABEL })
        .click();
    const download = await downloadPromise;
    await expect(
        optionsPage.getByTestId('options-debug-log-feedback'),
    ).toHaveText(DEBUG_LOG_DOWNLOAD_STARTED_TEXT, {
        timeout: DEBUG_LOG_UI_TIMEOUT_MS,
    });
    const text = await fs.readFile(await download.path(), 'utf8');
    return { fileName: download.suggestedFilename(), text };
}

/**
 * Runs the repository's standard axe audit (WCAG 2.x A/AA, color-contrast
 * excluded as in the existing audits) and fails with the violations listed.
 *
 * @param page - Page to audit in its current state.
 * @param label - Label for the failure message.
 * @returns Promise resolving when the audit found no violations.
 */
async function expectNoAxeViolations(page: Page, label: string): Promise<void> {
    const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
        .disableRules(['color-contrast'])
        .analyze();
    expect(
        results.violations,
        `${label} axe violations:\n${JSON.stringify(results.violations, null, 2)}`,
    ).toEqual([]);
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
            const grantPage = await context.newPage();
            await grantPage.goto(
                `chrome-extension://${extensionId}/options.html`,
                { waitUntil: 'domcontentloaded' },
            );
            const grantsBeforePopup =
                await readGrantedExtensionPermissions(grantPage);

            const popupPage = await openPopupAndWaitForUi(
                context,
                extensionId,
                errors,
            );
            const grantsAfterPopup =
                await readGrantedExtensionPermissions(popupPage);
            expect(grantsAfterPopup).toEqual(grantsBeforePopup);
            expect(grantsAfterPopup.permissions).toEqual([
                'activeTab',
                'scripting',
                'storage',
                'unlimitedStorage',
            ]);
            for (const providerOrigin of OPTIONAL_PROVIDER_ORIGINS) {
                expect(grantsAfterPopup.origins).not.toContain(providerOrigin);
            }
            await popupPage.close();
            await grantPage.close();

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

    test('extension reload makes orphaned content scripts tear themselves down', async () => {
        const errors: string[] = [];
        const context = await chromium.launchPersistentContext(
            '',
            extensionContextOptions(),
        );

        try {
            trackServiceWorkerConsoleErrors(context, errors);
            await getExtensionId(context);
            const page = await context.newPage();
            trackPageErrors(page, 'orphan-fixture', errors);
            await page.goto('/video.html', { waitUntil: 'domcontentloaded' });

            // Both declarative bundles are live: the MAIN bridge answers and
            // its dormant wrappers shadow the native page APIs.
            await probeDeclarativeCaptionBridge(page);
            const installedState = {
                installed: true,
                fetchNative: false,
                xhrOpenNative: false,
                xhrSendNative: false,
            };
            expect(await readPageBridgeInstallState(page)).toEqual(
                installedState,
            );

            // A healthy context must not be mistaken for an orphan: give the
            // poll several ticks before reloading.
            await page.waitForTimeout(ORPHAN_FALSE_POSITIVE_WINDOW_MS);
            expect(await readPageBridgeInstallState(page)).toEqual(
                installedState,
            );

            await reloadExtension(context);

            // The orphaned ISOLATED bundle notices its severed runtime, tears
            // down, and retires the MAIN bridge: native fetch/XHR are back and
            // no bridge flag remains, all without reloading the page.
            await expect
                .poll(() => readPageBridgeInstallState(page), {
                    timeout: ORPHAN_TEARDOWN_TIMEOUT_MS,
                })
                .toEqual({
                    installed: false,
                    fetchNative: true,
                    xhrOpenNative: true,
                    xhrSendNative: true,
                });
            expect(await readPageBridgeTeardownFlagPresent(page)).toBe(false);

            expectNoCollectedErrors(errors);
        } finally {
            await context.close();
        }
    });

    test('opening the popup leaves a live content context untouched', async () => {
        const errors: string[] = [];
        const context = await chromium.launchPersistentContext(
            '',
            extensionContextOptions(),
        );

        try {
            trackServiceWorkerConsoleErrors(context, errors);
            const extensionId = await getExtensionId(context);
            const page = await context.newPage();
            trackPageErrors(page, 'reattach-live-fixture', errors);
            await page.goto('/video.html', { waitUntil: 'domcontentloaded' });
            await probeDeclarativeCaptionBridge(page);
            await markPageBridgeIdentity(page);

            // Popup start asks the background to re-attach; a tab whose
            // declarative bundles are alive must answer the readiness probe and
            // be left alone, or the user would lose the running analysis
            // session every time they open the popup.
            const popupPage = await openPopupAndWaitForUi(
                context,
                extensionId,
                errors,
                page,
            );
            await expect
                .poll(() => readActiveContentRouteStatus(popupPage), {
                    timeout: POPUP_REATTACH_TIMEOUT_MS,
                })
                .toMatchObject({ ok: true, videoId: E2E_VIDEO_ID });

            // A second MAIN bridge would replace the page's teardown hook and
            // rewrap fetch/XHR, so a stable hook identity proves no injection.
            expect(await isPageBridgeIdentityUnchanged(page)).toBe(true);
            expect(await readPageBridgeInstallState(page)).toEqual({
                installed: true,
                fetchNative: false,
                xhrOpenNative: false,
                xhrSendNative: false,
            });
            await probeDeclarativeCaptionBridge(page);

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

    test('server transcript contract fixture reaches analysis phase', async () => {
        const jobId = 'local-e2eFixture1-server-v7';
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
                page,
            );
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
                        sourceResultId: 'result-e2eFixture1-server-v7',
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
            await expect(
                probeDeclarativeCaptionBridge(page),
            ).resolves.toMatchObject({
                source: CAPTION_PAGE_BRIDGE_SOURCE.Main,
                kind: CAPTION_PAGE_BRIDGE_KIND.CommandResult,
                protocolVersion: CAPTION_PAGE_BRIDGE_PROTOCOL_VERSION,
                requestId: 'e2e-declarative-main-probe',
                result: { ok: true },
            });
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
            const routeProbePage = await context.newPage();
            await routeProbePage.goto(
                `chrome-extension://${extensionId}/options.html`,
                { waitUntil: 'domcontentloaded' },
            );
            await page.bringToFront();
            await expect(
                readActiveContentRouteStatus(routeProbePage),
            ).resolves.toMatchObject({
                ok: true,
                protocolVersion: CONTENT_SCRIPT_PROTOCOL_VERSION,
                extensionVersion: '0.1.0',
                videoId: E2E_VIDEO_ID,
                enabled: true,
                analysisMode: 'server',
                serverSessionId: expect.any(String),
            });
            await routeProbePage.close();

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
                page,
            );
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
        test.setTimeout(45_000);
        const jobId = 'local-e2eFixture1-server-v7';
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
            sourceResultId: 'result-e2eFixture1-server-v7',
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

            const statusPopup = await context.newPage();
            trackPageErrors(statusPopup, 'popup-status-recovery', errors);
            await installRuntimeMessageGate(
                statusPopup,
                GET_DETECTION_STATUS_MESSAGE_TYPE,
            );
            await statusPopup.goto(
                `chrome-extension://${extensionId}/popup.html`,
                { waitUntil: 'domcontentloaded' },
            );
            await waitForPopupUi(statusPopup);
            await waitForHeldRuntimeMessage(statusPopup);
            await page.bringToFront();
            await expect(
                statusPopup.getByText(
                    'TopSkip status could not be loaded.',
                    { exact: true },
                ),
            ).toBeVisible({ timeout: 10_000 });
            await releaseHeldRuntimeMessage(statusPopup);
            await expect(
                statusPopup.getByText('Getting captions'),
            ).toBeVisible({ timeout: 10_000 });

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

            await expect(
                statusPopup.getByText('Server analysis pending'),
            ).toBeVisible({ timeout: 10_000 });

            terminalReady = true;
            await readyPollSeen;
            await page.waitForTimeout(300);

            await expect(
                statusPopup.getByText('2 promo blocks found'),
            ).toBeVisible({ timeout: 10_000 });
            await expect(
                statusPopup.getByText('Server cache hit.', { exact: true }),
            ).toHaveCount(0);
            await expect(
                statusPopup.getByText('0:04 - 0:24', { exact: true }),
            ).toBeVisible();
            await expect(
                statusPopup.getByText('0:35 - 0:45', { exact: true }),
            ).toBeVisible();
            await statusPopup.close();

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
        const jobId = 'local-e2eFixture1-server-v7';
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
        const jobId = 'lost-e2eFixture1-server-v7';
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
                                'result-e2eFixture1-resubmitted-server-v7',
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
                page,
            );
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
            const captionsUnavailableSessionId =
                '00000000-0000-4000-8000-000000000012';
            const captionExtractionFailureSessionId =
                '00000000-0000-4000-8000-000000000013';
            const baseFailureState = {
                videoId: E2E_VIDEO_ID,
                source: 'server',
                serverFailure: {
                    apiVersion: E2E_SERVER_API_VERSION,
                    extensionVersion: '0.1.0',
                },
            } as const;
            await seedPopupState(setupPage, {
                videoId: baseFailureState.videoId,
                sessionId: captionsUnavailableSessionId,
                status: 'analyzing',
                source: 'server',
                serverAnalysisPhase: 'caption_acquisition',
            });
            await seedPopupState(setupPage, {
                ...baseFailureState,
                sessionId: captionsUnavailableSessionId,
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
                setupPage,
            );
            await expect(
                popupPage.getByRole('button', {
                    name: 'Report if this seems wrong',
                }),
            ).toBeVisible();
            await expect(popupPage.getByText(/support id/iu)).toHaveCount(0);

            await seedPopupState(setupPage, {
                videoId: baseFailureState.videoId,
                sessionId: captionExtractionFailureSessionId,
                status: 'analyzing',
                source: 'server',
                serverAnalysisPhase: 'caption_acquisition',
            });
            await seedPopupState(setupPage, {
                ...baseFailureState,
                sessionId: captionExtractionFailureSessionId,
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
                setupPage,
            );

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
                byokWatchPage,
            );
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
                                'result-e2eFixture1-exact-miss-server-v7',
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

    test('disabled-at-load stays inert and re-enable starts one route', async () => {
        let analysisRequestCount = 0;
        const backend = createServer((req, res) => {
            if (handlePublicApiBootstrap(req, res)) {
                return;
            }
            if (req.method === 'POST' && req.url === '/v1/analysis') {
                expectAuthenticatedServerRequest(req);
                analysisRequestCount += 1;
                req.resume();
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(
                    JSON.stringify({
                        status: 'no_promo',
                        ...E2E_TRANSCRIPT_IDENTITY,
                        sourceResultId:
                            'result-e2eFixture1-toggle-server-v7',
                        freshness: { expiresAtMs: 4_102_444_800_000 },
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
            await page.waitForTimeout(1_000);
            expect(analysisRequestCount).toBe(0);

            const enablePopup = await openPopupAndWaitForUi(
                context,
                extensionId,
                errors,
                page,
            );
            await enablePopup
                .getByRole('switch', { name: /enable/i })
                .click({ force: true, timeout: 30_000 });
            await enablePopup.close();
            await expect
                .poll(() => analysisRequestCount, { timeout: 15_000 })
                .toBe(1);
            await page.waitForTimeout(1_000);
            expect(analysisRequestCount).toBe(1);

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
            await new Promise<void>((resolve) => {
                backend.close(() => resolve());
            });
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
                page.getByRole('button', { name: 'Diagnostics' }),
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

            await page.goto(`chrome-extension://${extensionId}/options.html`, {
                waitUntil: 'domcontentloaded',
            });
            await page.getByTestId('options-shell').waitFor({ state: 'visible' });
            // A stored log renders the monospace preview, the widest
            // Diagnostics content; the sidebar click avoids a hash-only
            // navigation (the page reads the hash on load only).
            await seedDebugLog(page, {
                state: DEV_DEBUG_LOG_SEED_STATE.OffStored,
                approxBytes: DEBUG_LOG_OVERFLOW_SEED_BYTES,
            });

            for (const width of [360, 768, 1024]) {
                await page.setViewportSize({ width, height: 900 });
                await page.goto(
                    `chrome-extension://${extensionId}/options.html`,
                    { waitUntil: 'domcontentloaded' },
                );
                await page
                    .getByTestId('options-shell')
                    .waitFor({ state: 'visible' });
                const generalOverflow = await page.evaluate(() => {
                    return (
                        document.documentElement.scrollWidth >
                        document.documentElement.clientWidth
                    );
                });
                expect(
                    generalOverflow,
                    `horizontal overflow at ${width}px`,
                ).toBe(false);

                await page.getByRole('button', { name: 'Diagnostics' }).click();
                await page
                    .getByTestId('options-debug-log-preview')
                    .waitFor({ state: 'visible', timeout: DEBUG_LOG_UI_TIMEOUT_MS });
                const diagnosticsOverflow = await page.evaluate(() => {
                    return (
                        document.documentElement.scrollWidth >
                        document.documentElement.clientWidth
                    );
                });
                expect(
                    diagnosticsOverflow,
                    `horizontal overflow at ${width}px (Diagnostics)`,
                ).toBe(false);
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
            // Dev default is on: the audited popup includes the indicator.
            await expect(
                popupPage.getByTestId('popup-debug-logging-indicator'),
            ).toBeVisible({ timeout: DEBUG_LOG_UI_TIMEOUT_MS });
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

            // --- Options page: Diagnostics in on, off-stored, off-empty ---
            await optionsPage
                .getByRole('button', { name: 'Diagnostics' })
                .click();
            await optionsPage
                .getByTestId('options-diagnostics-section')
                .waitFor({ state: 'visible' });
            await setDebugLoggingSwitch(optionsPage, true);
            await expectNoAxeViolations(optionsPage, 'Diagnostics (on)');
            await setDebugLoggingSwitch(optionsPage, false);
            await expectNoAxeViolations(optionsPage, 'Diagnostics (off, stored)');
            await seedDebugLog(optionsPage, {
                state: DEV_DEBUG_LOG_SEED_STATE.OffEmpty,
            });
            // The status poll (≤ 5 s) picks the seeded state up without reload.
            await expect(
                optionsPage.getByTestId('options-debug-log-status'),
            ).toHaveText(DEBUG_LOG_OFF_EMPTY_TEXT, {
                timeout: DEBUG_LOG_UI_TIMEOUT_MS,
            });
            await expect(
                optionsPage.getByRole('button', { name: DEBUG_LOG_COPY_LABEL }),
            ).toBeDisabled();
            await expectNoAxeViolations(optionsPage, 'Diagnostics (off, empty)');
            await optionsPage.close();

            expectNoCollectedErrors(errors);
        } finally {
            await context.close();
        }
    });

    test('popup shows the debug logging indicator only while enabled', async () => {
        const errors: string[] = [];
        const context = await chromium.launchPersistentContext(
            '',
            extensionContextOptions(),
        );

        try {
            trackServiceWorkerConsoleErrors(context, errors);
            const extensionId = await getExtensionId(context);
            const optionsPage = await openOptionsDiagnostics(
                context,
                extensionId,
                errors,
            );
            await setDebugLoggingSwitch(optionsPage, true);

            const popupOn = await openPopupAndWaitForUi(
                context,
                extensionId,
                errors,
            );
            await popupOn.setViewportSize({ width: 340, height: 700 });
            const indicator = popupOn.getByTestId(
                'popup-debug-logging-indicator',
            );
            await expect(indicator).toBeVisible({
                timeout: DEBUG_LOG_UI_TIMEOUT_MS,
            });
            await expect(indicator).toHaveText(POPUP_DEBUG_LOGGING_TEXT);
            await expect(
                popupOn.getByRole('button', { name: /open options/i }),
            ).toHaveCount(0);
            await expect(popupOn.getByText(/version/i)).toHaveCount(0);
            await expect(popupOn.getByTestId('popup-footer')).toHaveCount(0);
            const horizontalOverflow = await popupOn.evaluate(() => {
                return (
                    document.documentElement.scrollWidth >
                    document.documentElement.clientWidth
                );
            });
            expect(horizontalOverflow).toBe(false);
            await popupOn.close();

            await setDebugLoggingSwitch(optionsPage, false);
            // The deep link reads the hash on load only; it must not flip the
            // switch.
            const deepLinkPage = await openOptionsDiagnostics(
                context,
                extensionId,
                errors,
            );
            await expectDiagnosticsReady(deepLinkPage);
            await expect(
                deepLinkPage.getByRole('switch', {
                    name: DEBUG_LOG_SWITCH_LABEL,
                }),
            ).not.toBeChecked();
            await deepLinkPage.close();

            const popupOff = await openPopupAndWaitForUi(
                context,
                extensionId,
                errors,
            );
            // Wait for a known status so "absent" means "off", not "unknown".
            await expect(
                popupOff.getByTestId('popup-detection-loading'),
            ).toHaveCount(0, { timeout: DEBUG_LOG_UI_TIMEOUT_MS });
            await expect(
                popupOff.getByTestId('popup-debug-logging-indicator'),
            ).toHaveCount(0);
            await popupOff.close();

            expectNoCollectedErrors(errors);
        } finally {
            await context.close();
        }
    });

    test('debug logging records a server-mode fixture flow and exports it', async () => {
        const backend = await startPollingBackend(
            POLLING_BACKEND_PROCESSING_POLLS,
        );
        const errors: string[] = [];
        const context = await chromium.launchPersistentContext(
            '',
            extensionContextOptions(),
        );

        try {
            trackServiceWorkerConsoleErrors(context, errors);
            const extensionId = await getExtensionId(context);
            const optionsPage = await openOptionsDiagnostics(
                context,
                extensionId,
                errors,
                (page) => installClipboardCapture(page, 'capture'),
            );
            // Dev builds start with the switch on; off → on proves that "on"
            // starts a fresh log, so the flow below is the whole log.
            await setDebugLoggingSwitch(optionsPage, false);
            await setDebugLoggingSwitch(optionsPage, true);

            const fixturePage = await runServerPollingFlow(
                context,
                errors,
                backend,
            );
            await optionsPage.bringToFront();

            const copied = await copyDebugLog(optionsPage);
            const bundle = splitDebugLogBundle(copied);
            expect(bundle.header.length).toBeGreaterThan(0);
            expect(
                requireBundleHeaderValue(
                    bundle.header,
                    DEBUG_LOG_HEADER_EXPORTED_AT,
                ),
            ).toMatch(ISO_TIMESTAMP_PATTERN);
            expect(
                Number(
                    requireBundleHeaderValue(
                        bundle.header,
                        DEBUG_LOG_HEADER_EVENTS,
                    ),
                ),
            ).toBe(bundle.events.length);

            const ordered = sortEventLinesByTimestamp(bundle.events);
            expect(ordered[0] ?? '').toMatch(
                eventLinePattern(DEBUG_LOG_EVENT.LoggingEnabled),
            );
            expectEventsInOrder(ordered, [
                [DEBUG_LOG_EVENT.RouteDecision, `v=${E2E_VIDEO_ID}`],
                [DEBUG_LOG_EVENT.AnalysisRequested],
                [DEBUG_LOG_EVENT.HttpStart, 'operation=analysis'],
                [
                    DEBUG_LOG_EVENT.HttpResponse,
                    'operation=analysis',
                    'status=202',
                ],
                [DEBUG_LOG_EVENT.PollSummary, 'terminal=true'],
                [DEBUG_LOG_EVENT.SkipApplied, `v=${E2E_VIDEO_ID}`],
            ]);
            // The background records blocks-delivered only after the content
            // ack round-trip (plus a route re-check and store write), so the
            // back-dated content blocks-received line legitimately sorts a few
            // milliseconds BEFORE it; assert two timestamp-safe chains instead
            // of one delivered→received chain.
            expectEventsInOrder(ordered, [
                [
                    DEBUG_LOG_EVENT.HttpResponse,
                    'operation=analysis',
                    'status=202',
                ],
                [DEBUG_LOG_EVENT.BlocksDelivered],
            ]);
            expectEventsInOrder(ordered, [
                [
                    DEBUG_LOG_EVENT.HttpResponse,
                    'operation=analysis',
                    'status=202',
                ],
                [DEBUG_LOG_EVENT.BlocksReceived],
                [DEBUG_LOG_EVENT.SkipApplied, 'block=', 'toSec='],
            ]);
            // SC-005: bounded volume for a fresh analysis with polls + one skip.
            expect(bundle.events.length).toBeLessThanOrEqual(
                DEBUG_LOG_FRESH_ANALYSIS_MAX_EVENTS,
            );
            // SC-003 (Server success checklist): route-decision,
            // analysis-requested, http-start/http-response, one terminal
            // poll-summary, blocks-delivered, blocks-received, skip-applied are
            // all asserted in order above. The missed-skip checklist
            // (skip-suppressed once per block/reason, seek-summary) is covered
            // by Task D3's unit tests; the Server-failure checklist
            // (terminal-event with failureCode + support id, poll-summary
            // terminal=true) by Task C2's and Task D5's unit tests — no E2E
            // fixture drives a real backend failure.
            const terminalSummaries = ordered.filter(
                (line) =>
                    eventLinePattern(DEBUG_LOG_EVENT.PollSummary).test(line) &&
                    line.includes('terminal=true'),
            );
            expect(terminalSummaries).toHaveLength(1);
            const polls = /polls=(\d+)/u.exec(terminalSummaries[0] ?? '')?.[1];
            expect(Number(polls)).toBeGreaterThanOrEqual(
                POLLING_BACKEND_PROCESSING_POLLS + 1,
            );
            const pollHttpLines = ordered.filter(
                (line) =>
                    line.includes('operation=poll') &&
                    (eventLinePattern(DEBUG_LOG_EVENT.HttpStart).test(line) ||
                        eventLinePattern(DEBUG_LOG_EVENT.HttpResponse).test(
                            line,
                        )),
            );
            expect(pollHttpLines).toEqual([]);
            const skipIndex = findEventLineIndex(
                ordered,
                DEBUG_LOG_EVENT.SkipApplied,
            );
            // Tab attribution token (`t<id>`) on a content-sourced line.
            expect(ordered[skipIndex] ?? '').toMatch(/\st\d+\s/u);

            // Off keeps the log; Copy and Download export the same snapshot
            // apart from the exportedAt header, and the file name is that
            // header's timestamp.
            await setDebugLoggingSwitch(optionsPage, false);
            await expect(
                optionsPage.getByTestId('options-debug-log-status'),
            ).toHaveText(DEBUG_LOG_OFF_STORED_PATTERN);
            await expect(
                optionsPage.getByRole('button', { name: DEBUG_LOG_COPY_LABEL }),
            ).toBeEnabled();
            const copiedWhileOff = await copyDebugLog(optionsPage);
            const offBundle = splitDebugLogBundle(copiedWhileOff);
            expect(offBundle.events.length).toBeGreaterThanOrEqual(
                bundle.events.length,
            );
            expect(offBundle.events.at(-1) ?? '').toMatch(
                eventLinePattern(DEBUG_LOG_EVENT.LoggingDisabled),
            );
            const downloaded = await downloadDebugLog(optionsPage);
            expect(downloaded.fileName).toMatch(DEBUG_LOG_FILE_NAME_PATTERN);
            const downloadedExportedAt = requireBundleHeaderValue(
                splitDebugLogBundle(downloaded.text).header,
                DEBUG_LOG_HEADER_EXPORTED_AT,
            );
            expect(downloadedExportedAt).toMatch(ISO_TIMESTAMP_PATTERN);
            expect(downloaded.fileName).toBe(
                buildDebugLogFileName(new Date(downloadedExportedAt)),
            );
            expect(stripExportedAtLine(downloaded.text)).toBe(
                stripExportedAtLine(copiedWhileOff),
            );

            // On discards the stored log and starts a fresh one.
            await setDebugLoggingSwitch(optionsPage, true);
            const fresh = splitDebugLogBundle(await copyDebugLog(optionsPage));
            expect(fresh.events.length).toBeLessThan(bundle.events.length);
            expect(fresh.events[0] ?? '').toMatch(
                eventLinePattern(DEBUG_LOG_EVENT.LoggingEnabled),
            );
            expect(
                findEventLineIndex(fresh.events, DEBUG_LOG_EVENT.SkipApplied),
            ).toBe(-1);

            await fixturePage.close();
            expectNoCollectedErrors(errors);
        } finally {
            await context.close();
            await closeBackend(backend.server);
        }
    });

    test('debug log copy falls back to download when the clipboard is refused', async () => {
        const errors: string[] = [];
        const context = await chromium.launchPersistentContext(
            '',
            extensionContextOptions(),
        );

        try {
            trackServiceWorkerConsoleErrors(context, errors);
            const extensionId = await getExtensionId(context);

            // Run 1: the clipboard write is refused like a denied permission.
            const rejectingPage = await openOptionsDiagnostics(
                context,
                extensionId,
                errors,
                (page) => installClipboardCapture(page, 'reject'),
            );
            await expectDiagnosticsReady(rejectingPage);
            await rejectingPage
                .getByRole('button', { name: DEBUG_LOG_COPY_LABEL })
                .click();
            await expect(
                rejectingPage.getByTestId('options-debug-log-feedback'),
            ).toHaveText(DEBUG_LOG_COPY_FAILED_TEXT, {
                timeout: DEBUG_LOG_UI_TIMEOUT_MS,
            });
            const downloaded = await downloadDebugLog(rejectingPage);
            expect(downloaded.fileName).toMatch(DEBUG_LOG_FILE_NAME_PATTERN);
            expect(
                splitDebugLogBundle(downloaded.text).events.length,
            ).toBeGreaterThan(0);
            await rejectingPage.close();

            // Run 2: the bundle read is held past the Options timeout.
            const delayedPage = await openOptionsDiagnostics(
                context,
                extensionId,
                errors,
                async (page) => {
                    await installClipboardCapture(page, 'capture');
                    await installRuntimeMessageGate(
                        page,
                        TOPSKIP_MESSAGE.GET_DEBUG_LOG_BUNDLE,
                    );
                },
            );
            await expectDiagnosticsReady(delayedPage);
            await delayedPage
                .getByRole('button', { name: DEBUG_LOG_COPY_LABEL })
                .click();
            await waitForHeldRuntimeMessage(delayedPage);
            await expect(
                delayedPage.getByTestId('options-debug-log-feedback'),
            ).toHaveText(DEBUG_LOG_EXPORT_FAILED_TEXT, {
                timeout: DEBUG_LOG_UI_TIMEOUT_MS,
            });
            await releaseHeldRuntimeMessage(delayedPage);
            await delayedPage.waitForTimeout(DEBUG_LOG_LATE_REPLY_WAIT_MS);
            // The late reply must not be exported silently.
            expect(await readCapturedClipboardText(delayedPage)).toBeNull();
            // A fresh click reads a fresh snapshot.
            const copied = await copyDebugLog(delayedPage);
            expect(splitDebugLogBundle(copied).events.length).toBeGreaterThan(
                0,
            );
            await delayedPage.close();

            expectNoCollectedErrors(errors);
        } finally {
            await context.close();
        }
    });

    test('popup debug logging indicator is hidden while status is unknown', async () => {
        const errors: string[] = [];
        const context = await chromium.launchPersistentContext(
            '',
            extensionContextOptions(),
        );

        try {
            trackServiceWorkerConsoleErrors(context, errors);
            const extensionId = await getExtensionId(context);
            const popupPage = await context.newPage();
            trackPageErrors(popupPage, 'popup-debug-logging-gate', errors);
            await installRuntimeMessageGate(
                popupPage,
                GET_DETECTION_STATUS_MESSAGE_TYPE,
            );
            await popupPage.goto(
                `chrome-extension://${extensionId}/popup.html`,
                { waitUntil: 'domcontentloaded' },
            );
            await waitForPopupUi(popupPage);
            await waitForHeldRuntimeMessage(popupPage);
            await expect(
                popupPage.getByTestId('popup-detection-loading'),
            ).toBeVisible();
            await expect(
                popupPage.getByTestId('popup-debug-logging-indicator'),
            ).toHaveCount(0);

            await releaseHeldRuntimeMessage(popupPage);
            // Dev builds default the switch on, so the released status
            // carries `debugLoggingEnabled: true`.
            const indicator = popupPage.getByTestId(
                'popup-debug-logging-indicator',
            );
            await expect(indicator).toBeVisible({
                timeout: DEBUG_LOG_UI_TIMEOUT_MS,
            });
            await expect(indicator).toHaveText(POPUP_DEBUG_LOGGING_TEXT);
            await popupPage.close();

            expectNoCollectedErrors(errors);
        } finally {
            await context.close();
        }
    });

    test('issue report body hints at the debug log only when a log exists', async () => {
        const errors: string[] = [];
        const context = await chromium.launchPersistentContext(
            '',
            extensionContextOptions(),
        );

        try {
            trackServiceWorkerConsoleErrors(context, errors);
            const extensionId = await getExtensionId(context);
            const setupPage = await context.newPage();
            trackPageErrors(setupPage, 'options-issue-hint', errors);
            await setupPage.goto(
                `chrome-extension://${extensionId}/options.html`,
                { waitUntil: 'domcontentloaded' },
            );
            await setupPage
                .getByTestId('options-shell')
                .waitFor({ state: 'visible' });
            await seedPopupState(setupPage, {
                videoId: E2E_VIDEO_ID,
                sessionId: '00000000-0000-4000-8000-000000000031',
                status: 'error',
                source: 'server',
                serverFailure: {
                    code: 'internal_error',
                    supportId: 'support-e2e-debug-log',
                    apiVersion: E2E_SERVER_API_VERSION,
                    extensionVersion: '0.1.0',
                },
            });
            const popupPage = await openPopupAndWaitForUi(
                context,
                extensionId,
                errors,
                setupPage,
            );
            await expect(
                popupPage.getByRole('button', { name: 'Report on GitHub' }),
            ).toBeVisible({ timeout: DEBUG_LOG_UI_TIMEOUT_MS });

            // Dev builds start with the switch on, so a log exists.
            const withLogUrl = await captureIssueReportUrl(
                context,
                popupPage,
                setupPage,
            );
            const bodyWithLog =
                new URL(withLogUrl).searchParams.get('body') ?? '';
            expect(bodyWithLog).toContain(DEBUG_LOG_ISSUE_HINT_PREFIX);
            expect(bodyWithLog).toContain('Support ID: support-e2e-debug-log');
            expect(bodyWithLog).not.toContain(E2E_VIDEO_ID);
            // The log itself never rides in the URL.
            expect(withLogUrl).not.toMatch(/worker-started|logging-enabled/u);

            await seedDebugLog(setupPage, {
                state: DEV_DEBUG_LOG_SEED_STATE.OffEmpty,
            });
            const withoutLogUrl = await captureIssueReportUrl(
                context,
                popupPage,
                setupPage,
            );
            const bodyWithoutLog =
                new URL(withoutLogUrl).searchParams.get('body') ?? '';
            expect(bodyWithoutLog).not.toContain('Debug logging');
            expect(bodyWithoutLog).not.toContain(E2E_VIDEO_ID);
            // B14's `buildUrl` appends exactly one line (FR-039), no blank.
            expect(bodyWithLog.split('\n')).toHaveLength(
                bodyWithoutLog.split('\n').length + 1,
            );
            await popupPage.close();

            expectNoCollectedErrors(errors);
        } finally {
            await context.close();
        }
    });

    test('debug log ring buffer evicts at the cap and bounds the preview', async () => {
        const errors: string[] = [];
        const context = await chromium.launchPersistentContext(
            '',
            extensionContextOptions(),
        );

        try {
            trackServiceWorkerConsoleErrors(context, errors);
            const extensionId = await getExtensionId(context);
            const optionsPage = await openOptionsDiagnostics(
                context,
                extensionId,
                errors,
                (page) => installClipboardCapture(page, 'capture'),
            );
            await expectDiagnosticsReady(optionsPage);
            await seedDebugLog(optionsPage, {
                state: DEV_DEBUG_LOG_SEED_STATE.On,
                approxBytes: DEBUG_LOG_CAP_BYTES,
            });

            const fixturePage = await context.newPage();
            trackPageErrors(fixturePage, 'fixture-debug-log-cap', errors);
            for (let visit = 0; visit < FIXTURE_VISITS_PAST_CAP; visit += 1) {
                await fixturePage.goto('/video.html', {
                    waitUntil: 'domcontentloaded',
                });
                await fixturePage.waitForTimeout(DEBUG_LOG_SETTLE_MS);
            }
            await fixturePage.close();
            await optionsPage.bringToFront();

            const persistedBytes = await readDebugLogStorageBytes(
                context,
                STORAGE_KEY_DEBUG_LOG_PREFIX,
            );
            expect(persistedBytes).toBeGreaterThan(0);
            expect(persistedBytes).toBeLessThanOrEqual(
                DEBUG_LOG_CAP_BYTES + DEBUG_LOG_PERSISTED_OVERHEAD_BYTES,
            );

            const section = optionsPage.getByTestId(
                'options-diagnostics-section',
            );
            await expect(
                section.getByText(DEBUG_LOG_EVICTED_COUNTER_PATTERN),
            ).toBeVisible({ timeout: DEBUG_LOG_UI_TIMEOUT_MS });
            await expect(
                section.getByText(DEBUG_LOG_PREVIEW_TRUNCATED_PATTERN),
            ).toBeVisible({ timeout: DEBUG_LOG_UI_TIMEOUT_MS });
            const preview = optionsPage.getByTestId('options-debug-log-preview');
            await expect(preview).toBeVisible();
            const previewScrolls = await preview.evaluate(
                (element) => element.scrollHeight > element.clientHeight,
            );
            expect(previewScrolls).toBe(true);

            const bundle = splitDebugLogBundle(await copyDebugLog(optionsPage));
            expect(
                Number(
                    requireBundleHeaderValue(
                        bundle.header,
                        DEBUG_LOG_HEADER_EVICTED,
                    ),
                ),
            ).toBeGreaterThan(0);
            expect(
                requireBundleHeaderValue(
                    bundle.header,
                    DEBUG_LOG_HEADER_OLDEST_RETAINED,
                ),
            ).toMatch(ISO_TIMESTAMP_PATTERN);
            expect(
                Number(
                    requireBundleHeaderValue(
                        bundle.header,
                        DEBUG_LOG_HEADER_EVENTS,
                    ),
                ),
            ).toBe(bundle.events.length);

            for (const width of [360, 768, 1024]) {
                await optionsPage.setViewportSize({ width, height: 900 });
                const hasOverflow = await optionsPage.evaluate(() => {
                    return (
                        document.documentElement.scrollWidth >
                        document.documentElement.clientWidth
                    );
                });
                expect(
                    hasOverflow,
                    `horizontal overflow at ${width}px with a capped log`,
                ).toBe(false);
            }
            await optionsPage.close();

            expectNoCollectedErrors(errors);
        } finally {
            await context.close();
        }
    });

    test('exported debug log contains no fixture caption text, backend origin, or parameter values', async () => {
        const backend = await startPollingBackend(
            POLLING_BACKEND_PROCESSING_POLLS,
        );
        const errors: string[] = [];
        const context = await chromium.launchPersistentContext(
            '',
            extensionContextOptions(),
        );

        try {
            trackServiceWorkerConsoleErrors(context, errors);
            const extensionId = await getExtensionId(context);
            const optionsPage = await openOptionsDiagnostics(
                context,
                extensionId,
                errors,
                (page) => installClipboardCapture(page, 'capture'),
            );
            await setDebugLoggingSwitch(optionsPage, true);
            const fixturePage = await runServerPollingFlow(
                context,
                errors,
                backend,
            );
            await optionsPage.bringToFront();

            const copied = await copyDebugLog(optionsPage);
            const bundle = splitDebugLogBundle(copied);
            // The flow ran and the bundle legitimately names the video id …
            expect(copied).toContain(`v=${E2E_VIDEO_ID}`);
            expect(
                findEventLineIndex(bundle.events, DEBUG_LOG_EVENT.SkipApplied),
            ).toBeGreaterThan(-1);
            // … but none of the free-form inputs that passed through it.
            expect(copied).not.toContain(E2E_CAPTION_SEGMENTS[0].text);
            expect(copied).not.toContain(E2E_BACKEND_HOST_SENTINEL);
            expect(copied).not.toContain(E2E_INSTALLATION_TOKEN);
            expect(copied).not.toContain(E2E_TRANSCRIPT_HASH);
            expect(copied).not.toMatch(/https?:\/\//u);
            expect(copied).not.toMatch(/[?&][A-Za-z_]+=/u);
            for (const match of copied.matchAll(/urlParams=(\S*)/gu)) {
                expect(match[1] ?? '').not.toContain('=');
            }

            await fixturePage.close();
            expectNoCollectedErrors(errors);
        } finally {
            await context.close();
            await closeBackend(backend.server);
        }
    });
});
