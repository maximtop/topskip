import { readFileSync } from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    CAPTION_PAGE_BRIDGE_ACTIVE_LEASE_MS,
    CAPTION_PAGE_BRIDGE_COMMAND,
    CAPTION_PAGE_BRIDGE_EVENT,
    CAPTION_PAGE_BRIDGE_KIND,
    CAPTION_PAGE_BRIDGE_PROTOCOL_VERSION,
    CAPTION_PAGE_BRIDGE_SOURCE,
    type CaptionPageBridgeCommand,
    parseCaptionPageBridgeCommandResult,
} from '@/content/captions/caption-page-bridge-contract';

// `expect.stringMatching` is typed `any`; widening it to `unknown` keeps the
// expected diagnostic literal free of unsafe-assignment errors.
const MESSAGE_ID_SHAPE: unknown = expect.stringMatching(/^[^:]+:\d+$/u);
const INSTALL_FLAG = '__topskipCaptionCaptureInstalled';
const TEARDOWN_FLAG = '__topskipCaptionCaptureTeardown';
const TIMEDTEXT_URL =
    'https://www.youtube.com/api/timedtext?v=video-1&lang=en&fmt=json3';
const TIMEDTEXT_BODY = '{"events":[]}';
const MOVIE_PLAYER_ID = 'movie_player';
const HIDE_STYLE_ID = 'topskip-caption-hide-style';

class TestCustomEvent<T = unknown> extends Event {
    readonly detail: T | undefined;

    constructor(type: string, init: { detail?: T } = {}) {
        super(type);
        this.detail = init.detail;
    }
}

class TestElement extends EventTarget {
    id = '';

    textContent: string | null = null;

    offsetParent: object | null = {};

    readonly classList = {
        contains: vi.fn(() => false),
    };

    private readonly attributes = new Map<string, string>();

    private removeHandler: (() => void) | null = null;

    setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
    }

    getAttribute(name: string): string | null {
        return this.attributes.get(name) ?? null;
    }

    setRemoveHandler(handler: () => void): void {
        this.removeHandler = handler;
    }

    remove(): void {
        this.removeHandler?.();
    }

    click(): void {
        this.dispatchEvent(new Event('click'));
    }
}

class TestVideoElement extends TestElement {
    readyState = 1;
}

class TestMediaElement extends TestVideoElement {
    static readonly HAVE_METADATA = 1;
}

class TestXmlHttpRequest extends EventTarget {
    static readonly originalOpen = vi.fn();

    static readonly originalSend = vi.fn();

    response: unknown = '';

    responseText = '';

    responseURL = '';

    status = 0;

    open(...args: unknown[]): void {
        TestXmlHttpRequest.originalOpen(...args);
    }

    send(...args: unknown[]): void {
        TestXmlHttpRequest.originalSend(...args);
    }

    getResponseHeader(): string | null {
        return 'application/json';
    }
}

type FetchResponseHarness = {
    response: Response;
    clone: ReturnType<typeof vi.fn>;
    text: ReturnType<typeof vi.fn>;
};

type BridgeHarness = {
    button: TestElement;
    originalFetch: ReturnType<typeof vi.fn>;
    captures: unknown[];
    diagnostics: unknown[];
    commandResults: unknown[];
    toggleOn: ReturnType<typeof vi.fn>;
    toggleOff: ReturnType<typeof vi.fn>;
    setOption: ReturnType<typeof vi.fn>;
    originalXhrOpen: unknown;
    originalXhrSend: unknown;
};

class TestDocument extends EventTarget {
    readonly documentElement: { append: (element: TestElement) => void };

    readonly player: TestElement;

    readonly button: TestElement;

    readonly video = new TestMediaElement();

    private readonly elementsById = new Map<string, TestElement>();

    constructor(player: TestElement, button: TestElement) {
        super();
        this.player = player;
        this.button = button;
        this.documentElement = {
            append: (element) => {
                if (element.id.length === 0) {
                    return;
                }
                this.elementsById.set(element.id, element);
                element.setRemoveHandler(() => {
                    this.elementsById.delete(element.id);
                });
            },
        };
    }

    getElementById(id: string): TestElement | null {
        if (id === MOVIE_PLAYER_ID) {
            return this.player;
        }
        return this.elementsById.get(id) ?? null;
    }

    querySelector(selector: string): TestElement | null {
        if (selector === '.ytp-subtitles-button[aria-pressed]') {
            return this.button;
        }
        if (selector.includes('video.html5-main-video')) {
            return this.video;
        }
        return null;
    }

