import { ANALYSIS_MODE, type UserPreferences } from '@/shared/constants';
import { TOPSKIP_MESSAGE, type TopSkipRuntimeMessage } from '@/shared/messages';

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
        input.durationSec !== undefined && Number.isFinite(input.durationSec)
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
}): TopSkipRuntimeMessage {
    return {
        type: TOPSKIP_MESSAGE.REFRESH_SERVER_ANALYSIS_STATUS,
        payload: {
            videoId: input.videoId,
            jobId: input.jobId,
        },
    };
}
