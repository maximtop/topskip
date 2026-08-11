import {
    SERVER_ANALYSIS_PHASE,
    SERVER_ANALYSIS_TERMINAL_PHASE,
    type PromoDetectionStatePayload,
} from '@/shared/messages';
import { PROMO_DETECTION_STATUS } from '@topskip/common/promo-types';
import {
    POPUP_DETECTION_HEALTHY_RECONCILE_MS,
    POPUP_STATE_FAILURE_RETRY_MS,
} from '@/popup/constants';

const SERVER_POPUP_PHASE = {
    ...SERVER_ANALYSIS_PHASE,
    Terminal: SERVER_ANALYSIS_TERMINAL_PHASE,
} as const;
const SERVER_POPUP_PHASE_RANK = {
    [SERVER_POPUP_PHASE.CaptionAcquisition]: 0,
    [SERVER_POPUP_PHASE.ServerAnalysis]: 1,
    [SERVER_POPUP_PHASE.Terminal]: 2,
} as const;

/**
 * Popup transport health is separate from the analysis result status.
 */
export const DETECTION_TRANSPORT_STATUS = {
    Loading: 'loading',
    Available: 'available',
    Stale: 'stale',
    Unavailable: 'unavailable',
} as const;

/**
 * Reconciliation cadence depends only on the latest transport outcome.
 */
export const DETECTION_REFRESH_OUTCOME = {
    Healthy: 'healthy',
    Failure: 'failure',
} as const;

/**
 * Popup-owned transport health keeps a trustworthy detection snapshot visible
 * when the background is temporarily unreachable.
 */
export type DetectionTransportState =
    | {
          status: typeof DETECTION_TRANSPORT_STATUS.Loading;
          activeTabId: undefined;
          snapshot: null;
      }
    | {
          status: typeof DETECTION_TRANSPORT_STATUS.Available;
          activeTabId: number | null;
          snapshot: PromoDetectionStatePayload | null;
      }
    | {
          status: typeof DETECTION_TRANSPORT_STATUS.Stale;
          activeTabId: number | null;
          snapshot: PromoDetectionStatePayload | null;
          error: string;
      }
    | {
          status: typeof DETECTION_TRANSPORT_STATUS.Unavailable;
          activeTabId: undefined;
          snapshot: null;
          error: string;
      };

/**
 * Push routing keeps the extension-global runtime channel from replacing the
 * popup state with another tab's snapshot.
 */
export const DETECTION_PUSH_ACTION = {
    Apply: 'apply',
    Reconcile: 'reconcile',
    Ignore: 'ignore',
} as const;

/**
 * Actions available when routing one tab-scoped detection push.
 */
export type DetectionPushAction =
    (typeof DETECTION_PUSH_ACTION)[keyof typeof DETECTION_PUSH_ACTION];

/**
 * Read outcomes select the next reconciliation cadence without coupling the
 * popup effect to timing literals.
 */
export type DetectionRefreshOutcome =
    (typeof DETECTION_REFRESH_OUTCOME)[keyof typeof DETECTION_REFRESH_OUTCOME];

/**
 * Initial state distinguishes a pending first read from a successful empty tab.
 */
export const INITIAL_DETECTION_TRANSPORT_STATE: DetectionTransportState = {
    status: DETECTION_TRANSPORT_STATUS.Loading,
    activeTabId: undefined,
    snapshot: null,
};

/**
 * Routes a push only after GET_DETECTION_STATUS establishes which tab the
 * popup represents.
 *
 * @param activeTabId - Resolved active tab, explicit no-tab, or unresolved.
 * @param pushedTabId - Originating tab carried by the runtime push.
 * @returns Apply for the active tab, reconcile while unresolved, else ignore.
 */
export function getDetectionPushAction(
    activeTabId: number | null | undefined,
    pushedTabId: number,
): DetectionPushAction {
    if (activeTabId === undefined) {
        return DETECTION_PUSH_ACTION.Reconcile;
    }
    if (activeTabId === pushedTabId) {
        return DETECTION_PUSH_ACTION.Apply;
    }
    return DETECTION_PUSH_ACTION.Ignore;
}

