/**
 * @file Dev-build-only structured console logging for background server
 * analysis diagnostics.
 */

import { formatLogStage } from '@/shared/log-fields';

import type { ServerAnalysisLogFields } from '@/shared/server-analysis-log-types';

const SERVER_ANALYSIS_LOG_PREFIX = '[TopSkip server-analysis]';

/**
 * Keeps background-owned server diagnostics out of beta and release builds;
 * static API only.
 */
export class BackgroundServerAnalysisLog {
    /**
     * Writes one structured stage to the service-worker console in dev builds.
     *
     * @param event - Stable stage identifier.
     * @param fields - Allow-listed scalar diagnostic fields.
     * @param enabled - Optional test override for the compile-time dev gate.
     */
    static info(
        event: string,
        fields: ServerAnalysisLogFields = {},
        enabled = TOPSKIP_INCLUDE_DEV_LOCAL,
    ): void {
        if (!enabled) {
            return;
        }
        console.debug(
            SERVER_ANALYSIS_LOG_PREFIX,
            ...formatLogStage(event, fields),
        );
    }

    /**
     * Writes one safe failure stage without including remote response details.
     *
     * @param event - Stable stage identifier.
     * @param fields - Allow-listed scalar diagnostic fields.
     * @param enabled - Optional test override for the compile-time dev gate.
     */
    static warn(
        event: string,
        fields: ServerAnalysisLogFields = {},
        enabled = TOPSKIP_INCLUDE_DEV_LOCAL,
    ): void {
        if (!enabled) {
            return;
        }
        console.warn(
            SERVER_ANALYSIS_LOG_PREFIX,
            ...formatLogStage(event, fields),
        );
    }
}
