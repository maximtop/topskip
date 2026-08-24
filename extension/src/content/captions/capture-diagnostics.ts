import type { CapturedTimedtextUrlShape } from '@/content/captions/caption-capture-types';
import { DEBUG_LOG_BRIDGE_DIAGNOSTICS_PER_SESSION } from '@/shared/debug-log-constants';
import {
    DEBUG_LOG_EVENT,
    DEBUG_LOG_PAGE_STAGE_PREFIX,
    type DebugLogEventName,
    type DebugLogFields,
} from '@/shared/debug-log-events';

/**
 * MAIN-bridge stage names the ISOLATED side forwards. Everything else that
 * arrives on the page channel is ignored because any page script can forge a
 * diagnostic message; the dev-only bridge stages are redundant with the
 * ISOLATED stages and stay out of the log.
 */
export const CAPTION_PAGE_DIAGNOSTIC_STAGES: ReadonlySet<string> = new Set([
    'timedtext-observed',
    'timedtext-empty-body',
    'timedtext-non-json',
    'timedtext-forwarded',
    'activation-finished',
]);

/**
 * Page-supplied strings longer than this are treated as forged or corrupt.
 */
export const MAX_PAGE_DIAGNOSTIC_STRING_LENGTH = 64;

/**
 * Marks a stage that originated in the MAIN-world bridge; the append
 * envelope carries no source field, so the prefix keeps bridge and ISOLATED
 * stages apart on the log line and lets the background stamp the `bridge`
 * source (shared constant `DEBUG_LOG_PAGE_STAGE_PREFIX`).
 */
export const PAGE_DIAGNOSTIC_STAGE_PREFIX = DEBUG_LOG_PAGE_STAGE_PREFIX;

/**
 * Event plus bounded scalar fields ready for `DebugLogClient.log`.
 */
export type CaptureDebugLogEvent = {
    event: DebugLogEventName;
    fields: DebugLogFields;
};

/**
 * Structured capture details as passed to the ISOLATED stage logger.
 */
export type CaptureStageDetails = Readonly<Record<string, unknown>>;

/**
 * Page diagnostic details after the ISOLATED field whitelist; the stage is
 * required, everything else is page-controlled.
 */
export type BridgeDiagnosticDetails = CaptureStageDetails & { stage: string };

/**
 * Bounded scalar values accepted into an event.
 */
type CaptureScalarFields = Record<string, string | number | boolean>;

/**
 * A failure that will be retried stays dev-console only so one capture
 * cannot emit dozens of activation events.
 */
const ACTIVATION_FAILED_STAGE = 'activation-failed';

/**
 * Cancellation stage whose `source` names the cancel reason.
 */
const SCHEDULE_CLEAR_STAGE = 'schedule-clear';

/**
 * Detail keys copied verbatim when present; all are in the caption-capture
 * family's permitted set.
 */
const CAPTURE_SCALAR_FIELDS = [
    'transport',
    'status',
    'bodyLength',
    'contentType',
    'ok',
    'wasOn',
    'userIntervened',
    'hasTracks',
    'reason',
] as const;

/**
 * ISOLATED / bridge stage names → debug log events. Stages outside this
 * table are dev-console only (duplicates, attempts, chatter, or failures
 * already covered by the single `capture-failed` emitted from the failure
 * choke point).
 */
const CAPTURE_STAGE_EVENTS: Readonly<Partial<Record<string, DebugLogEventName>>> = {
    'schedule-start': DEBUG_LOG_EVENT.CaptureScheduled,
    'schedule-clear': DEBUG_LOG_EVENT.CaptureStage,
    'capture-start': DEBUG_LOG_EVENT.CaptureStage,
    'bridge-ready': DEBUG_LOG_EVENT.CaptureStage,
    'activation-accepted': DEBUG_LOG_EVENT.CaptureActivation,
    'activation-failed': DEBUG_LOG_EVENT.CaptureActivation,
    'capture-event-received': DEBUG_LOG_EVENT.CaptureStage,
    'capture-parsed': DEBUG_LOG_EVENT.CaptureSucceeded,
    'capture-failed': DEBUG_LOG_EVENT.CaptureFailed,
    'cleanup-start': DEBUG_LOG_EVENT.CaptureStage,
    'cleanup-finished': DEBUG_LOG_EVENT.CaptureStage,
    'cleanup-failed': DEBUG_LOG_EVENT.CaptureStage,
    [`${PAGE_DIAGNOSTIC_STAGE_PREFIX}timedtext-observed`]: DEBUG_LOG_EVENT.CaptureStage,
    [`${PAGE_DIAGNOSTIC_STAGE_PREFIX}timedtext-empty-body`]: DEBUG_LOG_EVENT.CaptureStage,
    [`${PAGE_DIAGNOSTIC_STAGE_PREFIX}timedtext-non-json`]: DEBUG_LOG_EVENT.CaptureStage,
    [`${PAGE_DIAGNOSTIC_STAGE_PREFIX}timedtext-forwarded`]: DEBUG_LOG_EVENT.CaptureStage,
    [`${PAGE_DIAGNOSTIC_STAGE_PREFIX}activation-finished`]:
        DEBUG_LOG_EVENT.CaptureActivation,
};

/**
 * Pure mapping from caption-capture stages (ISOLATED and MAIN-bridge) to the
 * debug log vocabulary, plus the acceptance gate for page-forgeable bridge
 * diagnostics. Static API only; no I/O.
 */
