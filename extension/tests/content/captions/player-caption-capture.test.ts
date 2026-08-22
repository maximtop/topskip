import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
    mockActivateBridge,
    mockDeactivateBridge,
    mockDisposeBridge,
    mockProbeBridge,
    mockSendMessage,
    mockTeardownBridge,
} = vi.hoisted(() => ({
    mockActivateBridge: vi.fn(),
    mockDeactivateBridge: vi.fn(),
    mockDisposeBridge: vi.fn(),
    mockProbeBridge: vi.fn(),
    mockSendMessage: vi.fn(),
    mockTeardownBridge: vi.fn(),
}));

vi.mock('@/content/captions/caption-page-bridge-client', () => ({
    CaptionPageBridgeClient: {
        activate: mockActivateBridge,
        deactivate: mockDeactivateBridge,
        dispose: mockDisposeBridge,
        probe: mockProbeBridge,
        teardown: mockTeardownBridge,
    },
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
        return (
            Reflect.get(args, '0') === 'caption-capture' &&
            Reflect.get(args, '1') === stage
        );
    }).length;
}

describe('PlayerCaptionCapture', () => {
    beforeEach(async () => {
        installWindowStub();
        await PlayerCaptionCapture.resetForTest();
        mockActivateBridge.mockReset();
        mockDeactivateBridge.mockReset();
        mockDisposeBridge.mockReset();
        mockProbeBridge.mockReset();
        mockTeardownBridge.mockReset();
        mockActivateBridge.mockResolvedValue({ ok: true });
        mockDeactivateBridge.mockResolvedValue({ ok: true });
        mockProbeBridge.mockResolvedValue({ ok: true });
        mockTeardownBridge.mockResolvedValue({ ok: true });
        mockSendMessage.mockReset();
        mockSendMessage.mockResolvedValue({ ok: true });
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('captures through the local bridge while runtime scripting is unavailable', async () => {
        mockSendMessage.mockImplementation((message: unknown) => {
            const messageType: unknown =
                message !== null && typeof message === 'object'
                    ? Reflect.get(message, 'type')
                    : null;
            if (messageType === TOPSKIP_MESSAGE.CONTENT_LOG) {
                return Promise.resolve({ ok: true });
            }
            return Promise.reject(new Error('worker route unavailable'));
        });
        const run = PlayerCaptionCapture.capture({
            videoId: 'abc',
            signal: new AbortController().signal,
            captureTimeoutMs: 1000,
        });
        await acceptActivation();
        dispatchTimedtextCapture(
            'abc',
            JSON.stringify({
                events: [
                    {
                        tStartMs: 0,
                        dDurationMs: 1000,
                        segs: [{ utf8: 'local bridge' }],
                    },
                ],
            }),
        );
        await finishCleanup();
        await expect(run).resolves.toMatchObject({
            status: 'ready',
        });
        expect(mockProbeBridge).toHaveBeenCalledOnce();
        expect(mockActivateBridge).toHaveBeenCalledOnce();
        expect(mockDeactivateBridge).toHaveBeenCalledOnce();
        const runtimeTypes = mockSendMessage.mock.calls.map((call) => {
            const message: unknown = call[0];
            if (message === null || typeof message !== 'object') {
                return null;
            }
            const messageType: unknown = Reflect.get(message, 'type');
            return typeof messageType === 'string' ? messageType : null;
        });
        expect(runtimeTypes.length).toBeGreaterThan(0);
        expect(
            runtimeTypes.every(
                (messageType) => messageType === TOPSKIP_MESSAGE.CONTENT_LOG,
            ),
        ).toBe(true);
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

    it('does not confirm the bridge for null video ids', () => {
        PlayerCaptionCapture.scheduleForVideoId(null, 'test');
        expect(mockProbeBridge).not.toHaveBeenCalled();
    });

    it.each(['safe failure', 'rejection'] as const)(
        'retries bridge readiness after a first %s',
        async (firstOutcome) => {
            if (firstOutcome === 'safe failure') {
                mockProbeBridge.mockResolvedValueOnce({
                    ok: false,
                    reason: 'bridge-install-failed',
                    error: 'Caption bridge is unavailable',
                });
            } else {
                mockProbeBridge.mockRejectedValueOnce(
                    new Error('worker context replaced'),
                );
            }
            mockProbeBridge.mockResolvedValue({ ok: true });

            PlayerCaptionCapture.prepareBridgeForPage();
            await flushMicrotasks();
            PlayerCaptionCapture.prepareBridgeForPage();
            await flushMicrotasks();
            PlayerCaptionCapture.prepareBridgeForPage();
            await flushMicrotasks();

            expect(mockProbeBridge).toHaveBeenCalledTimes(2);
        },
    );

    it('dedupes repeated schedules for the same video id', () => {
        PlayerCaptionCapture.scheduleForVideoId('abc', 'first');
        PlayerCaptionCapture.scheduleForVideoId('abc', 'second');
        expect(PlayerCaptionCapture.getScheduledVideoIdForTest()).toBe('abc');
    });

    it('allows the same video to retry after a transient player-not-ready result', async () => {
        let activationCalls = 0;
        mockActivateBridge.mockImplementation(() => {
            activationCalls += 1;
            if (activationCalls === 1) {
                return Promise.resolve({
                    ok: false,
                    reason: 'player-not-ready',
                    error: 'Watch player is not ready for caption capture',
                });
            }
            return Promise.resolve({ ok: true });
        });

        PlayerCaptionCapture.scheduleForVideoId('abc', 'initial', {
            captureTimeoutMs: 10,
        });
        await flushMicrotasks();
        await finishCleanup();
        await finishCleanup();
        PlayerCaptionCapture.scheduleForVideoId('abc', 'player-ready', {
            captureTimeoutMs: 10,
        });
        await flushMicrotasks();

        expect(activationCalls).toBe(2);
    });

    it('relays safe page diagnostics to the content log channel', async () => {
        PlayerCaptionCapture.prepareBridgeForPage();
        dispatchPageDiagnostic('bridge:1');
        await flushMicrotasks();
        expect(mockSendMessage).toHaveBeenCalledWith({
            type: TOPSKIP_MESSAGE.CONTENT_LOG,
            level: 'info',
            args: [
                'caption-capture',
                'page:timedtext-empty-body',
                'transport=xhr videoId=abc languageCode=en status=200 ' +
                    'bodyLength=0 urlShape={"pathname":"/api/timedtext",' +
                    '"paramNames":["fmt","lang","pot","v"],"fmt":"json3",' +
                    '"hasPot":true}',
            ],
        });
    });

    it('logs one diagnostic received over both page transports', async () => {
        PlayerCaptionCapture.prepareBridgeForPage();
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
        expect(mockDeactivateBridge).toHaveBeenCalledOnce();
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
        mockActivateBridge.mockImplementation(() => {
            activationCalls += 1;
            if (activationCalls === 1) {
                return Promise.resolve({
                    ok: false,
                    reason: 'player-not-ready',
                    error: 'Watch player is not ready for caption capture',
                });
            }
            return Promise.resolve({ ok: true });
        });
        const run = PlayerCaptionCapture.captureForVideoId('abc', {
            captureTimeoutMs: 300,
        });
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(250);
        await vi.advanceTimersByTimeAsync(100);
        await finishCleanup();
        await run;
        expect(mockActivateBridge).toHaveBeenCalledTimes(2);
    });

    it('logs safe activation details from the page bridge result', async () => {
        mockActivateBridge.mockResolvedValue({
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
                'activation-accepted',
                'videoId=abc attempt=1 ok=true wasOn=false ' +
                    'userIntervened=false hasTracks=2 ' +
                    'actions=["hide-style-added","loadModule:captions",' +
                    '"setOption:track","toggleSubtitlesOn"]',
            ],
        });
    });

    it('sends a structured activation failure when captions are unavailable', async () => {
        mockActivateBridge.mockResolvedValue({
            ok: false,
            reason: 'captions-unavailable',
            error: 'Caption controls are unavailable',
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

        mockActivateBridge.mockResolvedValue({
            ok: false,
            reason: 'captions-unavailable',
            error: 'Caption controls are unavailable',
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

        mockActivateBridge.mockResolvedValue({ ok: true });
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

    it('deactivates with an independent signal before disposing the client', async () => {
        let finishDeactivate: ((value: { ok: true }) => void) | undefined;
        mockDeactivateBridge.mockImplementation(() => {
            return new Promise((resolve) => {
                finishDeactivate = resolve;
            });
        });
        const routeController = new AbortController();
        const run = PlayerCaptionCapture.capture({
            videoId: 'dispose-video',
            signal: routeController.signal,
            captureTimeoutMs: 1000,
        });
        await acceptActivation();

        routeController.abort();
        await flushMicrotasks();
        const disposeRun = PlayerCaptionCapture.dispose();

        expect(mockDeactivateBridge).toHaveBeenCalledOnce();
        const cleanupSignal: unknown = mockDeactivateBridge.mock.calls[0]?.[0];
        expect(cleanupSignal).toBeInstanceOf(AbortSignal);
        expect(cleanupSignal).not.toBe(routeController.signal);
        expect(
            cleanupSignal instanceof AbortSignal
                ? cleanupSignal.aborted
                : null,
        ).toBe(false);
        expect(mockDisposeBridge).not.toHaveBeenCalled();

        finishDeactivate?.({ ok: true });
        await disposeRun;
        await expect(run).resolves.toEqual({ status: 'cancelled' });
        expect(mockDisposeBridge).toHaveBeenCalledOnce();
    });

    it('deactivates an active capture before retiring the orphaned page bridge', async () => {
        const routeController = new AbortController();
        const run = PlayerCaptionCapture.capture({
            videoId: 'orphan-video',
            signal: routeController.signal,
            captureTimeoutMs: 1000,
        });
        await acceptActivation();

        await WatchCaptions.teardownPageBridge();

        await expect(run).resolves.toEqual({ status: 'cancelled' });
        expect(mockDeactivateBridge).toHaveBeenCalledOnce();
        expect(mockTeardownBridge).toHaveBeenCalledOnce();
        expect(mockDisposeBridge).toHaveBeenCalled();
        expect(mockDeactivateBridge.mock.invocationCallOrder[0]).toBeLessThan(
            mockTeardownBridge.mock.invocationCallOrder[0],
        );
        expect(mockTeardownBridge.mock.invocationCallOrder[0]).toBeLessThan(
            mockDisposeBridge.mock.invocationCallOrder.at(-1) ?? 0,
        );
    });

    it('still releases the bridge client when the teardown command rejects', async () => {
        mockTeardownBridge.mockRejectedValueOnce(new Error('bridge gone'));

        await expect(
            PlayerCaptionCapture.teardownPageBridge(),
        ).rejects.toThrow('bridge gone');

        expect(mockTeardownBridge).toHaveBeenCalledOnce();
        expect(mockDisposeBridge).toHaveBeenCalled();
    });

    it('cancels late delivery and lets the same video acquire new ownership', async () => {
        const raw = JSON.stringify({
            events: [
                {
                    tStartMs: 0,
                    dDurationMs: 1000,
                    segs: [{ utf8: 'fresh capture' }],
                },
            ],
        });
        PlayerCaptionCapture.scheduleForVideoId('same-video', 'first', {
            captureTimeoutMs: 1000,
        });
        await acceptActivation();

        WatchCaptions.cancel('disabled');
        dispatchTimedtextCapture('same-video', raw, 'late:first');
        PlayerCaptionCapture.scheduleForVideoId('same-video', 'retry', {
            captureTimeoutMs: 1000,
        });
        await acceptActivation();
        await finishCleanup();

        expect(
            countRuntimeMessages(TOPSKIP_MESSAGE.CAPTIONS_FROM_CONTENT),
        ).toBe(0);

        dispatchTimedtextCapture('same-video', raw, 'fresh:second');
        await finishCleanup();
        await vi.advanceTimersByTimeAsync(2000);

        expect(
            countRuntimeMessages(TOPSKIP_MESSAGE.CAPTIONS_FROM_CONTENT),
        ).toBe(1);
        const readyMessageSent = mockSendMessage.mock.calls.some((call) => {
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
                Reflect.get(payload, 'ok') === true &&
                Reflect.get(payload, 'videoId') === 'same-video'
            );
        });
        expect(readyMessageSent).toBe(true);
        expect(PlayerCaptionCapture.getScheduledVideoIdForTest()).toBe(
            'same-video',
        );
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

        expect(mockDeactivateBridge).toHaveBeenCalledTimes(4);
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

    it('returns cancelled while bridge confirmation remains pending', async () => {
        let finishProbe: ((value: { ok: true }) => void) | undefined;
        mockProbeBridge.mockImplementation(() => {
            return new Promise((resolve) => {
                finishProbe = resolve;
            });
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

        finishProbe?.({ ok: true });
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
