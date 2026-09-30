/**
 * @file Shared types for the player-mediated caption capture flow: session
 * state, captured payload/URL shapes, and terminal capture results.
 */

import type {
    CaptionCaptureFailureReason,
    CaptionsFromContentSuccessPayload,
} from '@/shared/messages';

/**
 * State names for one player-mediated caption capture session.
 */
export type CaptionCaptureState = | 'idle'
    | 'installing'
    | 'activating'
    | 'waiting-capture'
    | 'cleaning-up'
    | 'done'
    | 'failed';

/**
 * Mutable session metadata tracked while capturing captions for a video.
 */
export interface CaptionCaptureSession {
    /**
     * Current YouTube watch video id this session captures for.
     */
    videoId: string;

    /**
     * Per-session activation token so stale page events can be ignored.
     */
    activationId: string;

    /**
     * Wall-clock time (`Date.now()`) the session was created.
     */
    startedAtMs: number;

    /**
     * Bounded wait in ms for the player-mediated capture request.
     */
    captureTimeoutMs: number;

    /**
     * Current lifecycle state of this capture session.
     */
    state: CaptionCaptureState;

    /**
     * Whether captions were on before TopSkip touched the player; `null`
     * before the pre-capture snapshot is taken.
     */
    wasOn: boolean | null;

    /**
     * Whether the user changed the caption toggle during capture.
     */
    userIntervened: boolean;
}

/**
 * Sanitized timedtext URL metadata safe to include in diagnostics.
 */
export interface CapturedTimedtextUrlShape {
    /**
     * Timedtext request path, without query string.
     */
    pathname: string;

    /**
     * Query parameter names present on the request; values are never included.
     */
    paramNames: string[];

    /**
     * Timedtext response format (`fmt` query param), or `null` when absent.
     */
    fmt: string | null;

    /**
     * Whether the request carried a `pot` (proof-of-origin token) parameter.
     */
    hasPot: boolean;
}

/**
 * Snapshot of caption state before TopSkip touches the player.
 */
export interface CaptionCaptureSnapshot {
    /**
     * Whether captions were on before TopSkip touched the player.
     */
    wasOn: boolean;

    /**
     * Whether the user changed the caption toggle during capture.
     */
    userIntervened: boolean;
}

/**
 * Successful page-world timedtext capture payload.
 */
export interface CapturedTimedtextPayload {
    /**
     * Video id the timedtext response was captured for.
     */
    videoId: string;

    /**
     * Caption track language of the captured response.
     */
    languageCode: string;

    /**
     * Raw timedtext response body.
     */
    body: string;

    /**
     * Response `Content-Type` header value, or `null` when absent.
     */
    contentType: string | null;

    /**
     * Length of `body` in characters.
     */
    bodyLength: number;

    /**
     * Sanitized request URL metadata for diagnostics.
     */
    urlShape: CapturedTimedtextUrlShape;
}

/**
 * Structured caption capture failure returned to the watch orchestrator.
 */
export interface CaptionCaptureFailure {
    /**
     * Stable failure classification.
     */
    reason: CaptionCaptureFailureReason;

    /**
     * Human-readable failure message, safe to log or display.
     */
    message: string;

    /**
     * Bounded diagnostic detail attached when available; omitted otherwise.
     */
    diagnostics?: {
        /**
         * Capture stage the failure occurred at.
         */
        stage: string;

        /**
         * Captured response body length, when a response was received.
         */
        bodyLength?: number;

        /**
         * Caption track language involved in the failure, when known.
         */
        languageCode?: string;

        /**
         * Sanitized request URL metadata, when a request was involved.
         */
        urlShape?: CapturedTimedtextUrlShape;
    };
}

/**
 * Terminal result returned to the watch route that owns the capture session.
 */
export type CaptionCaptureResult = | { status: 'ready'; payload: CaptionsFromContentSuccessPayload }
    | { status: 'failed'; failure: CaptionCaptureFailure }
    | { status: 'cancelled' };

/**
 * Input that binds one player capture to its owning watch session.
 */
export interface CaptionCaptureInput {
    /**
     * Current watch video id to capture captions for.
     */
    videoId: string;

    /**
     * Owner cancellation, aborted when the watch route tears down.
     */
    signal: AbortSignal;

    /**
     * Bounded wait in ms for the player-mediated capture request, when set.
     */
    captureTimeoutMs?: number | undefined;
}
