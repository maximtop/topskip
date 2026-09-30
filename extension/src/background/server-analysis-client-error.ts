/**
 * @file Error type carrying only allow-listed diagnostics when a
 * `ServerAnalysisClient` transport or validation step fails.
 */

import type { ServerAnalysisFailure } from '@topskip/common/server-analysis-contract';

/**
 * Carries only allow-listed diagnostics when transport or validation fails.
 */
export class ServerAnalysisClientError extends Error {
    /**
     * Stable details safe to map into popup state.
     */
    readonly failure: ServerAnalysisFailure;

    /**
     * Creates a sanitized client failure without retaining raw response text.
     *
     * @param failure - Stable server-analysis failure details.
     */
    constructor(failure: ServerAnalysisFailure) {
        super('TopSkip server request failed.');
        this.name = 'ServerAnalysisClientError';
        this.failure = failure;
    }
}
