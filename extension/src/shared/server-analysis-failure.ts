import {
    SERVER_ANALYSIS_FAILURE_CODE,
    type ServerAnalysisFailureCode,
} from '@topskip/common/server-analysis-contract';

/**
 * Popup behavior groups derived only from stable server codes.
 */
export const SERVER_FAILURE_CATEGORY = {
    VideoLimitation: 'video_limitation',
    TemporaryCapacity: 'temporary_capacity',
    UpgradeRequired: 'upgrade_required',
    ServerFailure: 'server_failure',
} as const;

/**
 * Issue-button prominence for each safe failure category.
 */
export const SERVER_FAILURE_REPORT_ACTION = {
    None: 'none',
    Secondary: 'secondary',
    Primary: 'primary',
} as const;

/**
 * Category names used by localized popup copy.
 */
export type ServerFailureCategory =
    (typeof SERVER_FAILURE_CATEGORY)[keyof typeof SERVER_FAILURE_CATEGORY];

/**
 * Report-button variants used without exposing server details to the UI.
 */
export type ServerFailureReportAction =
    (typeof SERVER_FAILURE_REPORT_ACTION)[keyof typeof SERVER_FAILURE_REPORT_ACTION];

const VIDEO_LIMITATION_CODES = new Set<ServerAnalysisFailureCode>([
    SERVER_ANALYSIS_FAILURE_CODE.FixtureUnavailable,
    SERVER_ANALYSIS_FAILURE_CODE.VideoUnavailable,
    SERVER_ANALYSIS_FAILURE_CODE.CaptionsUnavailable,
    SERVER_ANALYSIS_FAILURE_CODE.VideoTooLong,
    SERVER_ANALYSIS_FAILURE_CODE.TooManyCaptionSegments,
    SERVER_ANALYSIS_FAILURE_CODE.TranscriptTooLarge,
    SERVER_ANALYSIS_FAILURE_CODE.SubtitleResponseTooLarge,
]);

const TEMPORARY_CAPACITY_CODES = new Set<ServerAnalysisFailureCode>([
    SERVER_ANALYSIS_FAILURE_CODE.RateLimited,
    SERVER_ANALYSIS_FAILURE_CODE.CapacityLimited,
    SERVER_ANALYSIS_FAILURE_CODE.BudgetExhausted,
]);

/**
 * Maps the public failure vocabulary to one stable UX category.
 *
 * @param code - Validated server failure code.
 * @returns Popup behavior category.
 */
export function classifyServerFailure(
    code: ServerAnalysisFailureCode,
): ServerFailureCategory {
    if (VIDEO_LIMITATION_CODES.has(code)) {
        return SERVER_FAILURE_CATEGORY.VideoLimitation;
    }
    if (TEMPORARY_CAPACITY_CODES.has(code)) {
        return SERVER_FAILURE_CATEGORY.TemporaryCapacity;
    }
    if (code === SERVER_ANALYSIS_FAILURE_CODE.ClientUpgradeRequired) {
        return SERVER_FAILURE_CATEGORY.UpgradeRequired;
    }
    return SERVER_FAILURE_CATEGORY.ServerFailure;
}

/**
 * Allows reports for actionable failures while avoiding capacity-incident spam.
 *
 * @param code - Validated server failure code.
 * @returns Requested issue-button prominence.
 */
export function getServerFailureReportAction(
    code: ServerAnalysisFailureCode,
): ServerFailureReportAction {
    const category = classifyServerFailure(code);
    if (category === SERVER_FAILURE_CATEGORY.VideoLimitation) {
        return SERVER_FAILURE_REPORT_ACTION.Secondary;
    }
    if (category === SERVER_FAILURE_CATEGORY.ServerFailure) {
        return SERVER_FAILURE_REPORT_ACTION.Primary;
    }
    return SERVER_FAILURE_REPORT_ACTION.None;
}
