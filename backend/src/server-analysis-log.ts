const SERVER_ANALYSIS_LOG_PREFIX = '[TopSkip server-analysis]';

const SERVER_ANALYSIS_LOG_FIELDS_BY_EVENT = {
    'http-received': ['requestId', 'method', 'route'],
    'http-completed': [
        'requestId',
        'method',
        'route',
        'statusCode',
        'elapsedMs',
    ],
    'request-failed': ['requestId', 'code', 'supportId'],
    'analysis-request-handled': [
        'requestId',
        'videoId',
        'resultStatus',
        'jobId',
    ],
    'backend-cache-hit': ['requestId', 'videoId', 'source'],
    'job-joined': ['requestId', 'videoId', 'jobId'],
    'job-rate-limited': [
        'requestId',
        'videoId',
        'code',
        'retryAfterSec',
        'queueDepth',
    ],
    'job-started': ['requestId', 'videoId', 'jobId', 'queueDepth'],
    'extraction-started': ['requestId', 'videoId', 'jobId'],
    'extraction-selected': [
        'requestId',
        'videoId',
        'jobId',
        'strategy',
        'segmentCount',
    ],
    'extraction-unavailable': [
        'requestId',
        'videoId',
        'jobId',
        'code',
        'attemptCount',
        'supportId',
    ],
    'job-failed': ['requestId', 'videoId', 'jobId', 'code'],
    'model-analysis-started': ['requestId', 'videoId', 'jobId'],
    'analysis-completed': [
        'requestId',
        'videoId',
        'jobId',
        'status',
        'provider',
        'model',
        'inputTokens',
        'outputTokens',
        'costUsd',
        'supportId',
    ],
    'yt-dlp-metadata-started': ['videoId'],
    'yt-dlp-metadata-failed': ['videoId', 'code'],
    'yt-dlp-track-missing': ['videoId', 'code'],
    'yt-dlp-track-selected': ['videoId', 'trackKind', 'languageCode'],
    'yt-dlp-download-started': ['videoId', 'trackKind', 'languageCode'],
    'yt-dlp-download-failed': ['videoId', 'code'],
    'yt-dlp-artifact-failed': ['videoId', 'code'],
    'yt-dlp-parse-failed': ['videoId', 'code'],
    'yt-dlp-parse-completed': ['videoId', 'languageCode', 'segmentCount'],
} as const;

const MAX_LOG_STRING_LENGTH = 160;
const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/u;
const ROUTE_TEMPLATES = new Set([
    '/v1/health',
    '/v1/config',
    '/v1/installations/register',
    '/v1/analysis',
    '/v1/analysis/jobs/{jobId}',
    '/v1/analysis/jobs/{jobId}/fixture-result',
    'unmatched',
]);

/**
 * Keeps log stages stable so arbitrary caller text cannot reach the console.
 */
export type BackendServerAnalysisLogEvent =
    keyof typeof SERVER_ANALYSIS_LOG_FIELDS_BY_EVENT;

/**
 * Limits operational metadata to values that cannot carry nested payloads.
 */
type BackendServerAnalysisLogScalar =
    | string
    | number
    | boolean
    | null
    | undefined;

/**
 * Restricts backend diagnostics to bounded scalar operational metadata.
 */
export type BackendServerAnalysisLogFields = Readonly<
    Record<string, BackendServerAnalysisLogScalar>
>;

/**
 * Centralizes opt-in local backend tracing so tests stay quiet; static API only.
 */
export class BackendServerAnalysisLog {
    /**
     * The CLI entry enables logs, while imported test servers remain silent.
     */
    private static enabled = false;

    /**
     * Enables permanent diagnostics for the local development server process.
     */
    static enable(): void {
        BackendServerAnalysisLog.enabled = true;
    }

    /**
     * Restores the quiet default between logger unit tests.
     */
    static disableForTests(): void {
        BackendServerAnalysisLog.enabled = false;
    }

    /**
     * Writes one safe backend stage when local tracing is enabled.
     *
     * @param event - Stable stage identifier.
     * @param fields - Allow-listed scalar diagnostic fields.
     */
    static info(
        event: BackendServerAnalysisLogEvent,
        fields: BackendServerAnalysisLogFields = {},
    ): void {
        if (!BackendServerAnalysisLog.enabled) {
            return;
        }
        const safeFields = BackendServerAnalysisLog.filterFields(event, fields);
        if (safeFields === null) {
            return;
        }
        console.info(SERVER_ANALYSIS_LOG_PREFIX, event, safeFields);
    }

    /**
     * Writes one safe failure stage without external process output.
     *
     * @param event - Stable stage identifier.
     * @param fields - Allow-listed scalar diagnostic fields.
     */
    static warn(
        event: BackendServerAnalysisLogEvent,
        fields: BackendServerAnalysisLogFields = {},
    ): void {
        if (!BackendServerAnalysisLog.enabled) {
            return;
        }
        const safeFields = BackendServerAnalysisLog.filterFields(event, fields);
        if (safeFields === null) {
            return;
        }
        console.warn(SERVER_ANALYSIS_LOG_PREFIX, event, safeFields);
    }

    /**
     * Copies only own data properties named by the event contract.
     *
     * @param event - Untrusted runtime event value despite the typed API.
     * @param fields - Untrusted runtime fields despite the scalar-only API.
     * @returns Sanitized metadata, or `null` when the event is unknown.
     */
    private static filterFields(
        event: string,
        fields: unknown,
    ): BackendServerAnalysisLogFields | null {
        if (!BackendServerAnalysisLog.isAllowedEvent(event)) {
            return null;
        }
        if (typeof fields !== 'object' || fields === null) {
            return {};
        }

        const safeFields: Record<string, BackendServerAnalysisLogScalar> = {};
        for (const fieldName of SERVER_ANALYSIS_LOG_FIELDS_BY_EVENT[event]) {
            const descriptor = Object.getOwnPropertyDescriptor(
                fields,
                fieldName,
            );
            if (descriptor === undefined || !('value' in descriptor)) {
                continue;
            }
            const value: unknown = descriptor.value;
            if (!BackendServerAnalysisLog.isSafeFieldValue(fieldName, value)) {
                continue;
            }
            safeFields[fieldName] = value;
        }
        return safeFields;
    }

    /**
     * Narrows runtime event strings before indexing the allow-list.
     *
     * @param event - Candidate event identifier.
     * @returns Whether the event has an explicit field contract.
     */
    private static isAllowedEvent(
        event: string,
    ): event is BackendServerAnalysisLogEvent {
        return Object.hasOwn(SERVER_ANALYSIS_LOG_FIELDS_BY_EVENT, event);
    }

    /**
     * Rejects nested values that could smuggle response or transcript data.
     *
     * @param fieldName - Allow-listed field whose stricter shape may apply.
     * @param value - Candidate diagnostic value.
     * @returns Whether the value satisfies the public scalar-only contract.
     */
    private static isSafeFieldValue(
        fieldName: string,
        value: unknown,
    ): value is BackendServerAnalysisLogScalar {
        if (
            value === null ||
            value === undefined ||
            typeof value === 'boolean'
        ) {
            return true;
        }
        if (typeof value === 'number') {
            return Number.isFinite(value);
        }
        if (typeof value !== 'string' || value.length > MAX_LOG_STRING_LENGTH) {
            return false;
        }
        if (fieldName === 'videoId') {
            return YOUTUBE_VIDEO_ID_PATTERN.test(value);
        }
        if (fieldName === 'route') {
            return ROUTE_TEMPLATES.has(value);
        }
        return true;
    }
}
