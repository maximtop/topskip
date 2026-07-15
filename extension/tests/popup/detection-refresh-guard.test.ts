import { describe, expect, it } from 'vitest';

import { DetectionRefreshGuard } from '@/popup/detection-refresh-guard';

describe('DetectionRefreshGuard', () => {
    it('serializes reads and collapses repeated signals into one follow-up', () => {
        const guard = new DetectionRefreshGuard();

        expect(guard.requestRefresh()).toBe(true);
        expect(guard.requestRefresh()).toBe(false);
        expect(guard.requestRefresh()).toBe(false);
        expect(guard.completeRefresh()).toEqual({
            applyCompletion: false,
            runFollowUp: true,
        });
        expect(guard.completeRefresh()).toEqual({
            applyCompletion: true,
            runFollowUp: false,
        });
    });

    it('publishes ordered coalesced reads without slow-request starvation', () => {
        const guard = new DetectionRefreshGuard();

        expect(guard.requestRefresh()).toBe(true);
        expect(guard.requestRefresh()).toBe(false);
        expect(guard.completeRefresh()).toEqual({
            applyCompletion: false,
            runFollowUp: true,
        });

        expect(guard.requestRefresh()).toBe(false);
        expect(guard.completeRefresh()).toEqual({
            applyCompletion: true,
            runFollowUp: true,
        });

        expect(guard.requestRefresh()).toBe(false);
        expect(guard.completeRefresh()).toEqual({
            applyCompletion: true,
            runFollowUp: true,
        });
        expect(guard.completeRefresh()).toEqual({
            applyCompletion: true,
            runFollowUp: false,
        });
    });

    it('preserves a successful snapshot across later refresh failures', () => {
        const guard = new DetectionRefreshGuard();

        expect(guard.requestRefresh()).toBe(true);
        expect(guard.completeRefresh().applyCompletion).toBe(true);
        guard.markSuccessfulSnapshot();

        expect(guard.requestRefresh()).toBe(true);
        expect(guard.completeRefresh().applyCompletion).toBe(true);
        expect(guard.shouldSurfaceFailure()).toBe(false);
    });

    it('surfaces a failure before any successful snapshot exists', () => {
        const guard = new DetectionRefreshGuard();

        expect(guard.requestRefresh()).toBe(true);
        expect(guard.completeRefresh().applyCompletion).toBe(true);
        expect(guard.shouldSurfaceFailure()).toBe(true);
    });
});
