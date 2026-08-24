import { describe, expect, it } from 'vitest';

import {
    DETECTION_PUSH_ACTION,
    INITIAL_DETECTION_TRANSPORT_STATE,
    applyDetectionTransportFailure,
    applyDetectionTransportSuccess,
    getDetectionRefreshDelay,
    getDetectionPushAction,
    isDetectionReadCurrent,
    isDetectionTransportKnown,
} from '@/popup/detection-transport-state';
import {
    POPUP_DETECTION_HEALTHY_RECONCILE_MS,
    POPUP_STATE_FAILURE_RETRY_MS,
} from '@/popup/constants';
import type { PromoDetectionStatePayload } from '@/shared/messages';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const OTHER_SESSION_ID = '00000000-0000-4000-8000-000000000002';
const ACTIVE_TAB_ID = 42;
const OTHER_TAB_ID = 84;

const acquisition = {
    videoId: 'dQw4w9WgXcQ',
    sessionId: SESSION_ID,
    status: 'analyzing',
    source: 'server',
    serverAnalysisPhase: 'caption_acquisition',
} satisfies PromoDetectionStatePayload;

const analysis = {
    ...acquisition,
    serverAnalysisPhase: 'server_analysis',
} satisfies PromoDetectionStatePayload;

const terminal = {
    videoId: acquisition.videoId,
    sessionId: SESSION_ID,
    status: 'no_promo',
    source: 'server',
} satisfies PromoDetectionStatePayload;