    createElement(): TestElement {
        return new TestElement();
    }
}

function createResponse(
    body: string | Promise<string> = TIMEDTEXT_BODY,
): FetchResponseHarness {
    const text = vi.fn(() => Promise.resolve(body));
    const clone = vi.fn(() => ({ text }));
    const response = new Response(null, {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
    Object.defineProperty(response, 'url', { value: TIMEDTEXT_URL });
    Object.defineProperty(response, 'clone', { value: clone });
    return { response, clone, text };
}

function installHarness(captionsInitiallyOn = false): BridgeHarness {
    const button = new TestElement();
    button.setAttribute(
        'aria-pressed',
        captionsInitiallyOn ? 'true' : 'false',
    );
    const toggleOn = vi.fn(() => {
        button.setAttribute('aria-pressed', 'true');
    });
    const toggleOff = vi.fn(() => {
        button.setAttribute('aria-pressed', 'false');
    });
    const setOption = vi.fn();
    const player = Object.assign(new TestElement(), {
        loadModule: vi.fn(),
        unloadModule: vi.fn(),
        getOption: vi.fn(() => []),
        setOption,
        toggleSubtitlesOn: toggleOn,
        toggleSubtitlesOff: toggleOff,
    });
    const documentHarness = new TestDocument(player, button);
    const originalFetch = vi.fn();
    const windowHarness = Object.assign(new EventTarget(), {
        location: {
            origin: 'https://www.youtube.com',
            href: 'https://www.youtube.com/watch?v=video-1',
        },
        fetch: originalFetch,
        postMessage: vi.fn(),
    });
    const captures: unknown[] = [];
    const diagnostics: unknown[] = [];
    const commandResults: unknown[] = [];
    documentHarness.addEventListener(
        CAPTION_PAGE_BRIDGE_EVENT.PageMessage,
        (event) => {
            if (!(event instanceof CustomEvent)) {
                return;
            }
            const message = JSON.parse(String(event.detail)) as unknown;
            const kind: unknown =
                message !== null && typeof message === 'object'
                    ? Reflect.get(message, 'kind')
                    : undefined;
            if (kind === 'diagnostic') {
                diagnostics.push(message);
                return;
            }
            captures.push(message);
        },
    );
    documentHarness.addEventListener(
        CAPTION_PAGE_BRIDGE_EVENT.CommandResult,
        (event) => {
            if (event instanceof CustomEvent) {
                commandResults.push(event.detail);
            }
        },
    );

    Object.defineProperty(globalThis, 'CustomEvent', {
        configurable: true,
        value: TestCustomEvent,
    });
    Object.defineProperty(globalThis, 'Element', {
        configurable: true,
        value: TestElement,
    });
    Object.defineProperty(globalThis, 'HTMLElement', {
        configurable: true,
        value: TestElement,
    });
    Object.defineProperty(globalThis, 'HTMLMediaElement', {
        configurable: true,
        value: TestMediaElement,
    });
    Object.defineProperty(globalThis, 'XMLHttpRequest', {
        configurable: true,
        value: TestXmlHttpRequest,
    });
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: documentHarness,
    });
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: windowHarness,
    });
    Object.defineProperty(globalThis, 'location', {
        configurable: true,
        value: windowHarness.location,
    });

    return {
        button,
        originalFetch,
        captures,
        diagnostics,
        commandResults,
        toggleOn,
        toggleOff,
        setOption,
        originalXhrOpen: Reflect.get(TestXmlHttpRequest.prototype, 'open'),
        originalXhrSend: Reflect.get(TestXmlHttpRequest.prototype, 'send'),
    };
}

async function installBridge(): Promise<void> {
    vi.resetModules();
    await import('@/content/captions/caption-page-bridge');
}

function sendCommand(
    command: CaptionPageBridgeCommand,
    requestId = `${command}-request`,
): void {
    document.dispatchEvent(
        new CustomEvent(CAPTION_PAGE_BRIDGE_EVENT.Command, {
            detail: JSON.stringify({
                source: CAPTION_PAGE_BRIDGE_SOURCE.Isolated,
                kind: CAPTION_PAGE_BRIDGE_KIND.Command,
                protocolVersion: CAPTION_PAGE_BRIDGE_PROTOCOL_VERSION,
                requestId,
                command,
            }),
        }),
    );
}

function readLastCommandResult(harness: BridgeHarness): unknown {
    const detail = harness.commandResults.at(-1);
    const result = parseCaptionPageBridgeCommandResult(detail);
    if (result === null) {
        throw new Error('Expected a valid caption bridge result');
    }
    return result.result;
}