export class CaptureDiagnostics {
    /**
     * Maps one stage to its event with only permitted, bounded scalar
     * fields: free-form text (`error`), ids, timers, and nested values are
     * dropped; `languageCode` → `lang`, `segmentCount` → `segments`,
     * `actions[]` → count, `urlShape` → `urlPath`/`urlParams`/`fmt`/`hasPot`.
     *
     * @param stage - Stage name as logged by `PlayerCaptionCapture`.
     * @param details - Structured stage details.
     * @returns Event and fields, or `null` for dev-console-only stages.
     */
    static toDebugLogEvent(
        stage: string,
        details: CaptureStageDetails,
    ): CaptureDebugLogEvent | null {
        if (stage === ACTIVATION_FAILED_STAGE && details.retrying === true) {
            return null;
        }
        const event = CAPTURE_STAGE_EVENTS[stage];
        if (event === undefined) {
            return null;
        }
        const fields: CaptureScalarFields = {};
        if (event === DEBUG_LOG_EVENT.CaptureScheduled) {
            CaptureDiagnostics.copyScalar(details, 'source', fields, 'trigger');
            return { event, fields };
        }
        if (event === DEBUG_LOG_EVENT.CaptureStage) {
            fields.stage = stage;
            if (stage === SCHEDULE_CLEAR_STAGE) {
                CaptureDiagnostics.copyScalar(details, 'source', fields, 'reason');
            }
        }
        if (event === DEBUG_LOG_EVENT.CaptureFailed) {
            CaptureDiagnostics.copyScalar(details, 'stage', fields, 'stage');
        }
        for (const key of CAPTURE_SCALAR_FIELDS) {
            CaptureDiagnostics.copyScalar(details, key, fields, key);
        }
        CaptureDiagnostics.copyScalar(details, 'languageCode', fields, 'lang');
        CaptureDiagnostics.copyScalar(details, 'segmentCount', fields, 'segments');
        const actions: unknown = details.actions;
        if (Array.isArray(actions)) {
            fields.actions = actions.length;
        }
        CaptureDiagnostics.copyUrlShape(details.urlShape, fields);
        return { event, fields };
    }

    /**
     * Gate for page-forgeable MAIN-bridge diagnostics: allow-listed stage,
     * bounded strings, bounded count per capture session. Callers must also
     * require an owned capture session and the switch being on.
     *
     * @param details - Whitelisted page diagnostic fields.
     * @param sessionCounter - Diagnostics already accepted in this session.
     * @returns Whether the diagnostic may reach the debug log.
     */
    static acceptBridgeDiagnostic(
        details: BridgeDiagnosticDetails,
        sessionCounter: number,
    ): boolean {
        if (sessionCounter >= DEBUG_LOG_BRIDGE_DIAGNOSTICS_PER_SESSION) {
            return false;
        }
        if (!CAPTION_PAGE_DIAGNOSTIC_STAGES.has(details.stage)) {
            return false;
        }
        return CaptureDiagnostics.hasBoundedStrings(details);
    }

    /**
     * Narrows sanitized URL-shape metadata (path, parameter names, format,
     * `pot` presence) without ever accepting parameter values.
     *
     * @param value - Untrusted value.
     * @returns Whether the value is safe URL-shape metadata.
     */
    static isUrlShape(value: unknown): value is CapturedTimedtextUrlShape {
        if (value === null || typeof value !== 'object') {
            return false;
        }
        const pathname: unknown = Reflect.get(value, 'pathname');
        const paramNames: unknown = Reflect.get(value, 'paramNames');
        const fmt: unknown = Reflect.get(value, 'fmt');
        const hasPot: unknown = Reflect.get(value, 'hasPot');
        return (
            typeof pathname === 'string' &&
            Array.isArray(paramNames) &&
            paramNames.every((item) => typeof item === 'string') &&
            (fmt === null || typeof fmt === 'string') &&
            typeof hasPot === 'boolean'
        );
    }

    /**
     * Copies one bounded scalar (string, finite number, boolean) under a
     * possibly renamed key; null, undefined and structured values are dropped.
     *
     * @param details - Source details.
     * @param key - Source key.
     * @param fields - Destination fields.
     * @param targetKey - Destination key.
     */
    private static copyScalar(
        details: CaptureStageDetails,
        key: string,
        fields: CaptureScalarFields,
        targetKey: string,
    ): void {
        const value: unknown = details[key];
        if (
            typeof value === 'string' ||
            typeof value === 'boolean' ||
            (typeof value === 'number' && Number.isFinite(value))
        ) {
            fields[targetKey] = value;
        }
    }

    /**
     * Splits the sanitized URL shape into the family's scalar fields.
     *
     * @param value - Candidate URL shape.
     * @param fields - Destination fields.
     */
    private static copyUrlShape(value: unknown, fields: CaptureScalarFields): void {
        if (!CaptureDiagnostics.isUrlShape(value)) {
            return;
        }
        fields.urlPath = value.pathname;
        fields.urlParams = value.paramNames.join(',');
        if (value.fmt !== null) {
            fields.fmt = value.fmt;
        }
        fields.hasPot = value.hasPot;
    }

    /**
     * Rejects details carrying any string beyond the page cap, including the
     * URL shape's path, format, and parameter names.
     *
     * @param details - Whitelisted page diagnostic fields.
     * @returns Whether every string is within the cap.
     */
    private static hasBoundedStrings(details: CaptureStageDetails): boolean {
        const tooLong = (text: string): boolean =>
            text.length > MAX_PAGE_DIAGNOSTIC_STRING_LENGTH;
        for (const value of Object.values(details)) {
            if (typeof value === 'string' && tooLong(value)) {
                return false;
            }
        }
        const urlShape: unknown = details.urlShape;
        if (!CaptureDiagnostics.isUrlShape(urlShape)) {
            return true;
        }
        return ![urlShape.pathname, urlShape.fmt ?? '', ...urlShape.paramNames].some(
            tooLong,
        );
    }
}
