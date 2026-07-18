import type {
    CaptionCaptureFailureReason,
    CaptionsFromContentSuccessPayload,
} from '@/shared/messages';

/**
 * State names for one player-mediated caption capture session.
 */
export type CaptionCaptureState =
    | 'idle'
    | 'installing'
    | 'activating'
    | 'waiting-capture'
    | 'cleaning-up'
    | 'done'
    | 'failed';

/**
 * Mutable session metadata tracked while capturing captions for a video.
 */
export type CaptionCaptureSession = {
    videoId: string;
    activationId: string;
    startedAtMs: number;
    captureTimeoutMs: number;
    state: CaptionCaptureState;
    wasOn: boolean | null;
    userIntervened: boolean;
};

/**
 * Sanitized timedtext URL metadata safe to include in diagnostics.
 */
export type CapturedTimedtextUrlShape = {
    pathname: string;
    paramNames: string[];
    fmt: string | null;
    hasPot: boolean;
};

/**
 * Snapshot of caption state before TopSkip touches the player.
 */
export type CaptionCaptureSnapshot = {
    wasOn: boolean;
    userIntervened: boolean;
};

/**
 * Successful page-world timedtext capture payload.
 */
export type CapturedTimedtextPayload = {
    videoId: string;
    languageCode: string;
    body: string;
    contentType: string | null;
    bodyLength: number;
    urlShape: CapturedTimedtextUrlShape;
};

/**
 * Structured caption capture failure returned to the watch orchestrator.
 */
export type CaptionCaptureFailure = {
    reason: CaptionCaptureFailureReason;
    message: string;
    diagnostics?: {
        stage: string;
        bodyLength?: number;
        languageCode?: string;
        urlShape?: CapturedTimedtextUrlShape;
    };
};

/**
 * Terminal result returned to the watch route that owns the capture session.
 */
export type CaptionCaptureResult =
    | { status: 'ready'; payload: CaptionsFromContentSuccessPayload }
    | { status: 'failed'; failure: CaptionCaptureFailure }
    | { status: 'cancelled' };

/**
 * Input that binds one player capture to its owning watch session.
 */
export type CaptionCaptureInput = {
    videoId: string;
    signal: AbortSignal;
    captureTimeoutMs?: number;
};
