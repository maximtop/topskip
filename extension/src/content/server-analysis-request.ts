import { ANALYSIS_MODE, type UserPreferences } from '@/shared/constants';
import { TOPSKIP_MESSAGE, type TopSkipRuntimeMessage } from '@/shared/messages';

/**
 * Describes whether the initial backend request can carry authoritative video
 * duration yet or must remain deferred for another binding poll.
 */
export type ServerAnalysisDurationDecision =
    | { status: 'ready'; durationSec: number }
    | { status: 'waiting'; waitStartedAtMs: number }
    | { status: 'timed_out' };

/**
 * Gives ordinary videos a short metadata-loading window without permanently
 * blocking live streams or players whose duration never becomes finite.
 *
 * @param input - Player duration and the bounded-wait clock state.
 * @returns Whether to send with duration, wait, or send without duration.
 */
export function decideServerAnalysisDuration(input: {
    durationSec: number;
    waitStartedAtMs: number | null;
    nowMs: number;
    maxWaitMs: number;
}): ServerAnalysisDurationDecision {
    if (Number.isFinite(input.durationSec) && input.durationSec > 0) {
        return { status: 'ready', durationSec: input.durationSec };
    }

    if (input.waitStartedAtMs === null) {
        return { status: 'waiting', waitStartedAtMs: input.nowMs };
    }

    const elapsedMs = Math.max(0, input.nowMs - input.waitStartedAtMs);
    if (elapsedMs < input.maxWaitMs) {
        return {
            status: 'waiting',
            waitStartedAtMs: input.waitStartedAtMs,
        };
    }

    return { status: 'timed_out' };
}

/**
 * Keeps server-mode routing out of the caption capture path.
 *
 * @param prefs - Current preferences cached by the watch content script.
 * @returns `true` when the video should request server analysis.
 */
export function shouldUseServerAnalysis(prefs: UserPreferences): boolean {
    return prefs.enabled && prefs.analysisMode === ANALYSIS_MODE.Server;
}

/**
 * Builds the runtime message sent from content to background for server mode.
 *
 * @param input - Current watch video id and optional finite duration.
 * @returns Runtime message for the background server-analysis handler.
 */
export function buildRequestServerAnalysisMessage(input: {
    videoId: string;
    durationSec?: number;
}): TopSkipRuntimeMessage {
    const payload =
        input.durationSec !== undefined &&
        Number.isFinite(input.durationSec) &&
        input.durationSec > 0
            ? { videoId: input.videoId, durationSec: input.durationSec }
            : { videoId: input.videoId };
    return {
        type: TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS,
        payload,
    };
}

/**
 * Builds the runtime message sent from content to background for job polling.
 *
 * @param input - Current watch video id and backend job id.
 * @returns Runtime message for the background server-analysis status handler.
 */
export function buildRefreshServerAnalysisStatusMessage(input: {
    videoId: string;
    jobId: string;
    durationSec?: number;
}): TopSkipRuntimeMessage {
    const payload =
        input.durationSec !== undefined &&
        Number.isFinite(input.durationSec) &&
        input.durationSec > 0
            ? {
                  videoId: input.videoId,
                  jobId: input.jobId,
                  durationSec: input.durationSec,
              }
            : { videoId: input.videoId, jobId: input.jobId };
    return {
        type: TOPSKIP_MESSAGE.REFRESH_SERVER_ANALYSIS_STATUS,
        payload,
    };
}
