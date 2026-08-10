import { describe, expect, it } from 'vitest';

import { DetectionRefreshGuard } from '@/popup/detection-refresh-guard';
import {
    DETECTION_PUSH_ACTION,
    getDetectionPushAction,
} from '@/popup/detection-transport-state';

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

    it('coalesces an early push into reconciliation before tab identity', () => {
        const guard = new DetectionRefreshGuard();

        expect(guard.requestRefresh()).toBe(true);
        expect(getDetectionPushAction(undefined, 42)).toBe(
            DETECTION_PUSH_ACTION.Reconcile,
        );
        expect(guard.requestRefresh()).toBe(false);
        expect(guard.completeRefresh()).toEqual({
            applyCompletion: false,
            runFollowUp: true,
        });
    });
});
