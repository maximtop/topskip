import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSendMessage } = vi.hoisted(() => ({
    mockSendMessage: vi.fn(),
}));

vi.mock('@/shared/browser', () => ({
    default: {
        runtime: {
            sendMessage: mockSendMessage,
        },
    },
}));

vi.mock('@/shared/constants', async (importOriginal) => {
    const constants =
        await importOriginal<typeof import('@/shared/constants')>();
    return {
        ...constants,
        CAPTION_CAPTURE_VERBOSE_LOGS: true,
    };
});

import { PlayerCaptionCapture } from '@/content/captions/player-caption-capture';
import { WatchCaptions } from '@/content/watch-captions';
import { TOPSKIP_MESSAGE } from '@/shared/messages';

const PAGE_EVENT = 'topskip:caption-capture-page';

type WindowListener = (event: MessageEvent<unknown>) => void;
type BridgeTransport = 'window' | 'document';

class TestMessageEvent<T = unknown> {
    readonly type: string;

    readonly data: T | undefined;

    readonly source: unknown;

    constructor(type: string, init: { data?: T; source?: unknown } = {}) {
        this.type = type;
        this.data = init.data;
        this.source = init.source;
    }
}

class TestCustomEvent<T = unknown> extends Event {
    readonly detail: T | undefined;

    constructor(type: string, init: { detail?: T } = {}) {
        super(type);
        this.detail = init.detail;
    }
}

function installWindowStub(): void {
    const listeners = new Map<string, WindowListener[]>();
    const fakeWindow = {
        location: { origin: 'https://www.youtube.com' },
        addEventListener: vi.fn((type: string, listener: WindowListener) => {
            const existing = listeners.get(type) ?? [];
            existing.push(listener);
            listeners.set(type, existing);
        }),
        removeEventListener: vi.fn((type: string, listener: WindowListener) => {
            const existing = listeners.get(type) ?? [];
            listeners.set(
                type,
                existing.filter((item) => item !== listener),
            );
        }),
        dispatchEvent: vi.fn((event: MessageEvent<unknown>) => {
            for (const listener of listeners.get(event.type) ?? []) {
                listener(event);
            }
            return true;
        }),
        postMessage: vi.fn(),
    };
    Object.defineProperty(globalThis, 'window', {
        configurable: true,
        value: fakeWindow,
    });
    Object.defineProperty(globalThis, 'MessageEvent', {
        configurable: true,
        value: TestMessageEvent,
    });
    Object.defineProperty(globalThis, 'CustomEvent', {
        configurable: true,
        value: TestCustomEvent,
    });
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: new EventTarget(),
    });
}

async function flushMicrotasks(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
}

async function acceptActivation(): Promise<void> {
    await flushMicrotasks();
    await flushMicrotasks();
}

async function finishCleanup(): Promise<void> {
    await flushMicrotasks();
    await flushMicrotasks();
}

function dispatchTimedtextCapture(
    videoId: string,
    body: string,
    messageId?: string,
    transport: BridgeTransport = 'window',
): void {
    const data = {
        source: 'TOPSKIP_CAPTION_CAPTURE_PAGE',
        kind: 'timedtext-capture',
        messageId,
        videoId,
        languageCode: 'en',
        contentType: 'application/json; charset=UTF-8',
        bodyLength: body.length,
        urlShape: {
            pathname: '/api/timedtext',
            paramNames: ['fmt', 'lang', 'v'],
            fmt: 'json3',
            hasPot: false,
        },
        body,
    };
    if (transport === 'document') {
        document.dispatchEvent(
            new CustomEvent(PAGE_EVENT, { detail: JSON.stringify(data) }),
        );
        return;
    }
    window.dispatchEvent(
        new MessageEvent('message', {
            source: window,
            data,
        }),
    );
}