describe('detection transport state', () => {
    it('reconciles slowly when healthy and retries failures quickly', () => {
        expect(getDetectionRefreshDelay('healthy')).toBe(
            POPUP_DETECTION_HEALTHY_RECONCILE_MS,
        );
        expect(getDetectionRefreshDelay('failure')).toBe(
            POPUP_STATE_FAILURE_RETRY_MS,
        );
        expect(POPUP_DETECTION_HEALTHY_RECONCILE_MS).toBe(10_000);
        expect(POPUP_STATE_FAILURE_RETRY_MS).toBe(2_000);
    });

    it('rejects a delayed read after a newer push revision', () => {
        expect(isDetectionReadCurrent(2, 2)).toBe(true);
        expect(isDetectionReadCurrent(2, 3)).toBe(false);
    });

    it('applies pushes only for the resolved active tab', () => {
        expect(getDetectionPushAction(undefined, ACTIVE_TAB_ID)).toBe(
            DETECTION_PUSH_ACTION.Reconcile,
        );
        expect(getDetectionPushAction(ACTIVE_TAB_ID, ACTIVE_TAB_ID)).toBe(
            DETECTION_PUSH_ACTION.Apply,
        );
        expect(getDetectionPushAction(ACTIVE_TAB_ID, OTHER_TAB_ID)).toBe(
            DETECTION_PUSH_ACTION.Ignore,
        );
        expect(getDetectionPushAction(null, ACTIVE_TAB_ID)).toBe(
            DETECTION_PUSH_ACTION.Ignore,
        );
    });

    it('surfaces the first failed read without inventing a snapshot', () => {
        expect(
            applyDetectionTransportFailure(
                INITIAL_DETECTION_TRANSPORT_STATE,
                'status timeout',
            ),
        ).toEqual({
            status: 'unavailable',
            activeTabId: undefined,
            snapshot: null,
            error: 'status timeout',
        });
    });

    it('keeps a successful snapshot visible while transport is stale', () => {
        const available = applyDetectionTransportSuccess(
            INITIAL_DETECTION_TRANSPORT_STATE,
            ACTIVE_TAB_ID,
            acquisition,
        );

        expect(
            applyDetectionTransportFailure(available, 'worker unavailable'),
        ).toEqual({
            status: 'stale',
            activeTabId: ACTIVE_TAB_ID,
            snapshot: acquisition,
            error: 'worker unavailable',
        });
    });

    it('recovers from unavailable and stale reads on the next success', () => {
        const unavailable = applyDetectionTransportFailure(
            INITIAL_DETECTION_TRANSPORT_STATE,
            'status timeout',
        );
        const firstSuccess = applyDetectionTransportSuccess(
            unavailable,
            ACTIVE_TAB_ID,
            null,
        );
        expect(firstSuccess).toEqual({
            status: 'available',
            activeTabId: ACTIVE_TAB_ID,
            snapshot: null,
        });

        const stale = applyDetectionTransportFailure(
            applyDetectionTransportSuccess(
                firstSuccess,
                ACTIVE_TAB_ID,
                acquisition,
            ),
            'worker unavailable',
        );
        expect(
            applyDetectionTransportSuccess(stale, ACTIVE_TAB_ID, analysis),
        ).toEqual({
            status: 'available',
            activeTabId: ACTIVE_TAB_ID,
            snapshot: analysis,
        });
    });

    it('never moves the same server session back to an earlier phase', () => {
        const availableAnalysis = applyDetectionTransportSuccess(
            INITIAL_DETECTION_TRANSPORT_STATE,
            ACTIVE_TAB_ID,
            analysis,
        );
        expect(
            applyDetectionTransportSuccess(
                availableAnalysis,
                ACTIVE_TAB_ID,
                acquisition,
            ),
        ).toEqual({
            status: 'available',
            activeTabId: ACTIVE_TAB_ID,
            snapshot: analysis,
        });

        const availableTerminal = applyDetectionTransportSuccess(
            availableAnalysis,
            ACTIVE_TAB_ID,
            terminal,
        );
        expect(
            applyDetectionTransportSuccess(
                availableTerminal,
                ACTIVE_TAB_ID,
                analysis,
            ),
        ).toEqual({
            status: 'available',
            activeTabId: ACTIVE_TAB_ID,
            snapshot: terminal,
        });
    });

    it('does not carry phase ordering across two browser tabs', () => {
        const availableAnalysis = applyDetectionTransportSuccess(
            INITIAL_DETECTION_TRANSPORT_STATE,
            ACTIVE_TAB_ID,
            analysis,
        );

        expect(
            applyDetectionTransportSuccess(
                availableAnalysis,
                OTHER_TAB_ID,
                acquisition,
            ),
        ).toEqual({
            status: 'available',
            activeTabId: OTHER_TAB_ID,
            snapshot: acquisition,
        });
    });

    it('accepts a new session and a successful empty active-tab snapshot', () => {
        const availableTerminal = applyDetectionTransportSuccess(
            INITIAL_DETECTION_TRANSPORT_STATE,
            ACTIVE_TAB_ID,
            terminal,
        );
        const nextSession = {
            ...acquisition,
            sessionId: OTHER_SESSION_ID,
        } satisfies PromoDetectionStatePayload;

        const replaced = applyDetectionTransportSuccess(
            availableTerminal,
            ACTIVE_TAB_ID,
            nextSession,
        );
        expect(replaced).toEqual({
            status: 'available',
            activeTabId: ACTIVE_TAB_ID,
            snapshot: nextSession,
        });
        expect(
            applyDetectionTransportSuccess(replaced, null, null),
        ).toEqual({
            status: 'available',
            activeTabId: null,
            snapshot: null,
        });
    });
});

describe('isDetectionTransportKnown', () => {
    it('is known only after a successful read, including while stale', () => {
        expect(isDetectionTransportKnown(INITIAL_DETECTION_TRANSPORT_STATE)).toBe(
            false,
        );
        const unavailable = applyDetectionTransportFailure(
            INITIAL_DETECTION_TRANSPORT_STATE,
            'worker unavailable',
        );
        expect(isDetectionTransportKnown(unavailable)).toBe(false);
        const available = applyDetectionTransportSuccess(
            INITIAL_DETECTION_TRANSPORT_STATE,
            ACTIVE_TAB_ID,
            null,
        );
        expect(isDetectionTransportKnown(available)).toBe(true);
        expect(
            isDetectionTransportKnown(
                applyDetectionTransportFailure(available, 'worker unavailable'),
            ),
        ).toBe(true);
    });
});