/**
 * Selects a slow health reconciliation after success and a quick retry after
 * transport failure.
 *
 * @param outcome - Health of the latest detection status operation.
 * @returns Delay before the next background reconciliation.
 */
export function getDetectionRefreshDelay(
    outcome: DetectionRefreshOutcome,
): number {
    return outcome === DETECTION_REFRESH_OUTCOME.Healthy
        ? POPUP_DETECTION_HEALTHY_RECONCILE_MS
        : POPUP_STATE_FAILURE_RETRY_MS;
}

/**
 * Prevents a read started before a runtime push from replacing the pushed
 * snapshot when its delayed response arrives.
 *
 * @param startedPushRevision - Push revision captured before the read.
 * @param currentPushRevision - Push revision when the read completes.
 * @returns Whether the read still belongs to the current transport revision.
 */
export function isDetectionReadCurrent(
    startedPushRevision: number,
    currentPushRevision: number,
): boolean {
    return startedPushRevision === currentPushRevision;
}

/**
 * Prevents a delayed popup read from rendering an earlier phase of one session.
 *
 * @param current - Snapshot already trusted by the popup.
 * @param incoming - Newly observed background or push snapshot.
 * @returns Incoming state unless it moves the same Server session backwards.
 */
export function chooseMonotonicDetectionSnapshot(
    current: PromoDetectionStatePayload | null,
    incoming: PromoDetectionStatePayload | null,
): PromoDetectionStatePayload | null {
    if (current === null || incoming === null) {
        return incoming;
    }
    if (
        current.sessionId === undefined ||
        incoming.sessionId === undefined ||
        current.sessionId !== incoming.sessionId
    ) {
        return incoming;
    }
    const currentPhase =
        current.status === PROMO_DETECTION_STATUS.Analyzing
            ? (current.serverAnalysisPhase ??
                SERVER_POPUP_PHASE.ServerAnalysis)
            : SERVER_POPUP_PHASE.Terminal;
    const incomingPhase =
        incoming.status === PROMO_DETECTION_STATUS.Analyzing
            ? (incoming.serverAnalysisPhase ??
                SERVER_POPUP_PHASE.ServerAnalysis)
            : SERVER_POPUP_PHASE.Terminal;
    return SERVER_POPUP_PHASE_RANK[incomingPhase] <
        SERVER_POPUP_PHASE_RANK[currentPhase]
        ? current
        : incoming;
}

/**
 * Applies one trustworthy read or push while retaining phase monotonicity.
 *
 * @param current - Current transport health and last trustworthy snapshot.
 * @param activeTabId - Tab identity resolved by the successful status read.
 * @param incoming - Successful background snapshot for the active tab.
 * @returns Healthy transport state containing the accepted snapshot.
 */
export function applyDetectionTransportSuccess(
    current: DetectionTransportState,
    activeTabId: number | null,
    incoming: PromoDetectionStatePayload | null,
): DetectionTransportState {
    const currentSnapshot =
        current.activeTabId === activeTabId ? current.snapshot : null;
    return {
        status: DETECTION_TRANSPORT_STATUS.Available,
        activeTabId,
        snapshot: chooseMonotonicDetectionSnapshot(currentSnapshot, incoming),
    };
}

/**
 * Preserves a successful snapshot across transport failure while making a first
 * failed read explicitly unavailable.
 *
 * @param current - Current transport health and last trustworthy snapshot.
 * @param error - Safe diagnostic retained for logs rather than user-facing copy.
 * @returns Stale or unavailable transport state.
 */
export function applyDetectionTransportFailure(
    current: DetectionTransportState,
    error: string,
): DetectionTransportState {
    if (
        current.status === DETECTION_TRANSPORT_STATUS.Available ||
        current.status === DETECTION_TRANSPORT_STATUS.Stale
    ) {
        return {
            status: DETECTION_TRANSPORT_STATUS.Stale,
            activeTabId: current.activeTabId,
            snapshot: current.snapshot,
            error,
        };
    }
    return {
        status: DETECTION_TRANSPORT_STATUS.Unavailable,
        activeTabId: undefined,
        snapshot: null,
        error,
    };
}