function dispatchPageDiagnostic(
    messageId?: string,
    transport: BridgeTransport = 'window',
): void {
    const data = {
        source: 'TOPSKIP_CAPTION_CAPTURE_PAGE',
        kind: 'diagnostic',
        messageId,
        stage: 'timedtext-empty-body',
        videoId: 'abc',
        languageCode: 'en',
        transport: 'xhr',
        status: 200,
        bodyLength: 0,
        urlShape: {
            pathname: '/api/timedtext',
            paramNames: ['fmt', 'lang', 'pot', 'v'],
            fmt: 'json3',
            hasPot: true,
        },
    };
    if (transport === 'document') {
        document.dispatchEvent(
            new CustomEvent(PAGE_EVENT, { detail: JSON.stringify(data) }),
        );
        return;
    }
    window.dispatchEvent(
        new MessageEvent('message', {
            source: window,
            data,
        }),
    );
}

function countRuntimeMessages(type: string): number {
    return mockSendMessage.mock.calls.filter((call) => {
        const message: unknown = Reflect.get(call, '0');
        return (
            message !== null &&
            typeof message === 'object' &&
            Reflect.get(message, 'type') === type
        );
    }).length;
}

function countContentLogStage(stage: string): number {
    return mockSendMessage.mock.calls.filter((call) => {
        const message: unknown = Reflect.get(call, '0');
        if (message === null || typeof message !== 'object') {
            return false;
        }
        if (Reflect.get(message, 'type') !== TOPSKIP_MESSAGE.CONTENT_LOG) {
            return false;
        }
        const args: unknown = Reflect.get(message, 'args');
        if (!Array.isArray(args)) {
            return false;
        }
        const fields: unknown = Reflect.get(args, '1');
        return (
            fields !== null &&
            typeof fields === 'object' &&
            Reflect.get(fields, 'stage') === stage
        );
    }).length;
}

