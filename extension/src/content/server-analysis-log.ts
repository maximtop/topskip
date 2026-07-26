import { contentLog } from '@/content/content-log';
import type { ServerAnalysisLogFields } from '@/shared/server-analysis-log-types';

const SERVER_ANALYSIS_LOG_PREFIX = '[TopSkip server-analysis]';

/**
 * Routes content-owned stages into the service-worker console; static API only.
 */
export class ContentServerAnalysisLog {
    /**
     * Forwards one structured stage only when localhost dev support is enabled.
     *
     * @param event - Stable stage identifier.
     * @param fields - Allow-listed scalar diagnostic fields.
     * @param enabled - Optional test override for the compile-time dev gate.
     */
    static info(
        event: string,
        fields: ServerAnalysisLogFields = {},
        enabled = __TOPSKIP_INCLUDE_DEV_LOCAL__,
    ): void {
        if (!enabled) {
            return;
        }
        contentLog.info(SERVER_ANALYSIS_LOG_PREFIX, event, fields);
    }

    /**
     * Forwards one safe failure stage without breaking watch orchestration.
     *
     * @param event - Stable stage identifier.
     * @param fields - Allow-listed scalar diagnostic fields.
     * @param enabled - Optional test override for the compile-time dev gate.
     */
    static warn(
        event: string,
        fields: ServerAnalysisLogFields = {},
        enabled = __TOPSKIP_INCLUDE_DEV_LOCAL__,
    ): void {
        if (!enabled) {
            return;
        }
        contentLog.warn(SERVER_ANALYSIS_LOG_PREFIX, event, fields);
    }
}
