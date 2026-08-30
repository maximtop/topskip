import { describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';

const {
    addRuntimeMessageListener,
    cancelCaptions,
    removeRuntimeMessageListener,
    capture,
    disposeCaptions,
    getManifest,
    preparePageBridge,
    scheduleForVideoId,
    sendMessage,
} = vi.hoisted(() => ({
    addRuntimeMessageListener:
        vi.fn<(listener: (message: unknown) => unknown) => void>(),
    cancelCaptions: vi.fn(),
    removeRuntimeMessageListener: vi.fn(),
    capture: vi.fn(),
    disposeCaptions: vi.fn(),
    getManifest: vi.fn(() => ({ version: '0.1.0' })),
    preparePageBridge: vi.fn(),
    scheduleForVideoId: vi.fn(),
    sendMessage: vi.fn<(message: unknown) => Promise<unknown>>(),
}));

vi.mock('@/shared/browser', () => ({
    default: {
        i18n: {
            getMessage: (key: string): string => key,
        },
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
        cancel: cancelCaptions,
        capture,
        dispose: disposeCaptions,
        preparePageBridge,
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
    explainPromoBlocksRejection,
    PROMO_BLOCKS_REJECTION_CAUSE,
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
import {
    DEBUG_LOG_CLIENT_FLUSH_DELAY_MS,
    DEBUG_LOG_POLL_SUMMARY_EVERY_POLLS,
} from '@/shared/debug-log-constants';
import { DEBUG_LOG_EVENT } from '@/shared/debug-log-events';

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
                enabled: true,
                analysisMode: ANALYSIS_MODE.Server,
                activeSessionId: '00000000-0000-4000-8000-000000000002',
                messageSessionId: '00000000-0000-4000-8000-000000000001',
            }),
        ).toBe(false);
        expect(
            shouldAcceptPromoBlocksForActiveRoute({
                currentVideoId: 'dQw4w9WgXcQ',
                messageVideoId: 'dQw4w9WgXcQ',
                source: 'server_cache',
                enabled: true,
                analysisMode: ANALYSIS_MODE.Server,
                activeSessionId: '00000000-0000-4000-8000-000000000002',
                messageSessionId: '00000000-0000-4000-8000-000000000002',
            }),
        ).toBe(true);
        expect(
            shouldAcceptPromoBlocksForActiveRoute({
                currentVideoId: 'dQw4w9WgXcQ',
                messageVideoId: 'dQw4w9WgXcQ',
                source: 'local_provider',
                enabled: true,
                analysisMode: ANALYSIS_MODE.Byok,
                activeSessionId: null,
                messageSessionId: undefined,
            }),
        ).toBe(true);
        expect(
            shouldAcceptPromoBlocksForActiveRoute({
                currentVideoId: 'dQw4w9WgXcQ',
                messageVideoId: 'dQw4w9WgXcQ',
                source: 'local_provider',
                enabled: false,
                analysisMode: null,
                activeSessionId: null,
            }),
        ).toBe(false);
        expect(
            shouldAcceptPromoBlocksForActiveRoute({
                currentVideoId: 'dQw4w9WgXcQ',
                messageVideoId: 'dQw4w9WgXcQ',
                source: 'local_provider',
                enabled: true,
                analysisMode: ANALYSIS_MODE.Server,
                activeSessionId: null,
            }),
        ).toBe(false);
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

        private readonly activeListeners = new Map<
            string,
            Set<EventListenerOrEventListenerObject>
        >();

        /**
         * Tracks live playback listeners so the static-content inert boundary
         * is observable without inspecting implementation fields.
         *
         * @param type - DOM event name.
         * @param callback - Listener registered by the content bundle.
         * @param options - Native listener options.
         */
        override addEventListener(
            type: string,
            callback: EventListenerOrEventListenerObject | null,
            options?: boolean | AddEventListenerOptions,
        ): void {
            if (callback !== null) {
                const listeners = this.activeListeners.get(type) ?? new Set();
                listeners.add(callback);
                this.activeListeners.set(type, listeners);
            }
            super.addEventListener(type, callback, options);
        }

        /**
         * Mirrors removals so disabled-route assertions measure active listeners.
         *
         * @param type - DOM event name.
         * @param callback - Listener removed by the content bundle.
         * @param options - Native listener options.
         */
        override removeEventListener(
            type: string,
            callback: EventListenerOrEventListenerObject | null,
            options?: boolean | EventListenerOptions,
        ): void {
            if (callback !== null) {
                this.activeListeners.get(type)?.delete(callback);
            }
            super.removeEventListener(type, callback, options);
        }

        /**
         * Exposes the current listener total through the fake DOM boundary.
         *
         * @returns Number of playback listeners still attached.
         */
        activeListenerCount(): number {
            return [...this.activeListeners.values()].reduce(
                (total, listeners) => total + listeners.size,
                0,
            );
        }
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
        dispatchRuntimeMessage(message: unknown): unknown;
        probeContent(): unknown;
        routeStatus(): unknown;
        setRouteWithoutNavigation(pathname: string, search: string): void;
        messagesOfType(type: string): unknown[];
        activeVideoListenerCount(): number;
        dispatchTimeUpdate(currentTime: number): number;
        dispatchVideoEvent(type: 'seeking' | 'seeked', currentTime?: number): void;
        navigateToVideo(videoId: string): Promise<void>;
        pollBindings(): Promise<void>;
        replaceVideoElement(): Promise<void>;
        setVideoDuration(durationSec: number): void;
        videoQueryCount(): number;
        fetchCallCount(): number;
        dispose(): void;
    }> {
        vi.useFakeTimers();
        vi.resetModules();
        sendMessage.mockReset();
        addRuntimeMessageListener.mockReset();
        cancelCaptions.mockReset();
        removeRuntimeMessageListener.mockReset();
        capture.mockReset();
        disposeCaptions.mockReset();
        preparePageBridge.mockReset();
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
        let videoQueryCount = 0;

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
                videoQueryCount += 1;
                return selector === YOUTUBE_VIDEO_ELEMENT_SELECTOR
                    ? video
                    : null;
            },
            getElementById: (): null => null,
            createElement: (): Record<string, unknown> => ({
                id: '',
                style: { cssText: '', opacity: '' },
                textContent: '',
                remove: vi.fn(),
            }),
            documentElement: { appendChild: vi.fn() },
        });
        vi.stubGlobal('window', {
            addEventListener: windowEvents.addEventListener.bind(windowEvents),
            removeEventListener:
                windowEvents.removeEventListener.bind(windowEvents),
            clearTimeout: globalThis.clearTimeout,
            dispatchEvent: windowEvents.dispatchEvent.bind(windowEvents),
            matchMedia: (): { matches: boolean } => ({ matches: true }),
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
            dispatchRuntimeMessage(message: unknown): unknown {
                return getRuntimeMessageListener()(message);
            },
            probeContent(): unknown {
                return getRuntimeMessageListener()({
                    type: TOPSKIP_MESSAGE.CONTENT_SCRIPT_READY,
                });
            },
            routeStatus(): unknown {
                return getRuntimeMessageListener()({
                    type: TOPSKIP_MESSAGE.CONTENT_ROUTE_STATUS,
                });
            },
            setRouteWithoutNavigation(pathname: string, search: string): void {
                locationState.pathname = pathname;
                locationState.search = search;
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
            activeVideoListenerCount(): number {
                return video?.activeListenerCount() ?? 0;
            },
            dispatchTimeUpdate(currentTime: number): number {
                if (video === null) {
                    throw new Error('Missing fake video.');
                }
                video.currentTime = currentTime;
                video.dispatchEvent(new Event('timeupdate'));
                return video.currentTime;
            },
            dispatchVideoEvent(
                type: 'seeking' | 'seeked',
                currentTime?: number,
            ): void {
                if (video === null) {
                    throw new Error('Missing fake video.');
                }
                if (currentTime !== undefined) {
                    video.currentTime = currentTime;
                }
                video.dispatchEvent(new Event(type));
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
            videoQueryCount(): number {
                return videoQueryCount;
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

    type RouteHarness = Awaited<ReturnType<typeof createRouteHarness>>;

    /**
     * One content event as appended through `DEBUG_LOG_APPEND`.
     */
    type AppendedDebugLogEvent = {
        event: unknown;
        fields: Record<string, unknown>;
        video: unknown;
        session: unknown;
        job: unknown;
    };

    /**
     * Boots the watch harness with the background reporting logging as on.
     *
     * @param serverResponder - Optional Server runtime responder.
     * @returns Route harness whose GET_PREFS reply carries `debugLogEnabled`.
     */
    async function createLoggingHarness(
        serverResponder?: ServerRuntimeResponder,
    ): Promise<RouteHarness> {
        return createRouteHarness(
            serverPrefs,
            true,
            120,
            serverResponder,
            undefined,
            () =>
                Promise.resolve({
                    ok: true,
                    prefs: serverPrefs,
                    debugLogEnabled: true,
                }),
        );
    }

    /**
     * Flattens every appended batch into its events.
     *
     * @param harness - Active route harness.
     * @returns Appended content events in send order.
     */
    function appendedDebugLogEvents(
        harness: RouteHarness,
    ): AppendedDebugLogEvent[] {
        return harness
            .messagesOfType(TOPSKIP_MESSAGE.DEBUG_LOG_APPEND)
            .flatMap((message): unknown[] => {
                const events = readTestProperty(
                    readTestProperty(message, 'payload'),
                    'events',
                );
                return Array.isArray(events) ? events : [];
            })
            .map((event: unknown): AppendedDebugLogEvent => {
                const fields = readTestProperty(event, 'fields');
                return {
                    event: readTestProperty(event, 'event'),
                    fields:
                        fields !== null && typeof fields === 'object'
                            ? Object.fromEntries(Object.entries(fields))
                            : {},
                    video: readTestProperty(event, 'video'),
                    session: readTestProperty(event, 'session'),
                    job: readTestProperty(event, 'job'),
                };
            });
    }

    /**
     * Selects appended events by name.
     *
     * @param harness - Active route harness.
     * @param name - Debug log event name.
     * @returns Matching events in send order.
     */
    function appendedEventsNamed(
        harness: RouteHarness,
        name: string,
    ): AppendedDebugLogEvent[] {
        return appendedDebugLogEvents(harness).filter(
            (event) => event.event === name,
        );
    }

    const NEVER_RESPOND: ServerRuntimeResponder = () =>
        new Promise<unknown>(() => undefined);

    /**
     * Delivers Server blocks for the harness's live session, which stays
     * active (and pollable) because the submit ack never resolves.
     *
     * @param harness - Logging harness created with `NEVER_RESPOND`.
     * @param promoBlocks - Blocks to deliver for `dQw4w9WgXcQ`.
     * @returns Resolves after the delivery and one client flush.
     */
    async function deliverServerBlocks(
        harness: RouteHarness,
        promoBlocks: PromoBlock[],
    ): Promise<void> {
        const request = harness.messagesOfType(
            TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS,
        )[0];
        const sessionId = readTestProperty(
            readTestProperty(request, 'payload'),
            'sessionId',
        );
        await harness.emitRuntimeMessage({
            type: TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED,
            source: 'server' as const,
            sessionId,
            videoId: 'dQw4w9WgXcQ',
            promoBlocks,
        });
        await harness.advanceBindingTime(DEBUG_LOG_CLIENT_FLUSH_DELAY_MS);
    }

    /**
     * Finds console-relay lines that must never be printed by the skip path.
     *
     * @param harness - Active route harness.
     * @returns Relayed `CONTENT_LOG` first arguments.
     */
    function relayedConsoleHeads(harness: RouteHarness): unknown[] {
        return harness
            .messagesOfType(TOPSKIP_MESSAGE.CONTENT_LOG)
            .map((message): unknown => {
                const args = readTestProperty(message, 'args');
                if (!Array.isArray(args)) {
                    return undefined;
                }
                // Array.isArray narrows to any[]; rebind the head as unknown
                // so the relay probe never leaks `any` into assertions.
                const head: unknown = args[0];
                return head;
            });
    }

    it('acknowledges the background readiness probe and disposes replacement state', async () => {
        const harness = await createRouteHarness(serverPrefs);
        try {
            const ack = harness.probeContent();

            // Only a Promise (or `true` + sendResponse) becomes a reply through
            // webextension-polyfill; a plain object would be dropped silently.
            expect(ack).toBeInstanceOf(Promise);
            await expect(ack).resolves.toEqual({
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

    it('reports exact live ownership without exposing the document URL', async () => {
        const harness = await createRouteHarness(serverPrefs);
        try {
            const request = harness.messagesOfType(
                TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS,
            )[0];
            const requestPayload = readTestProperty(request, 'payload');
            const pendingStatus = harness.routeStatus();

            expect(pendingStatus).toBeInstanceOf(Promise);
            const status: unknown = await pendingStatus;
            expect(status).toEqual({
                ok: true,
                protocolVersion: CONTENT_SCRIPT_PROTOCOL_VERSION,
                extensionVersion: '0.1.0',
                videoId: 'dQw4w9WgXcQ',
                enabled: true,
                analysisMode: ANALYSIS_MODE.Server,
                serverSessionId: readTestProperty(
                    requestPayload,
                    'sessionId',
                ),
            });
            expect(readTestProperty(status, 'url')).toBeUndefined();
        } finally {
            harness.dispose();
        }
    });

    it('invalidates ownership from the live pathname before SPA cleanup', async () => {
        const harness = await createRouteHarness(serverPrefs);
        try {
            harness.setRouteWithoutNavigation(
                '/shorts/replacement',
                '?v=dQw4w9WgXcQ',
            );

            await expect(harness.routeStatus()).resolves.toEqual({
                ok: true,
                protocolVersion: CONTENT_SCRIPT_PROTOCOL_VERSION,
                extensionVersion: '0.1.0',
                videoId: null,
                enabled: true,
                analysisMode: null,
                serverSessionId: null,
            });
        } finally {
            harness.dispose();
        }
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
            expect(harness.videoQueryCount()).toBe(0);
            expect(harness.activeVideoListenerCount()).toBe(0);
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
            expect(harness.videoQueryCount()).toBe(0);
            expect(harness.activeVideoListenerCount()).toBe(0);
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
            expect(harness.videoQueryCount()).toBe(0);
            expect(harness.activeVideoListenerCount()).toBe(0);
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
            expect(disabledHarness.videoQueryCount()).toBe(0);
            expect(disabledHarness.activeVideoListenerCount()).toBe(0);
            expect(preparePageBridge).not.toHaveBeenCalled();
            expect(scheduleForVideoId).not.toHaveBeenCalled();
            expect(cancelCaptions).not.toHaveBeenCalled();
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

    it('routes exactly once after re-enabling a disabled static context', async () => {
        const disabledPrefs = { ...serverPrefs, enabled: false };
        const harness = await createRouteHarness(disabledPrefs);

        try {
            expect(harness.videoQueryCount()).toBe(0);
            expect(harness.activeVideoListenerCount()).toBe(0);

            await harness.emitPrefs(serverPrefs);
            await harness.pollBindings();

            expect(capture).toHaveBeenCalledOnce();
            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS),
            ).toHaveLength(1);
            expect(harness.activeVideoListenerCount()).toBe(3);
        } finally {
            harness.dispose();
        }
    });

    it('does not preflight or schedule Private BYOK while disabled at load', async () => {
        const disabledByokPrefs: UserPreferences = {
            ...serverPrefs,
            enabled: false,
            analysisMode: ANALYSIS_MODE.Byok,
        };
        const harness = await createRouteHarness(disabledByokPrefs);

        try {
            expect(harness.videoQueryCount()).toBe(0);
            expect(harness.activeVideoListenerCount()).toBe(0);
            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.PREFLIGHT_BYOK_SETUP),
            ).toHaveLength(0);
            expect(preparePageBridge).not.toHaveBeenCalled();
            expect(scheduleForVideoId).not.toHaveBeenCalled();
            expect(capture).not.toHaveBeenCalled();
            expect(cancelCaptions).not.toHaveBeenCalled();
        } finally {
            harness.dispose();
        }
    });

    it('cancels active capture and ignores its completion after disable', async () => {
        let resolveCapture: (result: unknown) => void = () => undefined;
        const captureOwner: { signal: AbortSignal | null } = {
            signal: null,
        };
        const pendingCapture = new Promise<unknown>((resolve) => {
            resolveCapture = resolve;
        });
        const harness = await createRouteHarness(
            serverPrefs,
            true,
            120,
            undefined,
            undefined,
            undefined,
            (input) => {
                captureOwner.signal = input.signal;
                return pendingCapture;
            },
        );

        try {
            expect(capture).toHaveBeenCalledOnce();
            expect(harness.activeVideoListenerCount()).toBe(3);

            await harness.emitPrefs({ ...serverPrefs, enabled: false });

            expect(captureOwner.signal?.aborted).toBe(true);
            expect(cancelCaptions).toHaveBeenCalledOnce();
            expect(harness.activeVideoListenerCount()).toBe(0);
            await expect(harness.routeStatus()).resolves.toMatchObject({
                enabled: false,
                analysisMode: null,
                serverSessionId: null,
            });

            resolveCapture({
                status: 'ready',
                payload: {
                    ok: true,
                    videoId: 'dQw4w9WgXcQ',
                    languageCode: 'en',
                    segments: [
                        { startSec: 0, durationSec: 1, text: 'Late caption' },
                    ],
                },
            });
            await harness.pollBindings();

            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS),
            ).toHaveLength(0);
            expect(harness.activeVideoListenerCount()).toBe(0);
            expect(cancelCaptions).toHaveBeenCalledOnce();
        } finally {
            harness.dispose();
        }
    });

    it('ignores LocalProvider blocks delivered after disable and re-enable', async () => {
        const byokPrefs: UserPreferences = {
            ...serverPrefs,
            analysisMode: ANALYSIS_MODE.Byok,
        };
        const harness = await createRouteHarness(byokPrefs);

        try {
            await harness.emitPrefs({ ...byokPrefs, enabled: false });
            await harness.emitRuntimeMessage({
                type: TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED,
                source: 'local_provider',
                videoId: 'dQw4w9WgXcQ',
                promoBlocks: [{ startSec: 10, endSec: 20 }],
            });
            await harness.emitPrefs(byokPrefs);

            expect(harness.dispatchTimeUpdate(9)).toBe(9);
            expect(harness.dispatchTimeUpdate(10.2)).toBe(10.2);
        } finally {
            harness.dispose();
        }
    });

    it('rejects late LocalProvider blocks after replacing BYOK with Server', async () => {
        const byokPrefs: UserPreferences = {
            ...serverPrefs,
            analysisMode: ANALYSIS_MODE.Byok,
        };
        const harness = await createRouteHarness(byokPrefs);

        try {
            await harness.emitPrefs(serverPrefs);
            await harness.emitRuntimeMessage({
                type: TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED,
                source: 'local_provider',
                videoId: 'dQw4w9WgXcQ',
                promoBlocks: [{ startSec: 10, endSec: 20 }],
            });

            expect(cancelCaptions).toHaveBeenCalledOnce();
            expect(harness.dispatchTimeUpdate(9)).toBe(9);
            expect(harness.dispatchTimeUpdate(10.2)).toBe(10.2);
        } finally {
            harness.dispose();
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
            expect(capture).toHaveBeenCalledOnce();
            expect(
                harness.messagesOfType(
                    TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS,
                ),
            ).toHaveLength(1);
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

    describe('debug logging state propagation', () => {
        it('applies the flag from the preferences reply before routing and logs prefs-received', async () => {
            const harness = await createLoggingHarness();
            try {
                await harness.advanceBindingTime(DEBUG_LOG_CLIENT_FLUSH_DELAY_MS);

                expect(
                    harness.messagesOfType(TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS),
                ).toHaveLength(1);
                const received = appendedEventsNamed(
                    harness,
                    DEBUG_LOG_EVENT.PrefsReceived,
                );
                expect(received).toHaveLength(1);
                expect(received[0]).toMatchObject({
                    fields: { reason: 'bootstrap' },
                    video: 'dQw4w9WgXcQ',
                });
            } finally {
                harness.dispose();
            }
        });

        it('keeps the client off when the preferences reply omits the flag', async () => {
            const harness = await createRouteHarness(serverPrefs);
            try {
                await harness.emitPrefs({ ...serverPrefs, enabled: true });
                await harness.advanceBindingTime(DEBUG_LOG_CLIENT_FLUSH_DELAY_MS * 3);

                expect(
                    harness.messagesOfType(TOPSKIP_MESSAGE.DEBUG_LOG_APPEND),
                ).toHaveLength(0);
            } finally {
                harness.dispose();
            }
        });

        it('applies DEBUG_LOG_STATE_UPDATED without touching the player', async () => {
            const harness = await createRouteHarness({
                ...serverPrefs,
                enabled: false,
            });
            try {
                const queriesBefore = harness.videoQueryCount();
                const listenersBefore = harness.activeVideoListenerCount();

                const reply = harness.dispatchRuntimeMessage({
                    type: TOPSKIP_MESSAGE.DEBUG_LOG_STATE_UPDATED,
                    enabled: true,
                });
                await expect(reply).resolves.toEqual({ ok: true });
                expect(harness.videoQueryCount()).toBe(queriesBefore);
                expect(harness.activeVideoListenerCount()).toBe(listenersBefore);

                await harness.emitPrefs({ ...serverPrefs, enabled: false });
                await harness.advanceBindingTime(DEBUG_LOG_CLIENT_FLUSH_DELAY_MS);

                expect(
                    appendedEventsNamed(harness, DEBUG_LOG_EVENT.PrefsReceived),
                ).toEqual([
                    expect.objectContaining({ fields: { reason: 'broadcast' } }),
                ]);
            } finally {
                harness.dispose();
            }
        });

        it('discards queued events when the switch turns off', async () => {
            const harness = await createLoggingHarness();
            try {
                await harness.emitRuntimeMessage({
                    type: TOPSKIP_MESSAGE.DEBUG_LOG_STATE_UPDATED,
                    enabled: false,
                });
                await harness.emitPrefs(serverPrefs);
                await harness.advanceBindingTime(DEBUG_LOG_CLIENT_FLUSH_DELAY_MS * 2);

                expect(
                    harness.messagesOfType(TOPSKIP_MESSAGE.DEBUG_LOG_APPEND),
                ).toHaveLength(0);
            } finally {
                harness.dispose();
            }
        });

        it('flushes pending events when the content context is replaced', async () => {
            const harness = await createLoggingHarness();
            try {
                expect(
                    harness.messagesOfType(TOPSKIP_MESSAGE.DEBUG_LOG_APPEND),
                ).toHaveLength(0);

                harness.disposeContent();

                expect(
                    harness.messagesOfType(TOPSKIP_MESSAGE.DEBUG_LOG_APPEND),
                ).toHaveLength(1);
                expect(
                    appendedEventsNamed(harness, DEBUG_LOG_EVENT.PrefsReceived),
                ).toHaveLength(1);
                await harness.advanceBindingTime(DEBUG_LOG_CLIENT_FLUSH_DELAY_MS * 2);
                expect(
                    harness.messagesOfType(TOPSKIP_MESSAGE.DEBUG_LOG_APPEND),
                ).toHaveLength(1);
            } finally {
                harness.dispose();
            }
        });
    });

    describe('skip and seek diagnostics', () => {
        it('logs skip-applied once when playback crosses a block', async () => {
            const harness = await createLoggingHarness(NEVER_RESPOND);
            try {
                await deliverServerBlocks(harness, [{ startSec: 10, endSec: 20 }]);

                expect(harness.dispatchTimeUpdate(9)).toBe(9);
                expect(harness.dispatchTimeUpdate(10.2)).toBe(20);
                await harness.advanceBindingTime(DEBUG_LOG_CLIENT_FLUSH_DELAY_MS);

                const applied = appendedEventsNamed(harness, DEBUG_LOG_EVENT.SkipApplied);
                expect(applied).toHaveLength(1);
                expect(applied[0]).toMatchObject({
                    video: 'dQw4w9WgXcQ',
                    fields: { block: 0, fromSec: 10.2, toSec: 20, deltaSec: 1.2 },
                });
                expect(typeof applied[0]?.session).toBe('string');
            } finally {
                harness.dispose();
            }
        });

        it('logs skip-suppressed once per block and reason', async () => {
            const harness = await createLoggingHarness(NEVER_RESPOND);
            try {
                // Reach 9s before blocks arrive: with an empty block list the
                // hook only tracks position, so the harness's 0→9 teleport (a
                // stand-in for continuous playback) logs no jump summary.
                harness.dispatchTimeUpdate(9);
                await deliverServerBlocks(harness, [{ startSec: 10, endSec: 20 }]);
                harness.dispatchTimeUpdate(10.2);
                // Jump back inside the fired block: one already-fired entry,
                // then silence while the situation is unchanged.
                harness.dispatchTimeUpdate(12);
                harness.dispatchTimeUpdate(12.25);
                harness.dispatchTimeUpdate(12.5);
                await harness.advanceBindingTime(DEBUG_LOG_CLIENT_FLUSH_DELAY_MS);

                const suppressed = appendedEventsNamed(
                    harness,
                    DEBUG_LOG_EVENT.SkipSuppressed,
                );
                expect(suppressed).toHaveLength(1);
                expect(suppressed[0]?.fields).toEqual({
                    block: 0,
                    reason: 'already-fired',
                    fromSec: 20,
                    toSec: 12,
                });
                // Hoisted as `unknown` because the matcher factory returns
                // `any`, which no-unsafe-assignment refuses inside a literal.
                const jumpFields: unknown = expect.objectContaining({
                    reason: 'jump',
                    fromSec: 20,
                    toSec: 12,
                    deltaSec: -8,
                });
                expect(
                    appendedEventsNamed(harness, DEBUG_LOG_EVENT.SeekSummary),
                ).toEqual([
                    expect.objectContaining({ fields: jumpFields }),
                ]);
            } finally {
                harness.dispose();
            }
        });

        it.each([
            {
                reason: 'not-crossed',
                blocks: [{ startSec: 30, endSec: 40 }],
                play: (harness: RouteHarness): void => {
                    harness.dispatchVideoEvent('seeked', 35);
                    harness.dispatchTimeUpdate(35.2);
                },
            },
            {
                reason: 'seek-guard',
                blocks: [{ startSec: 10, endSec: 20 }],
                play: (harness: RouteHarness): void => {
                    harness.dispatchTimeUpdate(5);
                    harness.dispatchTimeUpdate(12);
                },
            },
            {
                reason: 'seeking',
                blocks: [{ startSec: 10, endSec: 20 }],
                play: (harness: RouteHarness): void => {
                    harness.dispatchTimeUpdate(9);
                    harness.dispatchVideoEvent('seeking');
                    harness.dispatchTimeUpdate(10.2);
                },
            },
            {
                reason: 'no-duration',
                blocks: [{ startSec: 10, endSec: 20 }],
                play: (harness: RouteHarness): void => {
                    harness.setVideoDuration(0);
                    harness.dispatchTimeUpdate(9);
                    harness.dispatchTimeUpdate(10.2);
                },
            },
        ])('logs skip-suppressed with reason $reason', async ({ reason, blocks, play }) => {
            const harness = await createLoggingHarness(NEVER_RESPOND);
            try {
                await deliverServerBlocks(harness, blocks);
                play(harness);
                await harness.advanceBindingTime(DEBUG_LOG_CLIENT_FLUSH_DELAY_MS);

                const suppressed = appendedEventsNamed(
                    harness,
                    DEBUG_LOG_EVENT.SkipSuppressed,
                );
                expect(suppressed).toHaveLength(1);
                expect(suppressed[0]?.fields).toMatchObject({ block: 0, reason });
                expect(
                    appendedEventsNamed(harness, DEBUG_LOG_EVENT.SkipApplied),
                ).toHaveLength(0);
            } finally {
                harness.dispose();
            }
        });

        it('logs fired-reset only when a backward seek clears keys, plus seek summaries', async () => {
            const harness = await createLoggingHarness(NEVER_RESPOND);
            try {
                // Reach 9s before blocks arrive: with an empty block list the
                // hook only tracks position, so the harness's 0→9 teleport (a
                // stand-in for continuous playback) logs no jump summary.
                harness.dispatchTimeUpdate(9);
                await deliverServerBlocks(harness, [{ startSec: 10, endSec: 20 }]);
                harness.dispatchTimeUpdate(10.2);
                // Backward seek that stays past the block start clears nothing.
                harness.dispatchVideoEvent('seeking');
                harness.dispatchVideoEvent('seeked', 15);
                // Backward seek before the block start clears the fired key.
                harness.dispatchVideoEvent('seeking');
                harness.dispatchVideoEvent('seeked', 5);
                await harness.advanceBindingTime(DEBUG_LOG_CLIENT_FLUSH_DELAY_MS);

                expect(
                    appendedEventsNamed(harness, DEBUG_LOG_EVENT.FiredReset),
                ).toEqual([
                    expect.objectContaining({
                        fields: { count: 1, reason: 'seeked' },
                    }),
                ]);
                const seeks = appendedEventsNamed(harness, DEBUG_LOG_EVENT.SeekSummary);
                expect(seeks.map((event) => event.fields)).toEqual([
                    expect.objectContaining({ reason: 'seek', fromSec: 20, toSec: 15 }),
                    expect.objectContaining({ reason: 'seek', fromSec: 15, toSec: 5 }),
                ]);
                // The cleared block fires again on replay.
                expect(harness.dispatchTimeUpdate(9)).toBe(9);
                expect(harness.dispatchTimeUpdate(10.2)).toBe(20);
            } finally {
                harness.dispose();
            }
        });

        it('sends nothing across 1,000 time-update ticks without a decision', async () => {
            const harness = await createLoggingHarness(NEVER_RESPOND);
            try {
                await deliverServerBlocks(harness, [{ startSec: 50, endSec: 60 }]);
                const sentBefore = sendMessage.mock.calls.length;

                for (let tick = 1; tick <= 1000; tick += 1) {
                    harness.dispatchTimeUpdate(tick * 0.04);
                }
                await harness.advanceBindingTime(DEBUG_LOG_CLIENT_FLUSH_DELAY_MS);

                expect(sendMessage.mock.calls.length).toBe(sentBefore);
            } finally {
                harness.dispose();
            }
        });

        it('prints no skip or seek lines through the console relay', async () => {
            const harness = await createLoggingHarness(NEVER_RESPOND);
            try {
                await deliverServerBlocks(harness, [{ startSec: 10, endSec: 20 }]);
                harness.dispatchTimeUpdate(9);
                harness.dispatchTimeUpdate(10.2);
                harness.dispatchVideoEvent('seeking');
                harness.dispatchVideoEvent('seeked', 5);
                harness.dispatchTimeUpdate(12);

                const heads = relayedConsoleHeads(harness);
                for (const forbidden of [
                    'SKIP block',
                    'timeupdate jump',
                    'seeking started at',
                    'backward seeked:',
                    'after reset fired=',
                    'forward seeked:',
                ]) {
                    expect(heads).not.toContain(forbidden);
                }
            } finally {
                harness.dispose();
            }
        });
    });

    describe('promo block delivery diagnostics', () => {
        it('explains every refusal the boolean gate makes', () => {
            const base = {
                currentVideoId: 'dQw4w9WgXcQ',
                messageVideoId: 'dQw4w9WgXcQ',
                source: 'server' as const,
                enabled: true,
                analysisMode: ANALYSIS_MODE.Server,
                activeSessionId: '00000000-0000-4000-8000-000000000002',
                messageSessionId: '00000000-0000-4000-8000-000000000002',
            };
            type AcceptanceCase = [
                Parameters<typeof explainPromoBlocksRejection>[0],
                string | null,
            ];
            const cases: AcceptanceCase[] = [
                [base, null],
                [{ ...base, enabled: false }, PROMO_BLOCKS_REJECTION_CAUSE.Disabled],
                [
                    { ...base, messageVideoId: 'aaaaaaaaaaa' },
                    PROMO_BLOCKS_REJECTION_CAUSE.VideoMismatch,
                ],
                [
                    { ...base, analysisMode: ANALYSIS_MODE.Byok },
                    PROMO_BLOCKS_REJECTION_CAUSE.RouteMismatch,
                ],
                [{ ...base, activeSessionId: null }, PROMO_BLOCKS_REJECTION_CAUSE.SessionMismatch],
                [
                    { ...base, messageSessionId: '00000000-0000-4000-8000-000000000001' },
                    PROMO_BLOCKS_REJECTION_CAUSE.SessionMismatch,
                ],
                [
                    { ...base, source: 'local_provider' as const, analysisMode: ANALYSIS_MODE.Byok },
                    null,
                ],
                [
                    { ...base, source: 'local_provider' as const },
                    PROMO_BLOCKS_REJECTION_CAUSE.RouteMismatch,
                ],
            ];
            for (const [input, cause] of cases) {
                expect(explainPromoBlocksRejection(input)).toBe(cause);
                expect(shouldAcceptPromoBlocksForActiveRoute(input)).toBe(cause === null);
            }
        });

        it('logs blocks-received with bounded timings and the delivery source', async () => {
            const harness = await createLoggingHarness(NEVER_RESPOND);
            try {
                await deliverServerBlocks(harness, [
                    { startSec: 10, endSec: 20 },
                    { startSec: 30.2, endSec: 40.5 },
                ]);

                const received = appendedEventsNamed(
                    harness,
                    DEBUG_LOG_EVENT.BlocksReceived,
                );
                expect(received).toHaveLength(1);
                expect(received[0]).toMatchObject({
                    video: 'dQw4w9WgXcQ',
                    fields: {
                        count: 2,
                        blocks: '10.0-20.0;30.2-40.5',
                        reason: 'server',
                    },
                });
                expect(typeof received[0]?.session).toBe('string');
                expect(relayedConsoleHeads(harness)).not.toContain('blocks received');
            } finally {
                harness.dispose();
            }
        });

        it('logs blocks-rejected with the real cause', async () => {
            const harness = await createLoggingHarness(NEVER_RESPOND);
            try {
                const request = harness.messagesOfType(
                    TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS,
                )[0];
                const sessionId = readTestProperty(
                    readTestProperty(request, 'payload'),
                    'sessionId',
                );
                const blocks = [{ startSec: 10, endSec: 20 }];
                await harness.emitRuntimeMessage({
                    type: TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED,
                    source: 'server' as const,
                    sessionId: '00000000-0000-4000-8000-000000000009',
                    videoId: 'dQw4w9WgXcQ',
                    promoBlocks: blocks,
                });
                await harness.emitRuntimeMessage({
                    type: TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED,
                    source: 'server' as const,
                    sessionId,
                    videoId: 'aaaaaaaaaaa',
                    promoBlocks: blocks,
                });
                await harness.emitRuntimeMessage({
                    type: TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED,
                    source: 'local_provider' as const,
                    videoId: 'dQw4w9WgXcQ',
                    promoBlocks: blocks,
                });
                await deliverServerBlocks(harness, blocks);
                await deliverServerBlocks(harness, blocks);

                const rejected = appendedEventsNamed(
                    harness,
                    DEBUG_LOG_EVENT.BlocksRejected,
                );
                expect(rejected.map((event) => event.fields)).toEqual([
                    { cause: 'session-mismatch', count: 1 },
                    { cause: 'video-mismatch', count: 1 },
                    { cause: 'route-mismatch', count: 1 },
                    { cause: 'duplicate-terminal', count: 1 },
                ]);
                expect(rejected[1]?.video).toBe('aaaaaaaaaaa');
                expect(
                    appendedEventsNamed(harness, DEBUG_LOG_EVENT.BlocksReceived),
                ).toHaveLength(1);
                expect(relayedConsoleHeads(harness)).not.toContain(
                    'PROMO_BLOCKS_DETECTED: videoId mismatch',
                );
            } finally {
                harness.dispose();
            }
        });

        it('logs blocks-rejected with cause disabled while the extension is off', async () => {
            const harness = await createRouteHarness({ ...serverPrefs, enabled: false });
            try {
                await harness.emitRuntimeMessage({
                    type: TOPSKIP_MESSAGE.DEBUG_LOG_STATE_UPDATED,
                    enabled: true,
                });
                await harness.emitRuntimeMessage({
                    type: TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED,
                    source: 'local_provider' as const,
                    videoId: 'dQw4w9WgXcQ',
                    promoBlocks: [{ startSec: 10, endSec: 20 }],
                });
                await harness.advanceBindingTime(DEBUG_LOG_CLIENT_FLUSH_DELAY_MS);

                expect(
                    appendedEventsNamed(harness, DEBUG_LOG_EVENT.BlocksRejected),
                ).toEqual([
                    expect.objectContaining({ fields: { cause: 'disabled', count: 1 } }),
                ]);
            } finally {
                harness.dispose();
            }
        });
    });

    describe('poll summaries', () => {
        /**
         * Builds a processing ack bound to the harness video.
         *
         * @param jobId - Backend job id.
         * @param videoId - Video id echoed from the request payload.
         * @param pollAfterSec - Poll cadence.
         * @returns Processing acknowledgement.
         */
        function processingAck(
            jobId: string,
            videoId: unknown,
            pollAfterSec = 1,
        ): Record<string, unknown> {
            return {
                ok: true,
                status: 'processing',
                jobId,
                pollAfterSec,
                identity: {
                    videoId,
                    languageCode: 'en',
                    transcriptHash: 'a'.repeat(64),
                    algorithmVersion: 'server-v6',
                },
            };
        }

        function payloadVideoId(message: Record<string, unknown>): unknown {
            return readTestProperty(readTestProperty(message, 'payload'), 'videoId');
        }

        function finalSummaries(harness: RouteHarness): AppendedDebugLogEvent[] {
            return appendedEventsNamed(harness, DEBUG_LOG_EVENT.PollSummary).filter(
                (event) => event.fields.terminal === true,
            );
        }

        it('emits exactly one final summary when polling ends with a terminal status', async () => {
            let polls = 0;
            const harness = await createLoggingHarness((message) => {
                if (message.type === TOPSKIP_MESSAGE.REFRESH_SERVER_ANALYSIS_STATUS) {
                    polls += 1;
                    if (polls === 3) {
                        return Promise.resolve({ ok: true, status: 'ready' });
                    }
                }
                return Promise.resolve(processingAck('job-final', payloadVideoId(message)));
            });
            try {
                await harness.advanceBindingTime(MS_PER_SECOND);
                await harness.advanceBindingTime(MS_PER_SECOND);
                await harness.advanceBindingTime(MS_PER_SECOND);
                await harness.advanceBindingTime(DEBUG_LOG_CLIENT_FLUSH_DELAY_MS);

                const finals = finalSummaries(harness);
                expect(finals).toHaveLength(1);
                expect(finals[0]).toMatchObject({
                    video: 'dQw4w9WgXcQ',
                    job: 'job-final',
                    fields: {
                        polls: 3,
                        retries: 0,
                        totalMs: 3 * MS_PER_SECOND,
                        lastStatus: 'ready',
                        terminal: true,
                        reason: 'terminal-response',
                    },
                });
                expect(typeof finals[0]?.session).toBe('string');
            } finally {
                harness.dispose();
            }
        });

        it('emits the final summary with reason navigation when the route is cancelled', async () => {
            const harness = await createLoggingHarness((message) =>
                Promise.resolve(processingAck('job-nav', payloadVideoId(message))),
            );
            try {
                await harness.advanceBindingTime(MS_PER_SECOND);
                await harness.advanceBindingTime(MS_PER_SECOND);
                await harness.navigateToVideo('aaaaaaaaaaa');
                await harness.advanceBindingTime(DEBUG_LOG_CLIENT_FLUSH_DELAY_MS);

                const finals = finalSummaries(harness).filter(
                    (event) => event.video === 'dQw4w9WgXcQ',
                );
                expect(finals).toHaveLength(1);
                expect(finals[0]?.fields).toMatchObject({
                    polls: 2,
                    retries: 0,
                    lastStatus: 'processing',
                    terminal: true,
                    reason: 'navigation',
                });
            } finally {
                harness.dispose();
            }
        });

        it('gives a resubmitted job its own final summary', async () => {
            let requests = 0;
            let polls = 0;
            const harness = await createLoggingHarness((message) => {
                if (message.type === TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS) {
                    requests += 1;
                    return Promise.resolve(
                        processingAck(requests === 1 ? 'job-a' : 'job-b', payloadVideoId(message)),
                    );
                }
                polls += 1;
                return Promise.resolve(
                    polls === 1
                        ? { ok: true, status: 'resubmit_required' }
                        : { ok: true, status: 'ready' },
                );
            });
            try {
                await harness.advanceBindingTime(MS_PER_SECOND);
                await harness.advanceBindingTime(MS_PER_SECOND);
                await harness.advanceBindingTime(DEBUG_LOG_CLIENT_FLUSH_DELAY_MS);

                const finals = finalSummaries(harness);
                expect(finals.map((event) => [event.job, event.fields])).toEqual([
                    [
                        'job-a',
                        expect.objectContaining({
                            polls: 1,
                            lastStatus: 'resubmit_required',
                            reason: 'resubmit',
                        }),
                    ],
                    [
                        'job-b',
                        expect.objectContaining({
                            polls: 1,
                            lastStatus: 'ready',
                            reason: 'terminal-response',
                        }),
                    ],
                ]);
            } finally {
                harness.dispose();
            }
        });

        it('summarizes the deadline final poll once', async () => {
            const harness = await createLoggingHarness((message) =>
                Promise.resolve(processingAck('job-deadline', payloadVideoId(message), 60 * 60)),
            );
            try {
                await harness.advanceBindingTime(SERVER_ANALYSIS_SESSION_DEADLINE_MS);
                await harness.advanceBindingTime(DEBUG_LOG_CLIENT_FLUSH_DELAY_MS);

                const finals = finalSummaries(harness);
                expect(finals).toHaveLength(1);
                expect(finals[0]).toMatchObject({
                    job: 'job-deadline',
                    fields: {
                        polls: 1,
                        retries: 0,
                        lastStatus: 'processing',
                        terminal: true,
                        reason: 'analysis_deadline_exceeded',
                    },
                });
            } finally {
                harness.dispose();
            }
        });

        it('counts transport retries across a simulated worker restart mid-poll', async () => {
            let polls = 0;
            const harness = await createLoggingHarness((message) => {
                if (message.type === TOPSKIP_MESSAGE.REFRESH_SERVER_ANALYSIS_STATUS) {
                    polls += 1;
                    if (polls === 1) {
                        return Promise.reject(new Error('message port closed'));
                    }
                    if (polls === 3) {
                        return Promise.resolve({ ok: true, status: 'ready' });
                    }
                }
                return Promise.resolve(processingAck('job-restart', payloadVideoId(message)));
            });
            try {
                await harness.advanceBindingTime(MS_PER_SECOND);
                await harness.advanceBindingTime(SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS[0]);
                await harness.advanceBindingTime(MS_PER_SECOND);
                await harness.advanceBindingTime(DEBUG_LOG_CLIENT_FLUSH_DELAY_MS);

                const finals = finalSummaries(harness);
                expect(finals).toHaveLength(1);
                expect(finals[0]).toMatchObject({
                    job: 'job-restart',
                    fields: { polls: 2, retries: 1, lastStatus: 'ready', terminal: true },
                });
            } finally {
                harness.dispose();
            }
        });

        it('emits an interim summary every DEBUG_LOG_POLL_SUMMARY_EVERY_POLLS polls', async () => {
            const harness = await createLoggingHarness((message) =>
                Promise.resolve(processingAck('job-interim', payloadVideoId(message))),
            );
            try {
                for (let poll = 0; poll < DEBUG_LOG_POLL_SUMMARY_EVERY_POLLS + 2; poll += 1) {
                    await harness.advanceBindingTime(MS_PER_SECOND);
                }
                await harness.navigateToVideo('aaaaaaaaaaa');
                await harness.advanceBindingTime(DEBUG_LOG_CLIENT_FLUSH_DELAY_MS);

                const summaries = appendedEventsNamed(
                    harness,
                    DEBUG_LOG_EVENT.PollSummary,
                ).filter(
                    (event) =>
                        event.job === 'job-interim' &&
                        event.video === 'dQw4w9WgXcQ',
                );
                expect(summaries.map((event) => event.fields)).toEqual([
                    expect.objectContaining({
                        polls: DEBUG_LOG_POLL_SUMMARY_EVERY_POLLS,
                        terminal: false,
                    }),
                    expect.objectContaining({
                        polls: DEBUG_LOG_POLL_SUMMARY_EVERY_POLLS + 2,
                        terminal: true,
                        reason: 'navigation',
                    }),
                ]);
                expect(summaries[0]?.fields).not.toHaveProperty('reason');
                // SC-005: a 12-poll synthetic Server-mode analysis stays under
                // the 40-event budget on the content side (the F9 E2E checks
                // the same bound over the full flow at 2 polls).
                expect(appendedDebugLogEvents(harness).length).toBeLessThanOrEqual(40);
            } finally {
                harness.dispose();
            }
        });
    });

    describe('content lifecycle diagnostics', () => {
        // Hoisted as `unknown` because the matcher factory returns `any`,
        // which no-unsafe-assignment refuses inside a literal.
        const ANY_STRING: unknown = expect.any(String);

        it('logs video-bound, route-decision once per decision, analysis-requested and route-status', async () => {
            const harness = await createLoggingHarness(NEVER_RESPOND);
            try {
                await harness.pollBindings();
                await harness.pollBindings();
                await expect(harness.routeStatus()).resolves.toMatchObject({
                    ok: true,
                });
                await harness.advanceBindingTime(DEBUG_LOG_CLIENT_FLUSH_DELAY_MS);

                expect(appendedEventsNamed(harness, DEBUG_LOG_EVENT.VideoBound)).toEqual([
                    expect.objectContaining({
                        video: 'dQw4w9WgXcQ',
                        fields: { outcome: 'bound' },
                    }),
                ]);
                const decisions = appendedEventsNamed(
                    harness,
                    DEBUG_LOG_EVENT.RouteDecision,
                ).map((event) => event.fields.decision);
                expect(decisions.filter((decision) => decision === 'server-request')).toHaveLength(1);
                expect(
                    appendedEventsNamed(harness, DEBUG_LOG_EVENT.AnalysisRequested),
                ).toEqual([
                    expect.objectContaining({
                        video: 'dQw4w9WgXcQ',
                        session: ANY_STRING,
                        fields: { route: ANALYSIS_MODE.Server },
                    }),
                ]);
                expect(
                    appendedEventsNamed(harness, DEBUG_LOG_EVENT.RouteStatus),
                ).toEqual([
                    expect.objectContaining({
                        video: 'dQw4w9WgXcQ',
                        session: ANY_STRING,
                        fields: {
                            route: ANALYSIS_MODE.Server,
                            outcome: 'enabled',
                            protocol: CONTENT_SCRIPT_PROTOCOL_VERSION,
                        },
                    }),
                ]);
            } finally {
                harness.dispose();
            }
        });

        it('logs video-swapped once when the player element is replaced', async () => {
            const harness = await createLoggingHarness(NEVER_RESPOND);
            try {
                await harness.replaceVideoElement();
                await harness.advanceBindingTime(DEBUG_LOG_CLIENT_FLUSH_DELAY_MS);

                expect(
                    appendedEventsNamed(harness, DEBUG_LOG_EVENT.VideoSwapped),
                ).toEqual([
                    expect.objectContaining({
                        video: 'dQw4w9WgXcQ',
                        fields: { reason: 'element-replaced' },
                    }),
                ]);
                expect(
                    appendedEventsNamed(harness, DEBUG_LOG_EVENT.VideoBound),
                ).toHaveLength(2);
                expect(relayedConsoleHeads(harness)).not.toContain(
                    'video element swap detected, rebinding',
                );
            } finally {
                harness.dispose();
            }
        });

        it('logs analysis-interrupted with the stable reason', async () => {
            const harness = await createLoggingHarness(() =>
                Promise.reject(new Error('message port closed')),
            );
            try {
                for (const retryAfterMs of SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS) {
                    await harness.advanceBindingTime(retryAfterMs);
                }
                await harness.advanceBindingTime(DEBUG_LOG_CLIENT_FLUSH_DELAY_MS);

                expect(
                    appendedEventsNamed(harness, DEBUG_LOG_EVENT.AnalysisInterrupted),
                ).toEqual([
                    expect.objectContaining({
                        video: 'dQw4w9WgXcQ',
                        session: ANY_STRING,
                        fields: { reason: 'runtime_unavailable' },
                    }),
                ]);
            } finally {
                harness.dispose();
            }
        });
    });
});