describe('PlayerCaptionCapture', () => {
    beforeEach(() => {
        installWindowStub();
        PlayerCaptionCapture.resetForTest();
        mockSendMessage.mockReset();
        mockSendMessage.mockResolvedValue({ ok: true });
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('installs the page bridge before starting capture', async () => {
        const run = PlayerCaptionCapture.captureForVideoId('abc', {
            captureTimeoutMs: 10,
        });
        await acceptActivation();
        await vi.advanceTimersByTimeAsync(20);
        await finishCleanup();
        await run;
        expect(mockSendMessage).toHaveBeenCalledWith({
            type: TOPSKIP_MESSAGE.INSTALL_CAPTION_CAPTURE,
        });
    });

    it('sends a structured timeout failure when no capture arrives', async () => {
        const run = PlayerCaptionCapture.captureForVideoId('abc', {
            captureTimeoutMs: 10,
        });
        await acceptActivation();
        await vi.advanceTimersByTimeAsync(20);
        await finishCleanup();
        await run;
        expect(mockSendMessage).toHaveBeenCalledWith({
            type: TOPSKIP_MESSAGE.CAPTIONS_FROM_CONTENT,
            payload: {
                ok: false,
                videoId: 'abc',
                reason: 'capture-timeout',
                error: 'Caption capture timed out',
                diagnostics: { stage: 'waiting-capture' },
            },
        });
    });

    it('does not install the bridge for null video ids', () => {
        PlayerCaptionCapture.scheduleForVideoId(null, 'test');
        expect(mockSendMessage).not.toHaveBeenCalledWith({
            type: TOPSKIP_MESSAGE.INSTALL_CAPTION_CAPTURE,
        });
    });

    it('dedupes repeated schedules for the same video id', () => {
        PlayerCaptionCapture.scheduleForVideoId('abc', 'first');
        PlayerCaptionCapture.scheduleForVideoId('abc', 'second');
        expect(PlayerCaptionCapture.getScheduledVideoIdForTest()).toBe('abc');
    });

    it('relays safe page diagnostics to the content log channel', async () => {
        PlayerCaptionCapture.installBridgeForPage();
        dispatchPageDiagnostic('bridge:1');
        await flushMicrotasks();
        expect(mockSendMessage).toHaveBeenCalledWith({
            type: TOPSKIP_MESSAGE.CONTENT_LOG,
            level: 'info',
            args: [
                'caption-capture',
                {
                    stage: 'page:timedtext-empty-body',
                    videoId: 'abc',
                    languageCode: 'en',
                    transport: 'xhr',
                    status: 200,
                    bodyLength: 0,
                    urlShape: {
                        pathname: '/api/timedtext',
                        paramNames: ['fmt', 'lang', 'pot', 'v'],
                        fmt: 'json3',
                        hasPot: true,
                    },
                },
            ],
        });
    });

    it('logs one diagnostic received over both page transports', async () => {
        PlayerCaptionCapture.installBridgeForPage();
        dispatchPageDiagnostic('bridge:7');
        dispatchPageDiagnostic('bridge:7', 'document');
        await flushMicrotasks();

        expect(countContentLogStage('page:timedtext-empty-body')).toBe(1);
    });

    it('parses captured json3 and sends one successful payload', async () => {
        const raw = JSON.stringify({
            events: [
                {
                    tStartMs: 1000,
                    dDurationMs: 2000,
                    segs: [{ utf8: 'sponsor message' }],
                },
            ],
        });

        const run = PlayerCaptionCapture.captureForVideoId('abc', {
            captureTimeoutMs: 1000,
        });

        await acceptActivation();
        dispatchTimedtextCapture('abc', raw, 'bridge:11');
        dispatchTimedtextCapture('abc', raw, 'bridge:11', 'document');
        await finishCleanup();

        await run;

        expect(mockSendMessage).toHaveBeenCalledWith({
            type: TOPSKIP_MESSAGE.CAPTIONS_FROM_CONTENT,
            payload: {
                ok: true,
                videoId: 'abc',
                languageCode: 'en',
                segments: [
                    { startSec: 1, durationSec: 2, text: 'sponsor message' },
                ],
                diagnostics: {
                    stage: 'parsed',
                    bodyLength: raw.length,
                    segmentCount: 1,
                    languageCode: 'en',
                    urlShape: {
                        pathname: '/api/timedtext',
                        paramNames: ['fmt', 'lang', 'v'],
                        fmt: 'json3',
                        hasPot: false,
                    },
                },
            },
        });
        expect(
            countRuntimeMessages(TOPSKIP_MESSAGE.CAPTIONS_FROM_CONTENT),
        ).toBe(1);
        expect(countContentLogStage('capture-event-ignored')).toBe(0);
    });

    it('calls deactivate after capture timeout', async () => {
        const run = PlayerCaptionCapture.captureForVideoId('abc', {
            captureTimeoutMs: 10,
        });
        await acceptActivation();
        await vi.advanceTimersByTimeAsync(20);
        await finishCleanup();
        await run;
        expect(mockSendMessage).toHaveBeenCalledWith({
            type: TOPSKIP_MESSAGE.DEACTIVATE_CAPTION_CAPTURE,
        });
    });

    it('ignores duplicate captures for the same video after success', async () => {
        const raw = JSON.stringify({
            events: [{ tStartMs: 0, dDurationMs: 1, segs: [{ utf8: 'x' }] }],
        });
        const first = PlayerCaptionCapture.captureForVideoId('abc', {
            captureTimeoutMs: 1000,
        });
        await acceptActivation();
        dispatchTimedtextCapture('abc', raw);
        dispatchTimedtextCapture('abc', raw);
        await finishCleanup();
        await first;
        const successMessages = mockSendMessage.mock.calls.filter((call) => {
            const msg: unknown = call[0];
            if (msg === null || typeof msg !== 'object') {
                return false;
            }
            const payload: unknown = Reflect.get(msg, 'payload');
            return (
                Reflect.get(msg, 'type') ===
                    TOPSKIP_MESSAGE.CAPTIONS_FROM_CONTENT &&
                payload !== null &&
                typeof payload === 'object' &&
                Reflect.get(payload, 'ok') === true
            );
        });
        expect(successMessages).toHaveLength(1);
    });

    it('retries activation while the player is not ready', async () => {
        let activationCalls = 0;
        mockSendMessage.mockImplementation((message: unknown) => {
            if (
                message !== null &&
                typeof message === 'object' &&
                Reflect.get(message, 'type') ===
                    TOPSKIP_MESSAGE.ACTIVATE_CAPTION_CAPTURE
            ) {
                activationCalls += 1;
                if (activationCalls === 1) {
                    return Promise.resolve({
                        ok: false,
                        reason: 'player-not-ready',
                        error: 'Watch player is not ready for caption capture',
                    });
                }
            }
            return Promise.resolve({ ok: true });
        });
        const run = PlayerCaptionCapture.captureForVideoId('abc', {
            captureTimeoutMs: 10,
        });
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(250);
        await vi.advanceTimersByTimeAsync(20);
        await finishCleanup();
        await run;
        const activationMessages = mockSendMessage.mock.calls.filter((item) => {
            const message: unknown = item[0];
            return (
                message !== null &&
                typeof message === 'object' &&
                Reflect.get(message, 'type') ===
                    TOPSKIP_MESSAGE.ACTIVATE_CAPTION_CAPTURE
            );
        });
        expect(activationMessages).toHaveLength(2);
    });

    it('logs safe activation details from the page bridge result', async () => {
        mockSendMessage.mockImplementation((message: unknown) => {
            if (
                message !== null &&
                typeof message === 'object' &&
                Reflect.get(message, 'type') ===
                    TOPSKIP_MESSAGE.ACTIVATE_CAPTION_CAPTURE
            ) {
                return Promise.resolve({
                    ok: true,
                    wasOn: false,
                    userIntervened: false,
                    hasTracks: 2,
                    actions: [
                        'hide-style-added',
                        'loadModule:captions',
                        'setOption:track',
                        'toggleSubtitlesOn',
                    ],
                });
            }
            return Promise.resolve({ ok: true });
        });

        const run = PlayerCaptionCapture.captureForVideoId('abc', {
            captureTimeoutMs: 10,
        });
        await acceptActivation();
        await vi.advanceTimersByTimeAsync(20);
        await finishCleanup();
        await run;

        expect(mockSendMessage).toHaveBeenCalledWith({
            type: TOPSKIP_MESSAGE.CONTENT_LOG,
            level: 'info',
            args: [
                'caption-capture',
                {
                    stage: 'activation-accepted',
                    videoId: 'abc',
                    attempt: 1,
                    ok: true,
                    wasOn: false,
                    userIntervened: false,
                    hasTracks: 2,
                    actions: [
                        'hide-style-added',
                        'loadModule:captions',
                        'setOption:track',
                        'toggleSubtitlesOn',
                    ],
                },
            ],
        });
    });

    it('sends a structured activation failure when captions are unavailable', async () => {
        mockSendMessage.mockImplementation((message: unknown) => {
            if (
                message !== null &&
                typeof message === 'object' &&
                Reflect.get(message, 'type') ===
                    TOPSKIP_MESSAGE.ACTIVATE_CAPTION_CAPTURE
            ) {
                return Promise.resolve({
                    ok: false,
                    reason: 'captions-unavailable',
                    error: 'Caption controls are unavailable',
                });
            }
            return Promise.resolve({ ok: true });
        });
        const run = PlayerCaptionCapture.captureForVideoId('abc', {
            captureTimeoutMs: 1000,
        });
        await flushMicrotasks();
        await finishCleanup();
        await run;
        expect(mockSendMessage).toHaveBeenCalledWith({
            type: TOPSKIP_MESSAGE.CAPTIONS_FROM_CONTENT,
            payload: {
                ok: false,
                videoId: 'abc',
                reason: 'captions-unavailable',
                error: 'Caption controls are unavailable',
                diagnostics: { stage: 'activating' },
            },
        });
    });

    it('returns ready failed or cancelled', async () => {
        const readyController = new AbortController();
        const raw = JSON.stringify({
            events: [
                {
                    tStartMs: 1000,
                    dDurationMs: 2000,
                    segs: [{ utf8: 'sponsor message' }],
                },
            ],
        });
        const readyRun = PlayerCaptionCapture.capture({
            videoId: 'ready-video',
            signal: readyController.signal,
            captureTimeoutMs: 1000,
        });
        await acceptActivation();
        dispatchTimedtextCapture('ready-video', raw);
        await finishCleanup();

        await expect(readyRun).resolves.toMatchObject({
            status: 'ready',
            payload: {
                ok: true,
                videoId: 'ready-video',
                languageCode: 'en',
                segments: [
                    { startSec: 1, durationSec: 2, text: 'sponsor message' },
                ],
            },
        });

        mockSendMessage.mockImplementation((message: unknown) => {
            if (
                message !== null &&
                typeof message === 'object' &&
                Reflect.get(message, 'type') ===
                    TOPSKIP_MESSAGE.ACTIVATE_CAPTION_CAPTURE
            ) {
                return Promise.resolve({
                    ok: false,
                    reason: 'captions-unavailable',
                    error: 'Caption controls are unavailable',
                });
            }
            return Promise.resolve({ ok: true });
        });
        await expect(
            PlayerCaptionCapture.capture({
                videoId: 'failed-video',
                signal: new AbortController().signal,
                captureTimeoutMs: 1000,
            }),
        ).resolves.toEqual({
            status: 'failed',
            failure: {
                reason: 'captions-unavailable',
                message: 'Caption controls are unavailable',
                diagnostics: { stage: 'activating' },
            },
        });

        mockSendMessage.mockResolvedValue({ ok: true });
        const cancelledController = new AbortController();
        const cancelledRun = PlayerCaptionCapture.capture({
            videoId: 'cancelled-video',
            signal: cancelledController.signal,
            captureTimeoutMs: 1000,
        });
        await acceptActivation();
        cancelledController.abort();
        await finishCleanup();

        await expect(cancelledRun).resolves.toEqual({ status: 'cancelled' });
        await vi.advanceTimersByTimeAsync(2000);
        const lateTimeoutMessages = mockSendMessage.mock.calls.filter(
            (call) => {
                const message: unknown = call[0];
                if (message === null || typeof message !== 'object') {
                    return false;
                }
                const payload: unknown = Reflect.get(message, 'payload');
                return (
                    Reflect.get(message, 'type') ===
                        TOPSKIP_MESSAGE.CAPTIONS_FROM_CONTENT &&
                    payload !== null &&
                    typeof payload === 'object' &&
                    Reflect.get(payload, 'reason') === 'capture-timeout'
                );
            },
        );
        expect(lateTimeoutMessages).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('dedupes only inside one capture session', async () => {
        const raw = JSON.stringify({
            events: [
                {
                    tStartMs: 0,
                    dDurationMs: 1000,
                    segs: [{ utf8: 'promo' }],
                },
            ],
        });
        const firstRun = PlayerCaptionCapture.capture({
            videoId: 'same-video',
            signal: new AbortController().signal,
            captureTimeoutMs: 1000,
        });
        await acceptActivation();
        dispatchTimedtextCapture('same-video', raw);
        dispatchTimedtextCapture('same-video', raw);
        await finishCleanup();
        await expect(firstRun).resolves.toMatchObject({ status: 'ready' });

        const secondRun = PlayerCaptionCapture.capture({
            videoId: 'same-video',
            signal: new AbortController().signal,
            captureTimeoutMs: 1000,
        });
        await acceptActivation();
        dispatchTimedtextCapture('same-video', raw);
        await finishCleanup();
        await expect(secondRun).resolves.toMatchObject({ status: 'ready' });

        const emptyRun = PlayerCaptionCapture.capture({
            videoId: 'empty-video',
            signal: new AbortController().signal,
            captureTimeoutMs: 1000,
        });
        await acceptActivation();
        dispatchTimedtextCapture('empty-video', JSON.stringify({ events: [] }));
        await finishCleanup();
        await expect(emptyRun).resolves.toMatchObject({
            status: 'failed',
            failure: { reason: 'captions-unavailable' },
        });

        const malformedRun = PlayerCaptionCapture.capture({
            videoId: 'malformed-video',
            signal: new AbortController().signal,
            captureTimeoutMs: 1000,
        });
        await acceptActivation();
        dispatchTimedtextCapture('malformed-video', '{malformed');
        await finishCleanup();
        await expect(malformedRun).resolves.toMatchObject({
            status: 'failed',
            failure: { reason: 'parse-failed' },
        });

        const cleanupMessages = mockSendMessage.mock.calls.filter((call) => {
            const message: unknown = call[0];
            return (
                message !== null &&
                typeof message === 'object' &&
                Reflect.get(message, 'type') ===
                    TOPSKIP_MESSAGE.DEACTIVATE_CAPTION_CAPTURE
            );
        });
        expect(cleanupMessages).toHaveLength(4);
    });

    it('cancels a superseded session before starting the next capture', async () => {
        const firstController = new AbortController();
        const firstRun = PlayerCaptionCapture.capture({
            videoId: 'first-video',
            signal: firstController.signal,
            captureTimeoutMs: 1000,
        });
        await acceptActivation();

        firstController.abort();
        const secondRun = PlayerCaptionCapture.capture({
            videoId: 'second-video',
            signal: new AbortController().signal,
            captureTimeoutMs: 1000,
        });
        await acceptActivation();
        dispatchTimedtextCapture(
            'second-video',
            JSON.stringify({
                events: [
                    {
                        tStartMs: 0,
                        dDurationMs: 1000,
                        segs: [{ utf8: 'next session' }],
                    },
                ],
            }),
        );
        await finishCleanup();

        await expect(firstRun).resolves.toEqual({ status: 'cancelled' });
        await expect(secondRun).resolves.toMatchObject({
            status: 'ready',
            payload: { videoId: 'second-video' },
        });
    });

    it('returns cancelled while bridge installation remains pending', async () => {
        let finishInstall: ((value: { ok: true }) => void) | undefined;
        mockSendMessage.mockImplementation((message: unknown) => {
            if (
                message !== null &&
                typeof message === 'object' &&
                Reflect.get(message, 'type') ===
                    TOPSKIP_MESSAGE.INSTALL_CAPTION_CAPTURE
            ) {
                return new Promise((resolve) => {
                    finishInstall = resolve;
                });
            }
            return Promise.resolve({ ok: true });
        });
        const controller = new AbortController();
        const run = PlayerCaptionCapture.capture({
            videoId: 'pending-install-video',
            signal: controller.signal,
            captureTimeoutMs: 1000,
        });
        const observed = vi.fn();
        void run.then(observed);

        controller.abort();
        await finishCleanup();
        expect(observed).toHaveBeenCalledWith({ status: 'cancelled' });

        finishInstall?.({ ok: true });
        await finishCleanup();
        await expect(run).resolves.toEqual({ status: 'cancelled' });
    });

    it('returns timed captions through the watch facade', async () => {
        const raw = JSON.stringify({
            events: [
                {
                    tStartMs: 250,
                    dDurationMs: 750,
                    segs: [{ utf8: 'facade transcript' }],
                },
            ],
        });
        const run = WatchCaptions.capture({
            videoId: 'facade-video',
            signal: new AbortController().signal,
            captureTimeoutMs: 1000,
            hostname: 'www.youtube.com',
        });
        await acceptActivation();
        dispatchTimedtextCapture('facade-video', raw);
        await finishCleanup();

        await expect(run).resolves.toMatchObject({
            status: 'ready',
            payload: {
                videoId: 'facade-video',
                languageCode: 'en',
                segments: [
                    {
                        startSec: 0.25,
                        durationSec: 0.75,
                        text: 'facade transcript',
                    },
                ],
            },
        });

        await expect(
            WatchCaptions.capture({
                videoId: 'e2eFixture1',
                signal: new AbortController().signal,
                hostname: '127.0.0.1',
            }),
        ).resolves.toMatchObject({
            status: 'ready',
            payload: {
                videoId: 'e2eFixture1',
                languageCode: 'en',
                segments: [
                    {
                        startSec: 0,
                        durationSec: 1,
                        text: 'TopSkip deterministic caption fixture',
                    },
                ],
            },
        });

        const cancelledE2e = new AbortController();
        cancelledE2e.abort();
        await expect(
            WatchCaptions.capture({
                videoId: 'e2eFixture1',
                signal: cancelledE2e.signal,
                hostname: '127.0.0.1',
            }),
        ).resolves.toEqual({ status: 'cancelled' });
    });
});
