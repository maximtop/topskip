import { describe, expect, it, vi } from 'vitest';

const {
    addRuntimeMessageListener,
    installPageBridge,
    scheduleForVideoId,
    sendMessage,
} = vi.hoisted(() => ({
    addRuntimeMessageListener:
        vi.fn<(listener: (message: unknown) => void) => void>(),
    installPageBridge: vi.fn(),
    scheduleForVideoId: vi.fn(),
    sendMessage: vi.fn<(message: unknown) => Promise<unknown>>(),
}));

vi.mock('@/shared/browser', () => ({
    default: {
        runtime: {
            sendMessage,
            onMessage: { addListener: addRuntimeMessageListener },
        },
    },
}));

vi.mock('@/content/watch-captions', () => ({
    WatchCaptions: {
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
import type { PromoBlock } from '@/shared/promo-types';
import { ANALYSIS_MODE, type UserPreferences } from '@/shared/constants';
import { TOPSKIP_MESSAGE } from '@/shared/messages';
import {
    VIDEO_BINDING_POLL_INTERVAL_MS,
    YOUTUBE_VIDEO_ELEMENT_SELECTOR,
} from '@/content/youtube-dom';

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

describe('onTimeUpdate skip pipeline integration', () => {
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

    type RuntimeMessageListener = (message: unknown) => void;

    class FakeVideoElement extends EventTarget {
        currentTime = 0;
        duration = 120;
    }

    async function flushAsyncWork(): Promise<void> {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
    }

    async function createRouteHarness(initialPrefs: UserPreferences): Promise<{
        emitPrefs(prefs: UserPreferences): Promise<void>;
        messagesOfType(type: string): unknown[];
        navigateToVideo(videoId: string): Promise<void>;
        pollBindings(): Promise<void>;
        replaceVideoElement(): Promise<void>;
        dispose(): void;
    }> {
        vi.useFakeTimers();
        vi.resetModules();
        sendMessage.mockReset();
        addRuntimeMessageListener.mockReset();
        installPageBridge.mockReset();
        scheduleForVideoId.mockReset();

        let runtimeMessageListener: RuntimeMessageListener | null = null;
        let video = new FakeVideoElement();
        const locationState = {
            hostname: 'www.youtube.com',
            pathname: '/watch',
            search: '?v=video-a',
        };
        const windowEvents = new EventTarget();

        addRuntimeMessageListener.mockImplementation(
            (listener: RuntimeMessageListener) => {
                runtimeMessageListener = listener;
            },
        );
        sendMessage.mockImplementation((message: unknown) => {
            if (
                typeof message === 'object' &&
                message !== null &&
                'type' in message
            ) {
                if (message.type === TOPSKIP_MESSAGE.GET_PREFS) {
                    return Promise.resolve({ ok: true, prefs: initialPrefs });
                }
                if (
                    message.type === TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS ||
                    message.type ===
                        TOPSKIP_MESSAGE.REFRESH_SERVER_ANALYSIS_STATUS
                ) {
                    return Promise.resolve({
                        ok: true,
                        status: 'processing',
                        jobId: 'job-video-a',
                        pollAfterSec: 1,
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
            clearTimeout: globalThis.clearTimeout,
            dispatchEvent: windowEvents.dispatchEvent.bind(windowEvents),
            setTimeout: globalThis.setTimeout,
        });

        const { YoutubeWatch } = await import('@/content/youtube-watch');
        YoutubeWatch.init();
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
            async emitPrefs(prefs: UserPreferences): Promise<void> {
                getRuntimeMessageListener()({
                    type: TOPSKIP_MESSAGE.PREFS_UPDATED,
                    prefs,
                });
                await flushAsyncWork();
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
            dispose(): void {
                vi.clearAllTimers();
                vi.useRealTimers();
                vi.unstubAllGlobals();
            },
        };
    }

    it('locks Server on video A, cancels polling, and starts BYOK only on video B', async () => {
        const harness = await createRouteHarness(serverPrefs);
        const byokPrefs: UserPreferences = {
            ...serverPrefs,
            analysisMode: ANALYSIS_MODE.Byok,
        };

        try {
            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS),
            ).toHaveLength(1);

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
            ).toHaveLength(0);
            expect(scheduleForVideoId).not.toHaveBeenCalled();

            await harness.navigateToVideo('video-b');

            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.PREFLIGHT_BYOK_SETUP),
            ).toEqual([
                {
                    type: TOPSKIP_MESSAGE.PREFLIGHT_BYOK_SETUP,
                    payload: { videoId: 'video-b' },
                },
            ]);
            expect(scheduleForVideoId).toHaveBeenCalledTimes(1);
            expect(scheduleForVideoId).toHaveBeenCalledWith(
                'video-b',
                'video-id-change',
            );
            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS),
            ).toHaveLength(1);
        } finally {
            harness.dispose();
        }
    });

    it('locks BYOK through polls and element replacement, then starts Server on video B', async () => {
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
                    payload: { videoId: 'video-a' },
                },
            ]);
            expect(scheduleForVideoId).toHaveBeenCalledTimes(1);

            await harness.pollBindings();
            await harness.emitPrefs(serverPrefs);
            await harness.pollBindings();
            await harness.replaceVideoElement();
            await harness.pollBindings();

            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.PREFLIGHT_BYOK_SETUP),
            ).toHaveLength(1);
            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS),
            ).toHaveLength(0);
            expect(scheduleForVideoId).toHaveBeenCalledTimes(2);
            expect(scheduleForVideoId).toHaveBeenLastCalledWith(
                'video-a',
                'video-element-ready',
            );

            await harness.navigateToVideo('video-b');

            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS),
            ).toEqual([
                {
                    type: TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS,
                    payload: { videoId: 'video-b', durationSec: 120 },
                },
            ]);
            expect(
                harness.messagesOfType(TOPSKIP_MESSAGE.PREFLIGHT_BYOK_SETUP),
            ).toHaveLength(1);
        } finally {
            harness.dispose();
        }
    });
});
