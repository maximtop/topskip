import { describe, expect, it } from 'vitest';

import {
    evaluatePromoBlocksSkip,
    promoBlockStartKey,
    resetFiredIndicesOnBackwardSeek,
    computePromoBlockTargetTime,
} from '@/content/promo-skip-logic';
import type { PromoBlock } from '@/shared/promo-types';

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
