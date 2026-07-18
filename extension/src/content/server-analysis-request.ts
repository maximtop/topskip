import { ANALYSIS_MODE, type UserPreferences } from '@/shared/constants';
import { TOPSKIP_MESSAGE, type TopSkipRuntimeMessage } from '@/shared/messages';
import type { CaptionSegment } from '@topskip/common/caption-types';
import { MAX_TRANSCRIPT_TIMELINE_SEC } from '@topskip/common/captions/canonical-transcript';
import type { ServerTranscriptIdentity } from '@topskip/common/server-analysis-contract';

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
    sessionId: string;
    videoId: string;
    durationSec?: number;
    languageCode: string;
    segments: readonly CaptionSegment[];
}): TopSkipRuntimeMessage {
    const duration =
        input.durationSec !== undefined &&
        Number.isFinite(input.durationSec) &&
        input.durationSec >= 0 &&
        input.durationSec <= MAX_TRANSCRIPT_TIMELINE_SEC
            ? { durationSec: input.durationSec }
            : {};
    return {
        type: TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS,
        payload: {
            sessionId: input.sessionId,
            videoId: input.videoId,
            ...duration,
            languageCode: input.languageCode,
            segments: [...input.segments],
        },
    };
}

/**
 * Builds the runtime message sent from content to background for job polling.
 *
 * @param input - Current watch video id and backend job id.
 * @returns Runtime message for the background server-analysis status handler.
 */
export function buildRefreshServerAnalysisStatusMessage(input: {
    sessionId: string;
    videoId: string;
    jobId: string;
    identity: ServerTranscriptIdentity;
}): TopSkipRuntimeMessage {
    return {
        type: TOPSKIP_MESSAGE.REFRESH_SERVER_ANALYSIS_STATUS,
        payload: {
            sessionId: input.sessionId,
            videoId: input.videoId,
            jobId: input.jobId,
            identity: input.identity,
        },
    };
}
