import { describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';

const {
    addRuntimeMessageListener,
    removeRuntimeMessageListener,
    capture,
    disposeCaptions,
    getManifest,
    installPageBridge,
    scheduleForVideoId,
    sendMessage,
} = vi.hoisted(() => ({
    addRuntimeMessageListener:
        vi.fn<(listener: (message: unknown) => unknown) => void>(),
    removeRuntimeMessageListener: vi.fn(),
    capture: vi.fn(),
    disposeCaptions: vi.fn(),
    getManifest: vi.fn(() => ({ version: '0.1.0' })),
    installPageBridge: vi.fn(),
    scheduleForVideoId: vi.fn(),
    sendMessage: vi.fn<(message: unknown) => Promise<unknown>>(),
}));

vi.mock('@/shared/browser', () => ({
    default: {
        runtime: {
            getManifest,
            sendMessage,
            onMessage: {
                addListener: addRuntimeMessageListener,
                removeListener: removeRuntimeMessageListener,
            },
        },
    },
}));

vi.mock('@/content/watch-captions', () => ({
    WatchCaptions: {
        capture,
        dispose: disposeCaptions,
        installPageBridge,
        scheduleForVideoId,
    },
}));

import {
    evaluatePromoBlocksSkip,
    promoBlockStartKey,
    resetFiredIndicesOnBackwardSeek,
    computePromoBlockTargetTime,
} from '@/content/promo-skip-logic';
import type { PromoBlock } from '@topskip/common/promo-types';
import {
    ANALYSIS_MODE,
    MS_PER_SECOND,
    type UserPreferences,
} from '@/shared/constants';
import {
    CONTENT_SCRIPT_PROTOCOL_VERSION,
    TOPSKIP_MESSAGE,
    requestServerAnalysisRuntimeMessageSchema,
} from '@/shared/messages';
import {
    CONTENT_PREFS_REQUEST_TIMEOUT_MS,
    CONTENT_PREFS_RETRY_DELAY_MS,
    shouldAcceptPromoBlocksForActiveRoute,
} from '@/content/youtube-watch';
import {
    VIDEO_BINDING_POLL_INTERVAL_MS,
    YOUTUBE_VIDEO_ELEMENT_SELECTOR,
} from '@/content/youtube-dom';
import {
    SERVER_ANALYSIS_RUNTIME_MESSAGE_TIMEOUT_MS,
    SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS,
    SERVER_ANALYSIS_SESSION_DEADLINE_MS,
} from '@/content/server-analysis-session';

/**
 * Simulates the YoutubeWatch.onTimeUpdate loop by calling
 * resetFiredIndicesOnBackwardSeek then evaluatePromoBlocksSkip, mirroring
 * the real code path in youtube-watch.ts.
 *
 * @param params - Playback state and block data
 * @returns Skip decision
 */
function simulateTimeUpdate(params: {
    prevTime: number;
    currentTime: number;
    duration: number;
    isSeeking: boolean;
    firedStartKeys: Set<number>;
    blocks: PromoBlock[];
}):
    | {
          action: 'none';
      }
    | {
          action: 'skip';
          blockIndex: number;
          targetTime: number;
      } {
    const {
        prevTime,
        currentTime,
        duration,
        isSeeking,
        firedStartKeys,
        blocks,
    } = params;

    resetFiredIndicesOnBackwardSeek({
        currentTime,
        prevTime,
        blocks,
        firedStartKeys,
    });

    return evaluatePromoBlocksSkip({
        prevTime,
        currentTime,
        duration,
        isSeeking,
        firedStartKeys,
        blocks,
    });
}

/**
 * Reads dynamic test-message fields without allowing `Reflect.get` to leak `any`.
 *
 * @param value - Opaque runtime value.
 * @param key - Dynamic property requested by the test.
 * @returns Opaque property value, or `undefined` for non-objects.
 */
function readTestProperty(value: unknown, key: string): unknown {
    if (value === null || typeof value !== 'object') {
        return undefined;
    }
    const property: unknown = Reflect.get(value, key);
    return property;
}

/**
 * Identifies only the terminal transport-interruption event under test.
 *
 * @param message - Opaque runtime message recorded by the harness.
 * @param videoId - Optional route identity used to exclude replacement work.
 * @returns Whether this is the matching analysis interruption event.
 */
function isAnalysisInterruptionMessage(
    message: unknown,
    videoId?: string,
): boolean {
    const payload = readTestProperty(message, 'payload');
    return (
        readTestProperty(payload, 'event') === 'analysis_interrupted' &&
        (videoId === undefined ||
            readTestProperty(payload, 'videoId') === videoId)
    );
}

describe('onTimeUpdate skip pipeline integration', () => {
    it('rejects late same-video blocks from a superseded Server session', () => {
        expect(
            shouldAcceptPromoBlocksForActiveRoute({
                currentVideoId: 'dQw4w9WgXcQ',
                messageVideoId: 'dQw4w9WgXcQ',
                source: 'server',
                activeSessionId: '00000000-0000-4000-8000-000000000002',
                messageSessionId: '00000000-0000-4000-8000-000000000001',
            }),
        ).toBe(false);
        expect(
            shouldAcceptPromoBlocksForActiveRoute({
                currentVideoId: 'dQw4w9WgXcQ',
                messageVideoId: 'dQw4w9WgXcQ',
                source: 'server_cache',
                activeSessionId: '00000000-0000-4000-8000-000000000002',
                messageSessionId: '00000000-0000-4000-8000-000000000002',
            }),
        ).toBe(true);
        expect(
            shouldAcceptPromoBlocksForActiveRoute({
                currentVideoId: 'dQw4w9WgXcQ',
                messageVideoId: 'dQw4w9WgXcQ',
                source: 'local_provider',
                activeSessionId: null,
                messageSessionId: undefined,
            }),
        ).toBe(true);
    });

    it('FR-001: skips when crossing a block start naturally', () => {
        const fired = new Set<number>();
        const blocks: PromoBlock[] = [{ startSec: 105, endSec: 135 }];
        const d = simulateTimeUpdate({
            prevTime: 104.8,
            currentTime: 105.2,
            duration: 600,
            isSeeking: false,
            firedStartKeys: fired,
            blocks,
        });
        expect(d).toEqual({ action: 'skip', blockIndex: 0, targetTime: 135 });
        expect(fired.has(promoBlockStartKey(105))).toBe(false);
    });

    it('FR-001: uses start + 30 when endSec absent', () => {
        const fired = new Set<number>();
        const blocks: PromoBlock[] = [{ startSec: 200 }];
        const d = simulateTimeUpdate({
            prevTime: 199.5,
            currentTime: 200.3,
            duration: 600,
            isSeeking: false,
            firedStartKeys: fired,
            blocks,
        });
        expect(d).toEqual({ action: 'skip', blockIndex: 0, targetTime: 230 });
    });

    it('FR-001: clamps to duration when target exceeds it', () => {
        const target = computePromoBlockTargetTime({ startSec: 200 }, 210);
        expect(target).toBe(210); // min(230, 210)
    });

    it(
        'FR-003: does not skip when enabled is' +
            ' simulated off (no blocks evaluated)',
        () => {
            // This test verifies the contract: when no blocks are passed
            // (simulating disabled state), no skip fires.
            const fired = new Set<number>();
            const d = simulateTimeUpdate({
                prevTime: 104.8,
                currentTime: 105.2,
                duration: 600,
                isSeeking: false,
                firedStartKeys: fired,
                blocks: [],
            });
            expect(d.action).toBe('none');
        },
    );

    it.each(['no_promo', 'unavailable', 'error', 'rate_limited'] as const)(
        'server %s state leaves playback unaltered when no blocks are delivered',
        () => {
            const d = simulateTimeUpdate({
                prevTime: 34.5,
                currentTime: 35.2,
                duration: 120,
                isSeeking: false,
                firedStartKeys: new Set<number>(),
                blocks: [],
            });

            expect(d.action).toBe('none');
        },
    );

    it(
        'FR-004: backward seek resets fired indices' + ' (pure function)',
        () => {
            const blocks: PromoBlock[] = [{ startSec: 45, endSec: 75 }];
            const fired = new Set([45]);

            // Call resetFired directly with the backward delta
            resetFiredIndicesOnBackwardSeek({
                currentTime: 10,
                prevTime: 80,
                blocks,
                firedStartKeys: fired,
            });
            expect(fired.has(45)).toBe(false);

            // Now simulate natural playback crossing the block again
            const d2 = simulateTimeUpdate({
                prevTime: 44.5,
                currentTime: 45.3,
                duration: 300,
                isSeeking: false,
                firedStartKeys: fired,
                blocks,
            });
            expect(d2).toEqual({
                action: 'skip',
                blockIndex: 0,
                targetTime: 75,
            });
        },
    );

    it(
        'FR-004: backward seek resets via onSeeked' +
            ' (real browser event order)',
        () => {
            // Real browser sequence:
            //   1. skip fires at startSec=45 → firedIndices={0}
            //   2. user seeks back to 10
            //   3. onSeeked: resetFired(cur=10, prev=80) → clears 0
            //              then lastTime=10
            //   4. onTimeUpdate: prevTime=10, currentTime=10.3
            //      → resetFired is a no-op (no backward delta)
            //      → skip does NOT fire yet (hasn't crossed 45)
            //   5. later: onTimeUpdate prevTime=44.5, cur=45.3 → skip fires
            const blocks: PromoBlock[] = [{ startSec: 45, endSec: 75 }];
            const fired = new Set([45]);

            // Step 3: simulate onSeeked calling resetFired before
            // overwriting lastTime
            resetFiredIndicesOnBackwardSeek({
                currentTime: 10,
                prevTime: 80,
                blocks,
                firedStartKeys: fired,
            });
            expect(fired.has(45)).toBe(false);

            // Step 4: first timeupdate after seek — lastTime was already
            // set to 10 by onSeeked, so prevTime=10
            const d1 = simulateTimeUpdate({
                prevTime: 10,
                currentTime: 10.3,
                duration: 300,
                isSeeking: false,
                firedStartKeys: fired,
                blocks,
            });
            expect(d1.action).toBe('none');

            // Step 5: natural playback crosses the block again
            const d2 = simulateTimeUpdate({
                prevTime: 44.5,
                currentTime: 45.3,
                duration: 300,
                isSeeking: false,
                firedStartKeys: fired,
                blocks,
            });
            expect(d2).toEqual({
                action: 'skip',
                blockIndex: 0,
                targetTime: 75,
            });
        },
    );

    it(
        'FR-005: SPA navigation resets are handled' +
            ' by resetForNewVideo (no pipeline test needed)',
        () => {
            // This is tested by verifying that a fresh firedIndices set
            // allows all blocks to fire. resetForNewVideo clears the set
            // and replaces blocks — both are constructor-level resets.
            const fired = new Set<number>();
            const blocks: PromoBlock[] = [{ startSec: 30, endSec: 60 }];
            const d = simulateTimeUpdate({
                prevTime: 29,
                currentTime: 31,
                duration: 300,
                isSeeking: false,
                firedStartKeys: fired,
                blocks,
            });
            expect(d.action).toBe('skip');
        },
    );

    it('FR-006: does not skip when isSeeking is true', () => {
        const fired = new Set<number>();
        const blocks: PromoBlock[] = [{ startSec: 10, endSec: 20 }];
        const d = simulateTimeUpdate({
            prevTime: 9,
            currentTime: 11,
            duration: 120,
            isSeeking: true,
            firedStartKeys: fired,
            blocks,
        });
        expect(d.action).toBe('none');
    });

    it('FR-008: large delta suppresses skip (tab backgrounding)', () => {
        const fired = new Set<number>();
        const blocks: PromoBlock[] = [{ startSec: 10, endSec: 20 }];
        const d = simulateTimeUpdate({
            prevTime: 0,
            currentTime: 15,
            duration: 120,
            isSeeking: false,
            firedStartKeys: fired,
            blocks,
        });
        expect(d.action).toBe('none');
    });

    it('FR-009: late-arriving blocks do not retroactively seek', () => {
        // Simulate: playback is at 65s, blocks arrive with startSec 30 and 120.
        // The block at 30 should NOT fire (prevTime=65, 65 < 30 is false).
        // The block at 120 should fire later.
        const fired = new Set<number>();
        const blocks: PromoBlock[] = [
            { startSec: 30, endSec: 45 },
            { startSec: 120, endSec: 150 },
        ];

        // First timeupdate after blocks arrive: currentTime=65, prevTime=64.5
        const d1 = simulateTimeUpdate({
            prevTime: 64.5,
            currentTime: 65,
            duration: 600,
            isSeeking: false,
            firedStartKeys: fired,
            blocks,
        });
        expect(d1.action).toBe('none'); // block at 30 is past; 120 not reached

        // Later: crossing 120
        const d2 = simulateTimeUpdate({
            prevTime: 119.5,
            currentTime: 120.3,
            duration: 600,
            isSeeking: false,
            firedStartKeys: fired,
            blocks,
        });
        expect(d2).toEqual({ action: 'skip', blockIndex: 1, targetTime: 150 });
    });

    it('server ready blocks arriving after an early start only apply future crossings', () => {
        const fired = new Set<number>();
        const blocks: PromoBlock[] = [
            { startSec: 4, endSec: 24 },
            { startSec: 35, endSec: 45 },
        ];

        const early = simulateTimeUpdate({
            prevTime: 12,
            currentTime: 12.5,
            duration: 120,
            isSeeking: false,
            firedStartKeys: fired,
            blocks,
        });
        expect(early.action).toBe('none');

        const future = simulateTimeUpdate({
            prevTime: 34.5,
            currentTime: 35.2,
            duration: 120,
            isSeeking: false,
            firedStartKeys: fired,
            blocks,
        });
        expect(future).toEqual({
            action: 'skip',
            blockIndex: 1,
            targetTime: 45,
        });
    });

    it(
        'FR-011: after skip, lastTime should be' +
            ' targetTime (verified by next call)',
        () => {
            const fired = new Set<number>();
            const blocks: PromoBlock[] = [
                { startSec: 10, endSec: 20 },
                { startSec: 25, endSec: 35 },
            ];

            // Skip first block
            const d1 = simulateTimeUpdate({
                prevTime: 9,
                currentTime: 11,
                duration: 120,
                isSeeking: false,
                firedStartKeys: fired,
                blocks,
            });
            expect(d1).toEqual({
                action: 'skip',
                blockIndex: 0,
                targetTime: 20,
            });
            fired.add(promoBlockStartKey(10));

            // After skip, lastTime is set to targetTime (20). Next timeupdate
            // comes with prevTime=20 (the targetTime), currentTime=20.5.
            // Block at 25 should NOT fire yet.
            const d2 = simulateTimeUpdate({
                prevTime: 20,
                currentTime: 20.5,
                duration: 120,
                isSeeking: false,
                firedStartKeys: fired,
                blocks,
            });
            expect(d2.action).toBe('none');

            // Crossing block 2
            const d3 = simulateTimeUpdate({
                prevTime: 24.5,
                currentTime: 25.3,
                duration: 120,
                isSeeking: false,
                firedStartKeys: fired,
                blocks,
            });
            expect(d3).toEqual({
                action: 'skip',
                blockIndex: 1,
                targetTime: 35,
            });
        },
    );

    it('multiple blocks: skips each in order', () => {
        const fired = new Set<number>();
        const blocks: PromoBlock[] = [
            { startSec: 30, endSec: 45 },
            { startSec: 90, endSec: 110 },
        ];

        const d1 = simulateTimeUpdate({
            prevTime: 29,
            currentTime: 31,
            duration: 300,
            isSeeking: false,
            firedStartKeys: fired,
            blocks,
        });
        expect(d1).toEqual({ action: 'skip', blockIndex: 0, targetTime: 45 });
        fired.add(promoBlockStartKey(30));

        const d2 = simulateTimeUpdate({
            prevTime: 89,
            currentTime: 91,
            duration: 300,
            isSeeking: false,
            firedStartKeys: fired,
            blocks,
        });
        expect(d2).toEqual({ action: 'skip', blockIndex: 1, targetTime: 110 });
    });
});

describe('per-video analysis route lifecycle', () => {
    const serverPrefs = {
        enabled: true,
        providerId: 'openrouter',
        activeModelId: 'openrouter:test',
        analysisMode: ANALYSIS_MODE.Server,
    };

    type RuntimeMessageListener = (message: unknown) => unknown;

    type ServerRuntimeResponder = (
        message: Record<string, unknown>,
    ) => Promise<unknown>;

    type PrefsRuntimeResponder = () => Promise<unknown>;

    type CaptionCaptureResponder = (input: {
        videoId: string;
        signal: AbortSignal;
    }) => Promise<unknown>;

    class FakeVideoElement extends EventTarget {
        currentTime = 0;
        duration = 120;
    }

    async function flushAsyncWork(): Promise<void> {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    }

    async function createRouteHarness(
        initialPrefs: UserPreferences,
        initialVideoPresent = true,
        initialDurationSec = 120,
        serverResponder?: ServerRuntimeResponder,
        sessionEventResponder?: ServerRuntimeResponder,
        prefsResponder?: PrefsRuntimeResponder,
        captureResponder?: CaptionCaptureResponder,
    ): Promise<{
        advanceBindingTime(elapsedMs: number): Promise<void>;
        disposeContent(): void;
        emitPrefs(prefs: UserPreferences): Promise<void>;
        emitRuntimeMessage(message: unknown): Promise<void>;
        probeContent(): unknown;
        messagesOfType(type: string): unknown[];
        navigateToVideo(videoId: string): Promise<void>;
        pollBindings(): Promise<void>;
        replaceVideoElement(): Promise<void>;
        setVideoDuration(durationSec: number): void;
        fetchCallCount(): number;
        dispose(): void;
    }> {
        vi.useFakeTimers();
        vi.resetModules();
        sendMessage.mockReset();
        addRuntimeMessageListener.mockReset();
        removeRuntimeMessageListener.mockReset();
        capture.mockReset();
        disposeCaptions.mockReset();
        installPageBridge.mockReset();
        scheduleForVideoId.mockReset();

        let runtimeMessageListener: RuntimeMessageListener | null = null;
        let video: FakeVideoElement | null = initialVideoPresent
            ? new FakeVideoElement()
            : null;
        if (video !== null) {
            video.duration = initialDurationSec;
        }
        const locationState = {
            hostname: 'www.youtube.com',
            pathname: '/watch',
            search: '?v=dQw4w9WgXcQ',
        };
        const windowEvents = new EventTarget();
        const fetchMock = vi.fn();

        addRuntimeMessageListener.mockImplementation(
            (listener: RuntimeMessageListener) => {
                runtimeMessageListener = listener;
            },
        );
        capture.mockImplementation(
            captureResponder ??
                ((input: { videoId: string; signal: AbortSignal }) => {
                    if (input.signal.aborted) {
                        return Promise.resolve({ status: 'cancelled' });
                    }
                    return Promise.resolve({
                        status: 'ready',
                        payload: {
                            ok: true,
                            videoId: input.videoId,
                            languageCode: 'en',
                            segments: [
                                {
                                    startSec: 0,
                                    durationSec: 1,
                                    text: 'Caption',
                                },
                            ],
                        },
                    });
                }),
        );
        sendMessage.mockImplementation((message: unknown) => {
            if (
                typeof message === 'object' &&
                message !== null &&
                'type' in message
            ) {
                if (message.type === TOPSKIP_MESSAGE.GET_PREFS) {
                    if (prefsResponder !== undefined) {
                        return prefsResponder();
                    }
                    return Promise.resolve({ ok: true, prefs: initialPrefs });
                }
                if (
                    message.type ===
                        TOPSKIP_MESSAGE.SERVER_ANALYSIS_SESSION_EVENT &&
                    sessionEventResponder !== undefined
                ) {
                    return sessionEventResponder(message);
                }
                if (
                    message.type === TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS ||
                    message.type ===
                        TOPSKIP_MESSAGE.REFRESH_SERVER_ANALYSIS_STATUS
                ) {
                    if (serverResponder !== undefined) {
                        return serverResponder(message);
                    }
                    const payload: unknown = Reflect.get(message, 'payload');
                    const payloadVideoId: unknown =
                        payload !== null && typeof payload === 'object'
                            ? Reflect.get(payload, 'videoId')
                            : undefined;
                    const videoId =
                        typeof payloadVideoId === 'string'
                            ? payloadVideoId
                            : 'dQw4w9WgXcQ';
                    return Promise.resolve({
                        ok: true,
                        status: 'processing',
                        jobId: 'job-active-video',
                        pollAfterSec: 1,
                        identity: {
                            videoId,
                            languageCode: 'en',
                            transcriptHash:
                                '321d90058849d7ab00a6ed95cf4fb209803d8b8362dc061a9e10fdf324b5e468',
                            algorithmVersion: 'server-v6',
                        },
                    });
                }
            }
            return Promise.resolve({ ok: true });
        });

        vi.stubGlobal('HTMLVideoElement', FakeVideoElement);
        vi.stubGlobal('location', locationState);
        vi.stubGlobal('document', {
            querySelector(selector: string): FakeVideoElement | null {
                return selector === YOUTUBE_VIDEO_ELEMENT_SELECTOR
                    ? video
                    : null;
            },
        });
        vi.stubGlobal('window', {
            addEventListener: windowEvents.addEventListener.bind(windowEvents),
            removeEventListener:
                windowEvents.removeEventListener.bind(windowEvents),
            clearTimeout: globalThis.clearTimeout,
            dispatchEvent: windowEvents.dispatchEvent.bind(windowEvents),
            setTimeout: globalThis.setTimeout,
        });
        vi.stubGlobal('fetch', fetchMock);

        const { YoutubeWatch } = await import('@/content/youtube-watch');
        const disposeWatch = YoutubeWatch.init();
        let contentDisposed = false;
        const disposeContent = (): void => {
            if (contentDisposed) {
                return;
            }
            contentDisposed = true;
            disposeWatch();
        };
        await flushAsyncWork();

        const getRuntimeMessageListener = (): RuntimeMessageListener => {
            if (runtimeMessageListener === null) {
                throw new Error('Runtime message listener was not registered.');
            }
            return runtimeMessageListener;
        };
        const dispatchNavigation = async (): Promise<void> => {
            windowEvents.dispatchEvent(new Event('yt-navigate-finish'));
            await flushAsyncWork();
        };

        return {
            async advanceBindingTime(elapsedMs: number): Promise<void> {
                await vi.advanceTimersByTimeAsync(elapsedMs);
                await flushAsyncWork();
            },
            disposeContent,
            async emitPrefs(prefs: UserPreferences): Promise<void> {
                getRuntimeMessageListener()({
                    type: TOPSKIP_MESSAGE.PREFS_UPDATED,
                    prefs,
                });
                await flushAsyncWork();
            },
            async emitRuntimeMessage(message: unknown): Promise<void> {
                getRuntimeMessageListener()(message);
                await flushAsyncWork();
            },
            probeContent(): unknown {
                return getRuntimeMessageListener()({
                    type: TOPSKIP_MESSAGE.CONTENT_SCRIPT_READY,
                });
            },
            messagesOfType(type: string): unknown[] {
                return sendMessage.mock.calls
                    .map(([message]) => message)
                    .filter(
                        (message) =>
                            typeof message === 'object' &&
                            message !== null &&
                            'type' in message &&
                            message.type === type,
                    );
            },
            async navigateToVideo(videoId: string): Promise<void> {
                locationState.search = `?v=${videoId}`;
                await dispatchNavigation();
            },
            async pollBindings(): Promise<void> {
                await vi.advanceTimersByTimeAsync(
                    VIDEO_BINDING_POLL_INTERVAL_MS * 2,
                );
                await flushAsyncWork();
            },
            async replaceVideoElement(): Promise<void> {
                video = new FakeVideoElement();
                await dispatchNavigation();
            },
            setVideoDuration(durationSec: number): void {
                if (video !== null) {
                    video.duration = durationSec;
                }
            },
            fetchCallCount(): number {
                return fetchMock.mock.calls.length;
            },
            dispose(): void {
                disposeContent();
                vi.clearAllTimers();
                vi.useRealTimers();
                vi.unstubAllGlobals();
            },
        };
    }

    it('acknowledges the background readiness probe and disposes replacement state', async () => {
        const harness = await createRouteHarness(serverPrefs);
        try {
            expect(harness.probeContent()).toEqual({
                ok: true,
                protocolVersion: CONTENT_SCRIPT_PROTOCOL_VERSION,
                extensionVersion: '0.1.0',
            });
        } finally {
            harness.dispose();
        }

        expect(removeRuntimeMessageListener).toHaveBeenCalledOnce();
        expect(disposeCaptions).toHaveBeenCalledOnce();
    });

    it('retries preferences after a transient runtime rejection', async () => {
        let attempt = 0;
        const harness = await createRouteHarness(
            serverPrefs,
            true,
            120,
            undefined,
            undefined,
            () => {
                attempt += 1;
                return attempt === 1
                    ? Promise.reject(new Error('worker stopped'))
                    : Promise.resolve({ ok: true, prefs: serverPrefs });
            },
        );

        try {
            expect(capture).not.toHaveBeenCalled();
            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.GET_PREFS),
            ).toHaveLength(1);
            await harness.advanceBindingTime(
                CONTENT_PREFS_RETRY_DELAY_MS - 1,
            );
            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.GET_PREFS),
            ).toHaveLength(1);
            await harness.advanceBindingTime(1);

            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.GET_PREFS),
            ).toHaveLength(2);
            expect(capture).toHaveBeenCalledOnce();
            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS),
            ).toHaveLength(1);
        } finally {
            harness.dispose();
        }
    });

    it('times out a lost preferences reply and eventually routes once', async () => {
        let attempt = 0;
        const never = new Promise<unknown>(() => undefined);
        const harness = await createRouteHarness(
            serverPrefs,
            true,
            120,
            undefined,
            undefined,
            () => {
                attempt += 1;
                return attempt === 1
                    ? never
                    : Promise.resolve({ ok: true, prefs: serverPrefs });
            },
        );

        try {
            expect(capture).not.toHaveBeenCalled();
            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.GET_PREFS),
            ).toHaveLength(1);
            await harness.advanceBindingTime(
                CONTENT_PREFS_REQUEST_TIMEOUT_MS - 1,
            );
            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.GET_PREFS),
            ).toHaveLength(1);
            await harness.advanceBindingTime(
                CONTENT_PREFS_RETRY_DELAY_MS + 1,
            );

            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.GET_PREFS),
            ).toHaveLength(2);
            expect(capture).toHaveBeenCalledOnce();
            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS),
            ).toHaveLength(1);
        } finally {
            harness.dispose();
        }
    });

    it('keeps retrying until preferences have a valid shape', async () => {
        let attempt = 0;
        const harness = await createRouteHarness(
            serverPrefs,
            true,
            120,
            undefined,
            undefined,
            () => {
                attempt += 1;
                return attempt === 1
                    ? Promise.resolve({
                            ok: true,
                            prefs: { ...serverPrefs, enabled: 'yes' },
                        })
                    : Promise.resolve({ ok: true, prefs: serverPrefs });
            },
        );

        try {
            expect(capture).not.toHaveBeenCalled();
            await harness.advanceBindingTime(CONTENT_PREFS_RETRY_DELAY_MS);

            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.GET_PREFS),
            ).toHaveLength(2);
            expect(capture).toHaveBeenCalledOnce();
            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS),
            ).toHaveLength(1);
        } finally {
            harness.dispose();
        }
    });

    it('ignores a timed-out reply after a newer preferences response', async () => {
        let attempt = 0;
        let resolveOld: (response: unknown) => void = () => undefined;
        const oldReply = new Promise<unknown>((resolve) => {
            resolveOld = resolve;
        });
        const harness = await createRouteHarness(
            serverPrefs,
            true,
            120,
            undefined,
            undefined,
            () => {
                attempt += 1;
                return attempt === 1
                    ? oldReply
                    : Promise.resolve({
                            ok: true,
                            prefs: { ...serverPrefs, enabled: false },
                        });
            },
        );

        try {
            await harness.advanceBindingTime(
                CONTENT_PREFS_REQUEST_TIMEOUT_MS +
                    CONTENT_PREFS_RETRY_DELAY_MS,
            );
            resolveOld({ ok: true, prefs: serverPrefs });
            await harness.advanceBindingTime(0);
            await harness.pollBindings();

            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.GET_PREFS),
            ).toHaveLength(2);
            expect(capture).not.toHaveBeenCalled();
            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS),
            ).toHaveLength(0);
        } finally {
            harness.dispose();
        }
    });

    it('does not let a late preferences reply overwrite a broadcast', async () => {
        let resolveOld: (response: unknown) => void = () => undefined;
        const oldReply = new Promise<unknown>((resolve) => {
            resolveOld = resolve;
        });
        const harness = await createRouteHarness(
            serverPrefs,
            true,
            120,
            undefined,
            undefined,
            () => oldReply,
        );

        try {
            await harness.emitPrefs({ ...serverPrefs, enabled: false });
            resolveOld({ ok: true, prefs: serverPrefs });
            await harness.advanceBindingTime(
                CONTENT_PREFS_REQUEST_TIMEOUT_MS +
                    CONTENT_PREFS_RETRY_DELAY_MS,
            );

            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.GET_PREFS),
            ).toHaveLength(1);
            expect(capture).not.toHaveBeenCalled();
            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS),
            ).toHaveLength(0);
        } finally {
            harness.dispose();
        }
    });

    it('cancels preferences timeout and retry ownership on dispose', async () => {
        const never = new Promise<unknown>(() => undefined);
        const harness = await createRouteHarness(
            serverPrefs,
            true,
            120,
            undefined,
            undefined,
            () => never,
        );

        try {
            harness.disposeContent();
            await harness.advanceBindingTime(
                CONTENT_PREFS_REQUEST_TIMEOUT_MS +
                    CONTENT_PREFS_RETRY_DELAY_MS,
            );

            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.GET_PREFS),
            ).toHaveLength(1);
            expect(capture).not.toHaveBeenCalled();
        } finally {
            harness.dispose();
        }
    });

    it('does not request the backend route while disabled or before video binding', async () => {
        const disabledHarness = await createRouteHarness({
            ...serverPrefs,
            enabled: false,
        });
        try {
            expect(
                disabledHarness.messagesOfType(
                    TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS,
                ),
            ).toHaveLength(0);
            expect(disabledHarness.fetchCallCount()).toBe(0);
        } finally {
            disabledHarness.dispose();
        }

        const waitingHarness = await createRouteHarness(serverPrefs, false);
        try {
            expect(
                waitingHarness.messagesOfType(
                    TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS,
                ),
            ).toHaveLength(0);
            expect(waitingHarness.fetchCallCount()).toBe(0);
        } finally {
            waitingHarness.dispose();
        }
    });

    it('captures immediately without waiting for duration or playback', async () => {
        const harness = await createRouteHarness(serverPrefs, true, Number.NaN);
        try {
            expect(capture).toHaveBeenCalledOnce();
            const messages = harness.messagesOfType(
                TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS,
            );
            expect(messages).toHaveLength(1);
            const message = v.parse(
                requestServerAnalysisRuntimeMessageSchema,
                messages[0],
            );
            expect(typeof message.payload.sessionId).toBe('string');
            expect(message).toMatchObject({
                type: TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS,
                payload: {
                    videoId: 'dQw4w9WgXcQ',
                    languageCode: 'en',
                    segments: [
                        {
                            startSec: 0,
                            durationSec: 1,
                            text: 'Caption',
                        },
                    ],
                },
            });
            expect(harness.fetchCallCount()).toBe(0);
        } finally {
            harness.dispose();
        }
    });

    it('does not let an unresolved acquisition event block the request', async () => {
        const never = new Promise<unknown>(() => undefined);
        const harness = await createRouteHarness(
            serverPrefs,
            true,
            120,
            undefined,
            () => never,
        );

        try {
            expect(capture).toHaveBeenCalledOnce();
            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS),
            ).toHaveLength(1);
        } finally {
            harness.dispose();
        }
    });

    it('keeps an inactive response as a same-video terminal sentinel', async () => {
        const harness = await createRouteHarness(
            serverPrefs,
            true,
            120,
            () => Promise.resolve({ ok: true, status: 'inactive' }),
        );

        try {
            await harness.pollBindings();
            await harness.replaceVideoElement();
            await harness.pollBindings();

            expect(capture).toHaveBeenCalledOnce();
            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS),
            ).toHaveLength(1);
        } finally {
            harness.dispose();
        }
    });

    it('cancels Server and switches to BYOK on the same video', async () => {
        const harness = await createRouteHarness(serverPrefs);
        const byokPrefs: UserPreferences = {
            ...serverPrefs,
            analysisMode: ANALYSIS_MODE.Byok,
        };

        try {
            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS),
            ).toHaveLength(1);
            expect(harness.fetchCallCount()).toBe(0);

            await harness.emitPrefs(byokPrefs);
            await harness.pollBindings();
            await harness.replaceVideoElement();
            await harness.pollBindings();

            expect(
                harness.messagesOfType(
                    TOPSKIP_MESSAGE.REFRESH_SERVER_ANALYSIS_STATUS,
                ),
            ).toHaveLength(0);
            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.PREFLIGHT_BYOK_SETUP),
            ).toEqual([
                {
                    type: TOPSKIP_MESSAGE.PREFLIGHT_BYOK_SETUP,
                    payload: { videoId: 'dQw4w9WgXcQ' },
                },
            ]);
            expect(scheduleForVideoId).toHaveBeenCalled();
            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS),
            ).toHaveLength(1);
        } finally {
            harness.dispose();
        }
    });

    it('switches from BYOK to a fresh Server capture on the same video', async () => {
        const byokPrefs: UserPreferences = {
            ...serverPrefs,
            analysisMode: ANALYSIS_MODE.Byok,
        };
        const harness = await createRouteHarness(byokPrefs);

        try {
            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.PREFLIGHT_BYOK_SETUP),
            ).toEqual([
                {
                    type: TOPSKIP_MESSAGE.PREFLIGHT_BYOK_SETUP,
                    payload: { videoId: 'dQw4w9WgXcQ' },
                },
            ]);
            expect(scheduleForVideoId).toHaveBeenCalledTimes(1);

            await harness.pollBindings();
            await harness.emitPrefs(serverPrefs);
            await harness.pollBindings();

            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.PREFLIGHT_BYOK_SETUP),
            ).toHaveLength(1);
            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS),
            ).toHaveLength(1);
            expect(capture).toHaveBeenCalledOnce();
        } finally {
            harness.dispose();
        }
    });

    it('retries an interrupted submit without recapturing captions', async () => {
        let submitCount = 0;
        const harness = await createRouteHarness(
            serverPrefs,
            true,
            120,
            (message) => {
                submitCount += 1;
                if (submitCount === 1) {
                    return Promise.reject(new Error('message port closed'));
                }
                const payload = readTestProperty(message, 'payload');
                const videoId = readTestProperty(payload, 'videoId');
                return Promise.resolve({
                    ok: true,
                    status: 'processing',
                    jobId: 'job-after-restart',
                    pollAfterSec: 60,
                    identity: {
                        videoId,
                        languageCode: 'en',
                        transcriptHash: 'a'.repeat(64),
                        algorithmVersion: 'server-v6',
                    },
                });
            },
        );

        try {
            expect(capture).toHaveBeenCalledOnce();
            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS),
            ).toHaveLength(1);

            await harness.advanceBindingTime(
                SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS[0],
            );

            const requests = harness.messagesOfType(
                TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS,
            );
            expect(requests).toHaveLength(2);
            expect(requests[1]).toEqual(requests[0]);
            expect(capture).toHaveBeenCalledOnce();
        } finally {
            harness.dispose();
        }
    });

    it('retries the same poll job after a worker restart', async () => {
        let pollCount = 0;
        const harness = await createRouteHarness(
            serverPrefs,
            true,
            120,
            (message) => {
                const payload = readTestProperty(message, 'payload');
                const videoId = readTestProperty(payload, 'videoId');
                if (
                    readTestProperty(message, 'type') ===
                    TOPSKIP_MESSAGE.REFRESH_SERVER_ANALYSIS_STATUS
                ) {
                    pollCount += 1;
                    if (pollCount === 1) {
                        return Promise.reject(
                            new Error('message port closed'),
                        );
                    }
                }
                return Promise.resolve({
                    ok: true,
                    status: 'processing',
                    jobId: 'job-stable',
                    pollAfterSec: 1,
                    identity: {
                        videoId,
                        languageCode: 'en',
                        transcriptHash: 'b'.repeat(64),
                        algorithmVersion: 'server-v6',
                    },
                });
            },
        );

        try {
            await harness.advanceBindingTime(MS_PER_SECOND);
            const firstPoll = harness.messagesOfType(
                TOPSKIP_MESSAGE.REFRESH_SERVER_ANALYSIS_STATUS,
            )[0];
            await harness.advanceBindingTime(
                SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS[0],
            );

            const polls = harness.messagesOfType(
                TOPSKIP_MESSAGE.REFRESH_SERVER_ANALYSIS_STATUS,
            );
            expect(polls).toHaveLength(2);
            expect(polls[1]).toEqual(firstPoll);
            expect(capture).toHaveBeenCalledOnce();
            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS),
            ).toHaveLength(1);
        } finally {
            harness.dispose();
        }
    });

    it('retries a timed-out poll with the same job and identity', async () => {
        let pollCount = 0;
        const never = new Promise<unknown>(() => undefined);
        const harness = await createRouteHarness(
            serverPrefs,
            true,
            120,
            (message) => {
                const payload = readTestProperty(message, 'payload');
                const videoId = readTestProperty(payload, 'videoId');
                if (
                    readTestProperty(message, 'type') ===
                    TOPSKIP_MESSAGE.REFRESH_SERVER_ANALYSIS_STATUS
                ) {
                    pollCount += 1;
                    if (pollCount === 1) {
                        return never;
                    }
                }
                return Promise.resolve({
                    ok: true,
                    status: 'processing',
                    jobId: 'job-timeout-stable',
                    pollAfterSec: 1,
                    identity: {
                        videoId,
                        languageCode: 'en',
                        transcriptHash: 'f'.repeat(64),
                        algorithmVersion: 'server-v6',
                    },
                });
            },
        );

        try {
            await harness.advanceBindingTime(MS_PER_SECOND);
            const timedOutPoll = harness.messagesOfType(
                TOPSKIP_MESSAGE.REFRESH_SERVER_ANALYSIS_STATUS,
            )[0];
            await harness.advanceBindingTime(
                SERVER_ANALYSIS_RUNTIME_MESSAGE_TIMEOUT_MS +
                    SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS[0],
            );

            const polls = harness.messagesOfType(
                TOPSKIP_MESSAGE.REFRESH_SERVER_ANALYSIS_STATUS,
            );
            expect(polls).toHaveLength(2);
            expect(polls[1]).toEqual(timedOutPoll);
            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS),
            ).toHaveLength(1);
            expect(capture).toHaveBeenCalledOnce();
        } finally {
            harness.dispose();
        }
    });

    it('retries the same exact resubmission after a worker restart', async () => {
        let requestCount = 0;
        const harness = await createRouteHarness(
            serverPrefs,
            true,
            120,
            (message) => {
                const type = readTestProperty(message, 'type');
                const payload = readTestProperty(message, 'payload');
                const videoId = readTestProperty(payload, 'videoId');
                if (type === TOPSKIP_MESSAGE.REFRESH_SERVER_ANALYSIS_STATUS) {
                    return Promise.resolve({
                        ok: true,
                        status: 'resubmit_required',
                    });
                }
                requestCount += 1;
                if (requestCount === 1) {
                    return Promise.resolve({
                        ok: true,
                        status: 'processing',
                        jobId: 'job-before-restart',
                        pollAfterSec: 1,
                        identity: {
                            videoId,
                            languageCode: 'en',
                            transcriptHash: 'e'.repeat(64),
                            algorithmVersion: 'server-v6',
                        },
                    });
                }
                if (requestCount === 2) {
                    return Promise.reject(new Error('message port closed'));
                }
                return Promise.resolve({ ok: true, status: 'no_promo' });
            },
        );

        try {
            await harness.advanceBindingTime(MS_PER_SECOND);
            const failedResubmission = harness.messagesOfType(
                TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS,
            )[1];
            await harness.advanceBindingTime(
                SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS[0],
            );

            const requests = harness.messagesOfType(
                TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS,
            );
            expect(requests).toHaveLength(3);
            expect(requests[2]).toEqual(failedResubmission);
            expect(
                harness.messagesOfType(
                    TOPSKIP_MESSAGE.REFRESH_SERVER_ANALYSIS_STATUS,
                ),
            ).toHaveLength(1);
            expect(capture).toHaveBeenCalledOnce();
        } finally {
            harness.dispose();
        }
    });

    it('recovers an unresolved submit after the runtime watchdog', async () => {
        let submitCount = 0;
        const never = new Promise<unknown>(() => undefined);
        const harness = await createRouteHarness(
            serverPrefs,
            true,
            120,
            (message) => {
                submitCount += 1;
                if (submitCount === 1) {
                    return never;
                }
                const payload = readTestProperty(message, 'payload');
                const videoId = readTestProperty(payload, 'videoId');
                return Promise.resolve({
                    ok: true,
                    status: 'processing',
                    jobId: 'job-after-watchdog',
                    pollAfterSec: 60,
                    identity: {
                        videoId,
                        languageCode: 'en',
                        transcriptHash: 'c'.repeat(64),
                        algorithmVersion: 'server-v6',
                    },
                });
            },
        );

        try {
            await harness.advanceBindingTime(
                SERVER_ANALYSIS_RUNTIME_MESSAGE_TIMEOUT_MS +
                    SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS[0],
            );

            const requests = harness.messagesOfType(
                TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS,
            );
            expect(requests).toHaveLength(2);
            expect(requests[1]).toEqual(requests[0]);
            expect(capture).toHaveBeenCalledOnce();
        } finally {
            harness.dispose();
        }
    });

    it('ends after bounded transport retries without starting a new session', async () => {
        const harness = await createRouteHarness(
            serverPrefs,
            true,
            120,
            () => Promise.reject(new Error('message port closed')),
        );

        try {
            for (const retryAfterMs of SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS) {
                await harness.advanceBindingTime(retryAfterMs);
            }
            await harness.pollBindings();

            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS),
            ).toHaveLength(5);
            expect(capture).toHaveBeenCalledOnce();
            const interruption = harness
                .messagesOfType(
                    TOPSKIP_MESSAGE.SERVER_ANALYSIS_SESSION_EVENT,
                )
                .find((message) => {
                    const payload = readTestProperty(message, 'payload');
                    return (
                        readTestProperty(payload, 'event') ===
                            'analysis_interrupted' &&
                        readTestProperty(payload, 'reason') ===
                            'runtime_unavailable'
                    );
                });
            expect(interruption).toBeDefined();
        } finally {
            harness.dispose();
        }
    });

    it('retries a rejected interruption delivery without recapturing', async () => {
        let deliveryAttempt = 0;
        const harness = await createRouteHarness(
            serverPrefs,
            true,
            120,
            () => Promise.resolve({ invalid: true }),
            (message) => {
                const payload = readTestProperty(message, 'payload');
                if (
                    readTestProperty(payload, 'event') !==
                    'analysis_interrupted'
                ) {
                    return Promise.resolve({ ok: true });
                }
                deliveryAttempt += 1;
                return deliveryAttempt === 1
                    ? Promise.reject(new Error('worker stopped'))
                    : Promise.resolve({ ok: true });
            },
        );

        try {
            expect(
                harness
                    .messagesOfType(
                        TOPSKIP_MESSAGE.SERVER_ANALYSIS_SESSION_EVENT,
                    )
                    .filter((message) =>
                        isAnalysisInterruptionMessage(message),
                    ),
            ).toHaveLength(1);
            await harness.advanceBindingTime(
                SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS[0],
            );

            expect(
                harness
                    .messagesOfType(
                        TOPSKIP_MESSAGE.SERVER_ANALYSIS_SESSION_EVENT,
                    )
                    .filter((message) =>
                        isAnalysisInterruptionMessage(message),
                    ),
            ).toHaveLength(2);
            expect(capture).toHaveBeenCalledOnce();
            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS),
            ).toHaveLength(1);
        } finally {
            harness.dispose();
        }
    });

    for (const testCase of [
        {
            failureReason: 'captions-unavailable',
            terminalEvent: 'captions_unavailable',
        },
        {
            failureReason: 'capture-timeout',
            terminalEvent: 'caption_extraction_failed',
        },
    ]) {
        it(`retries rejected ${testCase.terminalEvent} delivery`, async () => {
            let deliveryAttempt = 0;
            const harness = await createRouteHarness(
                serverPrefs,
                true,
                120,
                undefined,
                (message) => {
                    const payload = readTestProperty(message, 'payload');
                    if (
                        readTestProperty(payload, 'event') !==
                        testCase.terminalEvent
                    ) {
                        return Promise.resolve({ ok: true });
                    }
                    deliveryAttempt += 1;
                    return deliveryAttempt === 1
                        ? Promise.reject(new Error('worker stopped'))
                        : Promise.resolve({ ok: true });
                },
                undefined,
                () =>
                    Promise.resolve({
                        status: 'failed',
                        failure: {
                            reason: testCase.failureReason,
                            message: 'Safe test failure',
                        },
                    }),
            );

            try {
                await harness.advanceBindingTime(
                    SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS[0],
                );
                const terminalEvents = harness
                    .messagesOfType(
                        TOPSKIP_MESSAGE.SERVER_ANALYSIS_SESSION_EVENT,
                    )
                    .filter((message) => {
                        const payload = readTestProperty(message, 'payload');
                        return (
                            readTestProperty(payload, 'event') ===
                            testCase.terminalEvent
                        );
                    });

                expect(terminalEvents).toHaveLength(2);
                expect(capture).toHaveBeenCalledOnce();
                expect(
                    harness.messagesOfType(
                        TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS,
                    ),
                ).toHaveLength(0);
            } finally {
                harness.dispose();
            }
        });
    }

    it('retries interruption delivery after its acknowledgement times out', async () => {
        let deliveryAttempt = 0;
        const never = new Promise<unknown>(() => undefined);
        const harness = await createRouteHarness(
            serverPrefs,
            true,
            120,
            () => Promise.resolve({ invalid: true }),
            (message) => {
                const payload = readTestProperty(message, 'payload');
                if (
                    readTestProperty(payload, 'event') !==
                    'analysis_interrupted'
                ) {
                    return Promise.resolve({ ok: true });
                }
                deliveryAttempt += 1;
                return deliveryAttempt === 1
                    ? never
                    : Promise.resolve({ ok: true });
            },
        );

        try {
            await harness.advanceBindingTime(
                SERVER_ANALYSIS_RUNTIME_MESSAGE_TIMEOUT_MS +
                    SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS[0],
            );

            expect(
                harness
                    .messagesOfType(
                        TOPSKIP_MESSAGE.SERVER_ANALYSIS_SESSION_EVENT,
                    )
                    .filter((message) =>
                        isAnalysisInterruptionMessage(message),
                    ),
            ).toHaveLength(2);
            expect(capture).toHaveBeenCalledOnce();
        } finally {
            harness.dispose();
        }
    });

    it('ignores a duplicate late interruption acknowledgement', async () => {
        let deliveryAttempt = 0;
        let resolveOld: (response: unknown) => void = () => undefined;
        const oldAcknowledgement = new Promise<unknown>((resolve) => {
            resolveOld = resolve;
        });
        const harness = await createRouteHarness(
            serverPrefs,
            true,
            120,
            () => Promise.resolve({ invalid: true }),
            (message) => {
                const payload = readTestProperty(message, 'payload');
                if (
                    readTestProperty(payload, 'event') !==
                    'analysis_interrupted'
                ) {
                    return Promise.resolve({ ok: true });
                }
                deliveryAttempt += 1;
                return deliveryAttempt === 1
                    ? oldAcknowledgement
                    : Promise.resolve({ ok: true });
            },
        );

        try {
            await harness.advanceBindingTime(
                SERVER_ANALYSIS_RUNTIME_MESSAGE_TIMEOUT_MS +
                    SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS[0],
            );
            resolveOld({ ok: true });
            await harness.advanceBindingTime(0);
            harness.probeContent();
            await harness.advanceBindingTime(0);

            expect(
                harness
                    .messagesOfType(
                        TOPSKIP_MESSAGE.SERVER_ANALYSIS_SESSION_EVENT,
                    )
                    .filter((message) =>
                        isAnalysisInterruptionMessage(message),
                    ),
            ).toHaveLength(2);
        } finally {
            harness.dispose();
        }
    });

    it('redelivers an exhausted interruption on the next readiness probe', async () => {
        let deliveryAttempt = 0;
        const harness = await createRouteHarness(
            serverPrefs,
            true,
            120,
            () => Promise.resolve({ invalid: true }),
            (message) => {
                const payload = readTestProperty(message, 'payload');
                if (
                    readTestProperty(payload, 'event') !==
                    'analysis_interrupted'
                ) {
                    return Promise.resolve({ ok: true });
                }
                deliveryAttempt += 1;
                return deliveryAttempt <= 5
                    ? Promise.reject(new Error('worker stopped'))
                    : Promise.resolve({ ok: true });
            },
        );

        try {
            for (const retryAfterMs of SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS) {
                await harness.advanceBindingTime(retryAfterMs);
            }
            const interruptionMessages = (): unknown[] =>
                harness
                    .messagesOfType(
                        TOPSKIP_MESSAGE.SERVER_ANALYSIS_SESSION_EVENT,
                    )
                    .filter((message) =>
                        isAnalysisInterruptionMessage(message),
                    );
            expect(interruptionMessages()).toHaveLength(5);

            await harness.advanceBindingTime(10 * MS_PER_SECOND);
            expect(interruptionMessages()).toHaveLength(5);
            harness.probeContent();
            await harness.advanceBindingTime(0);
            expect(interruptionMessages()).toHaveLength(6);
            harness.probeContent();
            await harness.advanceBindingTime(0);
            expect(interruptionMessages()).toHaveLength(6);
        } finally {
            harness.dispose();
        }
    });

    it('clears pending interruption delivery when its route is replaced', async () => {
        const harness = await createRouteHarness(
            serverPrefs,
            true,
            120,
            (message) => {
                const payload = readTestProperty(message, 'payload');
                return readTestProperty(payload, 'videoId') ===
                    'dQw4w9WgXcQ'
                    ? Promise.resolve({ invalid: true })
                    : Promise.resolve({ ok: true, status: 'inactive' });
            },
            (message) => {
                const payload = readTestProperty(message, 'payload');
                return readTestProperty(payload, 'event') ===
                    'analysis_interrupted'
                    ? Promise.reject(new Error('worker stopped'))
                    : Promise.resolve({ ok: true });
            },
        );

        try {
            await harness.navigateToVideo('e2eFixture1');
            await harness.advanceBindingTime(
                SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS[0],
            );
            harness.probeContent();
            await harness.advanceBindingTime(0);

            expect(
                harness
                    .messagesOfType(
                        TOPSKIP_MESSAGE.SERVER_ANALYSIS_SESSION_EVENT,
                    )
                    .filter((message) =>
                        isAnalysisInterruptionMessage(
                            message,
                            'dQw4w9WgXcQ',
                        ),
                    ),
            ).toHaveLength(1);
            expect(capture).toHaveBeenCalledTimes(2);
        } finally {
            harness.dispose();
        }
    });

    for (const testCase of [
        {
            label: 'disabled',
            prefs: { ...serverPrefs, enabled: false },
        },
        {
            label: 'BYOK mode',
            prefs: { ...serverPrefs, analysisMode: ANALYSIS_MODE.Byok },
        },
    ]) {
        it(`clears terminal-event delivery in ${testCase.label}`, async () => {
            const harness = await createRouteHarness(
                serverPrefs,
                true,
                120,
                () => Promise.resolve({ invalid: true }),
                (message) => {
                    const payload = readTestProperty(message, 'payload');
                    return readTestProperty(payload, 'event') ===
                        'analysis_interrupted'
                        ? Promise.reject(new Error('worker stopped'))
                        : Promise.resolve({ ok: true });
                },
            );

            try {
                await harness.emitPrefs(testCase.prefs);
                await harness.advanceBindingTime(
                    SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS[0],
                );
                harness.probeContent();
                await harness.advanceBindingTime(0);

                expect(
                    harness
                        .messagesOfType(
                            TOPSKIP_MESSAGE.SERVER_ANALYSIS_SESSION_EVENT,
                        )
                        .filter((message) =>
                            isAnalysisInterruptionMessage(message),
                        ),
                ).toHaveLength(1);
            } finally {
                harness.dispose();
            }
        });
    }

    it('clears terminal-event delivery when the content context is disposed', async () => {
        const harness = await createRouteHarness(
            serverPrefs,
            true,
            120,
            () => Promise.resolve({ invalid: true }),
            (message) => {
                const payload = readTestProperty(message, 'payload');
                return readTestProperty(payload, 'event') ===
                    'analysis_interrupted'
                    ? Promise.reject(new Error('worker stopped'))
                    : Promise.resolve({ ok: true });
            },
        );

        try {
            harness.disposeContent();
            await harness.advanceBindingTime(
                SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS[0],
            );

            expect(
                harness
                    .messagesOfType(
                        TOPSKIP_MESSAGE.SERVER_ANALYSIS_SESSION_EVENT,
                    )
                    .filter((message) =>
                        isAnalysisInterruptionMessage(message),
                    ),
            ).toHaveLength(1);
        } finally {
            harness.dispose();
        }
    });

    it('cancels a pending retry when the watch route changes', async () => {
        const harness = await createRouteHarness(
            serverPrefs,
            true,
            120,
            (message) => {
                const payload = readTestProperty(message, 'payload');
                if (readTestProperty(payload, 'videoId') === 'dQw4w9WgXcQ') {
                    return Promise.reject(new Error('message port closed'));
                }
                return Promise.resolve({ ok: true, status: 'no_promo' });
            },
        );

        try {
            await harness.navigateToVideo('e2eFixture1');
            await harness.advanceBindingTime(
                SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS[0],
            );

            const oldRequests = harness
                .messagesOfType(TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS)
                .filter((message) => {
                    const payload = readTestProperty(message, 'payload');
                    return (
                        readTestProperty(payload, 'videoId') === 'dQw4w9WgXcQ'
                    );
                });
            expect(oldRequests).toHaveLength(1);
        } finally {
            harness.dispose();
        }
    });

    for (const testCase of [
        {
            label: 'disabled',
            prefs: { ...serverPrefs, enabled: false },
        },
        {
            label: 'BYOK mode',
            prefs: {
                ...serverPrefs,
                analysisMode: ANALYSIS_MODE.Byok,
            },
        },
    ]) {
        it(`cancels a pending retry when prefs switch to ${testCase.label}`, async () => {
            const harness = await createRouteHarness(
                serverPrefs,
                true,
                120,
                () => Promise.reject(new Error('message port closed')),
            );

            try {
                await harness.emitPrefs(testCase.prefs);
                await harness.advanceBindingTime(
                    SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS[0],
                );

                expect(
                    harness.messagesOfType(
                        TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS,
                    ),
                ).toHaveLength(1);
                expect(capture).toHaveBeenCalledOnce();
            } finally {
                harness.dispose();
            }
        });
    }

    it('keeps replacement operation ownership after the old promise settles', async () => {
        let resolveOld: (response: unknown) => void = () => undefined;
        let resolveReplacement: (response: unknown) => void = () => undefined;
        const oldRequest = new Promise<unknown>((resolve) => {
            resolveOld = resolve;
        });
        const replacementRequest = new Promise<unknown>((resolve) => {
            resolveReplacement = resolve;
        });
        const harness = await createRouteHarness(
            serverPrefs,
            true,
            120,
            (message) => {
                const type = readTestProperty(message, 'type');
                const payload = readTestProperty(message, 'payload');
                const videoId = readTestProperty(payload, 'videoId');
                if (type === TOPSKIP_MESSAGE.REFRESH_SERVER_ANALYSIS_STATUS) {
                    return Promise.resolve({ ok: true, status: 'no_promo' });
                }
                return videoId === 'dQw4w9WgXcQ'
                    ? oldRequest
                    : replacementRequest;
            },
        );

        try {
            await harness.navigateToVideo('e2eFixture1');
            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS),
            ).toHaveLength(2);

            resolveOld({ ok: true, status: 'ready' });
            await harness.advanceBindingTime(0);
            resolveReplacement({
                ok: true,
                status: 'processing',
                jobId: 'job-replacement',
                pollAfterSec: 1,
                identity: {
                    videoId: 'e2eFixture1',
                    languageCode: 'en',
                    transcriptHash: '1'.repeat(64),
                    algorithmVersion: 'server-v6',
                },
            });
            await harness.advanceBindingTime(MS_PER_SECOND);

            const polls = harness.messagesOfType(
                TOPSKIP_MESSAGE.REFRESH_SERVER_ANALYSIS_STATUS,
            );
            expect(polls).toHaveLength(1);
            expect(
                readTestProperty(
                    readTestProperty(polls[0], 'payload'),
                    'videoId',
                ),
            ).toBe('e2eFixture1');
            expect(capture).toHaveBeenCalledTimes(2);
        } finally {
            harness.dispose();
        }
    });

    it('performs one final poll at the analysis deadline', async () => {
        const harness = await createRouteHarness(
            serverPrefs,
            true,
            120,
            (message) => {
                const payload = readTestProperty(message, 'payload');
                const videoId = readTestProperty(payload, 'videoId');
                return Promise.resolve({
                    ok: true,
                    status: 'processing',
                    jobId: 'job-deadline',
                    pollAfterSec: 60 * 60,
                    identity: {
                        videoId,
                        languageCode: 'en',
                        transcriptHash: 'd'.repeat(64),
                        algorithmVersion: 'server-v6',
                    },
                });
            },
        );

        try {
            await harness.advanceBindingTime(
                SERVER_ANALYSIS_SESSION_DEADLINE_MS,
            );

            expect(
                harness.messagesOfType(
                    TOPSKIP_MESSAGE.REFRESH_SERVER_ANALYSIS_STATUS,
                ),
            ).toHaveLength(1);
            const interruption = harness
                .messagesOfType(
                    TOPSKIP_MESSAGE.SERVER_ANALYSIS_SESSION_EVENT,
                )
                .find((message) => {
                    const payload = readTestProperty(message, 'payload');
                    return (
                        readTestProperty(payload, 'event') ===
                            'analysis_interrupted' &&
                        readTestProperty(payload, 'reason') ===
                            'analysis_deadline_exceeded'
                    );
                });
            expect(interruption).toBeDefined();
            await harness.pollBindings();
            expect(capture).toHaveBeenCalledOnce();
        } finally {
            harness.dispose();
        }
    });

    it('dedupes terminal blocks without invalidating their pending ack', async () => {
        let resolveRequest: (response: unknown) => void = () => undefined;
        const pendingRequest = new Promise<unknown>((resolve) => {
            resolveRequest = resolve;
        });
        const harness = await createRouteHarness(
            serverPrefs,
            true,
            120,
            () => pendingRequest,
        );

        try {
            const request = harness.messagesOfType(
                TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS,
            )[0];
            const payload = readTestProperty(request, 'payload');
            const sessionId = readTestProperty(payload, 'sessionId');
            const terminal = {
                type: TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED,
                source: 'server' as const,
                sessionId,
                videoId: 'dQw4w9WgXcQ',
                promoBlocks: [{ startSec: 10, endSec: 20 }],
            };
            await harness.emitRuntimeMessage(terminal);
            await harness.emitRuntimeMessage(terminal);
            resolveRequest({ ok: true, status: 'ready' });
            await harness.advanceBindingTime(0);
            await harness.advanceBindingTime(
                SERVER_ANALYSIS_RUNTIME_MESSAGE_TIMEOUT_MS +
                    SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS[0],
            );

            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS),
            ).toHaveLength(1);
            expect(capture).toHaveBeenCalledOnce();
        } finally {
            harness.dispose();
        }
    });
});