function teardownBridge(): void {
    const teardown: unknown = Reflect.get(globalThis, TEARDOWN_FLAG);
    if (typeof teardown === 'function') {
        Reflect.apply(teardown, undefined, []);
    }
}

async function flushCapture(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

function diagnosticStages(harness: BridgeHarness): unknown[] {
    return harness.diagnostics.map((message): unknown =>
        message !== null && typeof message === 'object'
            ? Reflect.get(message, 'stage')
            : undefined,
    );
}

describe('caption page bridge', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        TestXmlHttpRequest.originalOpen.mockReset();
        TestXmlHttpRequest.originalSend.mockReset();
    });

    afterEach(() => {
        teardownBridge();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('keeps matching fetches untouched while dormant', async () => {
        const harness = installHarness();
        const response = createResponse();
        harness.originalFetch.mockResolvedValue(response.response);
        await installBridge();

        const returned = await window.fetch(TIMEDTEXT_URL);
        await flushCapture();

        expect(returned).toBe(response.response);
        expect(response.clone).not.toHaveBeenCalled();
        expect(response.text).not.toHaveBeenCalled();
        expect(harness.captures).toEqual([]);
    });

    it('captures only in the active generation and returns dormant on deactivate', async () => {
        const harness = installHarness();
        const first = createResponse();
        const second = createResponse();
        harness.originalFetch
            .mockResolvedValueOnce(first.response)
            .mockResolvedValueOnce(second.response);
        await installBridge();

        sendCommand(CAPTION_PAGE_BRIDGE_COMMAND.Activate);
        expect(readLastCommandResult(harness)).toMatchObject({ ok: true });
        await window.fetch(TIMEDTEXT_URL);
        await flushCapture();
        expect(harness.captures).toHaveLength(1);

        sendCommand(CAPTION_PAGE_BRIDGE_COMMAND.Deactivate);
        await window.fetch(TIMEDTEXT_URL);
        await flushCapture();

        expect(second.clone).not.toHaveBeenCalled();
        expect(harness.captures).toHaveLength(1);
    });

    it('does not read a response that settles after deactivation', async () => {
        const harness = installHarness();
        const response = createResponse();
        let resolveFetch: ((value: Response) => void) | undefined;
        const pendingFetch = new Promise<Response>((resolve) => {
            resolveFetch = resolve;
        });
        harness.originalFetch.mockReturnValue(pendingFetch);
        await installBridge();
        sendCommand(CAPTION_PAGE_BRIDGE_COMMAND.Activate);

        const request = window.fetch(TIMEDTEXT_URL);
        sendCommand(CAPTION_PAGE_BRIDGE_COMMAND.Deactivate);
        resolveFetch?.(response.response);
        await request;
        await flushCapture();

        expect(response.clone).not.toHaveBeenCalled();
        expect(response.text).not.toHaveBeenCalled();
        expect(harness.captures).toEqual([]);
    });

    it('discards a body read from an earlier activation generation', async () => {
        const harness = installHarness();
        let resolveBody: ((value: string) => void) | undefined;
        const body = new Promise<string>((resolve) => {
            resolveBody = resolve;
        });
        const stale = createResponse(body);
        const fresh = createResponse();
        harness.originalFetch
            .mockResolvedValueOnce(stale.response)
            .mockResolvedValueOnce(fresh.response);
        await installBridge();

        sendCommand(CAPTION_PAGE_BRIDGE_COMMAND.Activate, 'first');
        await window.fetch(TIMEDTEXT_URL);
        await flushCapture();
        expect(stale.text).toHaveBeenCalledOnce();

        sendCommand(CAPTION_PAGE_BRIDGE_COMMAND.Activate, 'second');
        resolveBody?.(TIMEDTEXT_BODY);
        await flushCapture();
        expect(harness.captures).toEqual([]);

        await window.fetch(TIMEDTEXT_URL);
        await flushCapture();
        expect(harness.captures).toHaveLength(1);
    });

    it('keeps XHR dormant and rejects completion from a stale generation', async () => {
        const harness = installHarness();
        await installBridge();
        const dormantResponseRead = vi.fn(() => TIMEDTEXT_BODY);
        const dormant = new TestXmlHttpRequest();
        Object.defineProperty(dormant, 'response', {
            configurable: true,
            get: dormantResponseRead,
        });
        dormant.status = 200;
        dormant.responseURL = TIMEDTEXT_URL;
        dormant.open('GET', TIMEDTEXT_URL);
        dormant.send();
        dormant.dispatchEvent(new Event('loadend'));
        expect(dormantResponseRead).not.toHaveBeenCalled();

        sendCommand(CAPTION_PAGE_BRIDGE_COMMAND.Activate, 'xhr-first');
        const staleResponseRead = vi.fn(() => TIMEDTEXT_BODY);
        const stale = new TestXmlHttpRequest();
        Object.defineProperty(stale, 'response', {
            configurable: true,
            get: staleResponseRead,
        });
        stale.status = 200;
        stale.responseURL = TIMEDTEXT_URL;
        stale.open('GET', TIMEDTEXT_URL);
        stale.send();

        sendCommand(CAPTION_PAGE_BRIDGE_COMMAND.Activate, 'xhr-second');
        stale.dispatchEvent(new Event('loadend'));
        expect(staleResponseRead).not.toHaveBeenCalled();
        expect(harness.captures).toEqual([]);

        const fresh = new TestXmlHttpRequest();
        fresh.response = TIMEDTEXT_BODY;
        fresh.status = 200;
        fresh.responseURL = TIMEDTEXT_URL;
        fresh.open('GET', TIMEDTEXT_URL);
        fresh.send();
        fresh.dispatchEvent(new Event('loadend'));
        expect(harness.captures).toHaveLength(1);
    });

    it.each([
        [false, 1],
        [true, 0],
    ] as const)(
        'preserves the first caption snapshot across repeated activation when initially %s',
        async (initiallyOn, expectedToggleOffCalls) => {
            const harness = installHarness(initiallyOn);
            await installBridge();

            sendCommand(CAPTION_PAGE_BRIDGE_COMMAND.Activate, 'first');
            sendCommand(CAPTION_PAGE_BRIDGE_COMMAND.Activate, 'second');
            await vi.advanceTimersByTimeAsync(
                CAPTION_PAGE_BRIDGE_ACTIVE_LEASE_MS,
            );

            expect(harness.button.getAttribute('aria-pressed')).toBe(
                initiallyOn ? 'true' : 'false',
            );
            expect(harness.toggleOff).toHaveBeenCalledTimes(
                expectedToggleOffCalls,
            );
            expect(harness.setOption).toHaveBeenCalledWith(
                'captions',
                'reload',
                true,
            );
            expect(document.getElementById(HIDE_STYLE_ID)).toBeNull();
        },
    );

    it('restores wrappers and removes its command listener on teardown', async () => {
        const harness = installHarness();
        await installBridge();
        expect(Reflect.get(window, 'fetch')).not.toBe(harness.originalFetch);
        expect(Reflect.get(XMLHttpRequest.prototype, 'open')).not.toBe(
            harness.originalXhrOpen,
        );
        expect(Reflect.get(XMLHttpRequest.prototype, 'send')).not.toBe(
            harness.originalXhrSend,
        );

        teardownBridge();
        const resultCount = harness.commandResults.length;
        sendCommand(CAPTION_PAGE_BRIDGE_COMMAND.Probe, 'after-teardown');

        expect(Reflect.get(window, 'fetch')).toBe(harness.originalFetch);
        expect(Reflect.get(XMLHttpRequest.prototype, 'open')).toBe(
            harness.originalXhrOpen,
        );
        expect(Reflect.get(XMLHttpRequest.prototype, 'send')).toBe(
            harness.originalXhrSend,
        );
        expect(harness.commandResults).toHaveLength(resultCount);
    });

    it('retires itself and acknowledges the teardown command', async () => {
        const harness = installHarness();
        await installBridge();
        sendCommand(CAPTION_PAGE_BRIDGE_COMMAND.Activate);
        expect(harness.button.getAttribute('aria-pressed')).toBe('true');

        sendCommand(CAPTION_PAGE_BRIDGE_COMMAND.Teardown, 'orphan-teardown');

        expect(readLastCommandResult(harness)).toEqual({ ok: true });
        expect(harness.button.getAttribute('aria-pressed')).toBe('false');
        expect(document.getElementById(HIDE_STYLE_ID)).toBeNull();
        expect(Reflect.get(window, 'fetch')).toBe(harness.originalFetch);
        expect(Reflect.get(XMLHttpRequest.prototype, 'open')).toBe(
            harness.originalXhrOpen,
        );
        expect(Reflect.get(XMLHttpRequest.prototype, 'send')).toBe(
            harness.originalXhrSend,
        );
        expect(Reflect.get(globalThis, INSTALL_FLAG)).toBe(false);
        expect(Reflect.get(globalThis, TEARDOWN_FLAG)).toBeUndefined();

        const resultCount = harness.commandResults.length;
        sendCommand(CAPTION_PAGE_BRIDGE_COMMAND.Probe, 'after-orphan-teardown');
        expect(harness.commandResults).toHaveLength(resultCount);
    });

    it('clears an active generation and restores its first snapshot once on teardown', async () => {
        const harness = installHarness();
        const response = createResponse();
        let resolveFetch: ((value: Response) => void) | undefined;
        const pendingFetch = new Promise<Response>((resolve) => {
            resolveFetch = resolve;
        });
        harness.originalFetch.mockReturnValue(pendingFetch);
        await installBridge();
        sendCommand(CAPTION_PAGE_BRIDGE_COMMAND.Activate);
        const pendingRequest = window.fetch(TIMEDTEXT_URL);
        expect(harness.button.getAttribute('aria-pressed')).toBe('true');
        expect(document.getElementById(HIDE_STYLE_ID)).not.toBeNull();

        teardownBridge();
        teardownBridge();
        resolveFetch?.(response.response);
        await pendingRequest;
        await flushCapture();

        expect(harness.button.getAttribute('aria-pressed')).toBe('false');
        expect(harness.toggleOff).toHaveBeenCalledOnce();
        expect(document.getElementById(HIDE_STYLE_ID)).toBeNull();
        expect(response.clone).not.toHaveBeenCalled();
        expect(harness.captures).toEqual([]);
    });

    it('bounds a page-authored activation to the local lease', async () => {
        const harness = installHarness();
        await installBridge();

        sendCommand(CAPTION_PAGE_BRIDGE_COMMAND.Activate, 'page-authored');
        expect(harness.captures).toEqual([]);
        expect(harness.button.getAttribute('aria-pressed')).toBe('true');

        await vi.advanceTimersByTimeAsync(
            CAPTION_PAGE_BRIDGE_ACTIVE_LEASE_MS,
        );
        expect(harness.button.getAttribute('aria-pressed')).toBe('false');
        expect(harness.captures).toEqual([]);
    });

    it('posts timedtext diagnostics only inside the active generation, without the verbose define', async () => {
        const harness = installHarness();
        const dormant = createResponse();
        const active = createResponse();
        const afterDeactivate = createResponse();
        harness.originalFetch
            .mockResolvedValueOnce(dormant.response)
            .mockResolvedValueOnce(active.response)
            .mockResolvedValueOnce(afterDeactivate.response);
        await installBridge();
        expect(harness.diagnostics).toEqual([]);

        await window.fetch(TIMEDTEXT_URL);
        await flushCapture();
        expect(harness.diagnostics).toEqual([]);

        sendCommand(CAPTION_PAGE_BRIDGE_COMMAND.Activate);
        await window.fetch(TIMEDTEXT_URL);
        await flushCapture();
        expect(diagnosticStages(harness)).toEqual([
            'activation-finished',
            'timedtext-observed',
            'timedtext-forwarded',
        ]);
        for (const message of harness.diagnostics) {
            expect(message).toMatchObject({
                source: CAPTION_PAGE_BRIDGE_SOURCE.Main,
                kind: 'diagnostic',
                messageId: MESSAGE_ID_SHAPE,
            });
            expect(message).not.toHaveProperty('body');
            expect(JSON.stringify(message)).not.toContain('lang=en');
        }
        expect(harness.diagnostics[1]).toMatchObject({
            transport: 'fetch',
            status: 200,
            videoId: 'video-1',
            languageCode: 'en',
            urlShape: {
                pathname: '/api/timedtext',
                paramNames: ['fmt', 'lang', 'v'],
                fmt: 'json3',
                hasPot: false,
            },
        });

        sendCommand(CAPTION_PAGE_BRIDGE_COMMAND.Deactivate);
        await window.fetch(TIMEDTEXT_URL);
        await flushCapture();
        expect(harness.diagnostics).toHaveLength(3);
        expect(harness.captures).toHaveLength(1);
    });

    it('keeps install-time and cleanup diagnostics dev-only', async () => {
        const harness = installHarness();
        await installBridge();
        sendCommand(CAPTION_PAGE_BRIDGE_COMMAND.Deactivate);
        await flushCapture();

        expect(harness.diagnostics).toEqual([]);
    });

    it('never imports the debug-log switch into the MAIN world', () => {
        const source = readFileSync(
            new URL(
                '../../../src/content/captions/caption-page-bridge.ts',
                import.meta.url,
            ),
            'utf8',
        );
        expect(source).not.toMatch(/debug-log|DebugLogClient|DEBUG_LOG_/u);
    });
});
