import * as v from 'valibot';

import type { CaptionsFromContentSuccessPayload } from '@/shared/messages';
import {
    refreshServerAnalysisStatusPayloadSchema,
    requestServerAnalysisPayloadSchema,
    SERVER_ANALYSIS_SESSION_EVENT,
    serverAnalysisSessionIdSchema,
    type RefreshServerAnalysisStatusPayload,
    type RequestServerAnalysisPayload,
    type ServerAnalysisSessionEventPayload,
} from '@/shared/messages';
import {
    MS_PER_SECOND,
    SECONDS_PER_MINUTE,
} from '@/shared/constants';
import {
    CaptionTranscriptCanonicalizer,
    MAX_TRANSCRIPT_TIMELINE_SEC,
} from '@topskip/common/captions/canonical-transcript';
import type { ServerTranscriptIdentity } from '@topskip/common/server-analysis-contract';

/**
 * A lost runtime acknowledgement is allowed to wait this long before the
 * immutable operation is treated as interrupted.
 */
export const SERVER_ANALYSIS_RUNTIME_MESSAGE_TIMEOUT_MS =
    SECONDS_PER_MINUTE * MS_PER_SECOND;

/**
 * Short bounded recovery delays let a replacement MV3 worker attach before
 * content retries the same operation.
 */
export const SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS = [
    250,
    750,
    2_000,
    5_000,
] as const;

/**
 * The route lifetime covers the backend's bounded cold-job queue and model deadline.
 */
export const SERVER_ANALYSIS_SESSION_DEADLINE_MS =
    35 * SECONDS_PER_MINUTE * MS_PER_SECOND;

/**
 * Immutable operation kinds determine which runtime payload may be replayed.
 */
export const SERVER_ANALYSIS_OPERATION_KIND = {
    Submit: 'submit',
    Poll: 'poll',
    ExactResubmit: 'exact_resubmit',
} as const;

/**
 * Content session lifecycle prevents a terminal route from recapturing captions.
 */
const SERVER_ANALYSIS_SESSION_STATE = {
    Active: 'active',
    Terminal: 'terminal',
    Cancelled: 'cancelled',
} as const;

/**
 * Request operations retain the exact canonical captions used by the first POST.
 */
type ServerAnalysisRequestOperation = {
    operationId: number;
    kind:
        | typeof SERVER_ANALYSIS_OPERATION_KIND.Submit
        | typeof SERVER_ANALYSIS_OPERATION_KIND.ExactResubmit;
    payload: RequestServerAnalysisPayload;
};

/**
 * Poll operations retain the server-authoritative job and transcript identity.
 */
type ServerAnalysisPollOperation = {
    operationId: number;
    kind: typeof SERVER_ANALYSIS_OPERATION_KIND.Poll;
    payload: RefreshServerAnalysisStatusPayload;
};

/**
 * One immutable runtime operation may be replayed without recapturing captions.
 */
export type ServerAnalysisPendingOperation =
    | ServerAnalysisRequestOperation
    | ServerAnalysisPollOperation;

/**
 * A bounded retry carries the same operation and its deterministic delay.
 */
export type ServerAnalysisTransportRetry = {
    operation: ServerAnalysisPendingOperation;
    retryAfterMs: number;
    retryNumber: number;
};

/**
 * Safe interruption details are the only terminal event with a reason field.
 */
export type ServerAnalysisInterruptionReason = Extract<
    ServerAnalysisSessionEventPayload,
    { event: typeof SERVER_ANALYSIS_SESSION_EVENT.AnalysisInterrupted }
>['reason'];

/**
 * Terminal local failures remain deliverable without retaining captions.
 */
export type ServerAnalysisTerminalEvent =
    | {
          event: Exclude<
              ServerAnalysisSessionEventPayload['event'],
              | typeof SERVER_ANALYSIS_SESSION_EVENT.AcquisitionStarted
              | typeof SERVER_ANALYSIS_SESSION_EVENT.Cancelled
              | typeof SERVER_ANALYSIS_SESSION_EVENT.AnalysisInterrupted
          >;
      }
    | {
          event: typeof SERVER_ANALYSIS_SESSION_EVENT.AnalysisInterrupted;
          reason: ServerAnalysisInterruptionReason;
      };

/**
 * A bounded terminal-event retry reuses the same safe transport delays.
 */
export type ServerAnalysisTerminalEventDeliveryRetry = {
    retryAfterMs: number;
    retryNumber: number;
};

/**
 * Explicit lifecycle states keep terminal sessions as same-video sentinels.
 */
type ServerAnalysisSessionState =
    (typeof SERVER_ANALYSIS_SESSION_STATE)[keyof typeof SERVER_ANALYSIS_SESSION_STATE];

/**
 * Retains one accepted caption payload across polling and MV3 transport recovery.
 */
export class ServerAnalysisSession {
    /**
     * Stable UUID lets content reject late same-video results.
     */
    readonly sessionId: string;

    /**
     * Abort signal owns capture and outstanding runtime wait cancellation.
     */
    readonly signal: AbortSignal;

    /**
     * Active watch identity prevents cross-navigation payload reuse.
     */
    private readonly videoId: string;

    /**
     * Hard wall-clock bound prevents an endless processing sentinel.
     */
    private readonly deadlineAtMs: number;

    /**
     * Controller invalidates all async work when the route ends.
     */
    private readonly abortController: AbortController;

    /**
     * Terminal event delivery remains live after the analysis signal aborts.
     */
    private readonly terminalEventDeliveryAbortController: AbortController;

    /**
     * Captions stay in content memory only until terminal completion or cancellation.
     */
    private retainedRequest: RequestServerAnalysisPayload | null = null;

    /**
     * Processing identity is carried by every poll instead of background memory.
     */
    private pollPayload: RefreshServerAnalysisStatusPayload | null = null;

    /**
     * The current immutable operation is the only operation transport may retry.
     */
    private pendingOperation: ServerAnalysisPendingOperation | null = null;

    /**
     * Monotonic local identity rejects completions from superseded operations.
     */
    private nextOperationId = 1;

    /**
     * Transport failures reset whenever an authoritative response advances state.
     */
    private transportRetryCount = 0;

    /**
     * One-shot recovery prevents repeated deploy failures from looping submissions.
     */
    private resubmissionUsed = false;

    /**
     * Deadline expiry permits exactly one last owner-authorized status read.
     */
    private finalPollUsed = false;

    /**
     * Block delivery precedes its runtime ack, so it dedupes independently of state.
     */
    private terminalDeliveryAccepted = false;

    /**
     * The safe terminal event remains pending until background acknowledges it.
     */
    private pendingTerminalEvent: ServerAnalysisTerminalEvent | null = null;

    /**
     * Each readiness wake may replenish this bounded transport budget.
     */
    private terminalEventDeliveryRetryCount = 0;

    /**
     * Terminal and cancelled states remain distinguishable for route cleanup.
     */
    private state: ServerAnalysisSessionState =
        SERVER_ANALYSIS_SESSION_STATE.Active;

    /**
     * Initializes state only after the factory validates the externally visible UUID.
     *
     * @param videoId - Watch video owned by the session.
     * @param sessionId - Validated bounded UUID.
     * @param startedAtMs - Session start used for the fixed deadline.
     */
    private constructor(
        videoId: string,
        sessionId: string,
        startedAtMs: number,
    ) {
        this.videoId = videoId;
        this.sessionId = sessionId;
        this.deadlineAtMs = startedAtMs + SERVER_ANALYSIS_SESSION_DEADLINE_MS;
        this.abortController = new AbortController();
        this.terminalEventDeliveryAbortController = new AbortController();
        this.signal = this.abortController.signal;
    }

    /**
     * Creates an isolated route session with injectable UUID and clock inputs.
     *
     * @param videoId - Current watch video identifier.
     * @param sessionIdFactory - UUID source, normally Web Crypto.
     * @param startedAtMs - Wall-clock start, injectable for deterministic tests.
     * @returns Fresh cancellable Server-analysis session.
     */
    static create(
        videoId: string,
        sessionIdFactory: () => string = (): string => crypto.randomUUID(),
        startedAtMs = Date.now(),
    ): ServerAnalysisSession {
        const sessionId = v.parse(
            serverAnalysisSessionIdSchema,
            sessionIdFactory(),
        );
        return new ServerAnalysisSession(videoId, sessionId, startedAtMs);
    }

    /**
     * Returns a defensive operation copy so callers cannot alter retry payloads.
     *
     * @param operation - Internally retained immutable operation.
     * @returns Structured copy safe for orchestration and tests.
     */
    private static cloneOperation(
        operation: ServerAnalysisPendingOperation,
    ): ServerAnalysisPendingOperation {
        return structuredClone(operation);
    }

    /**
     * Advances to a caption-bearing operation and resets only transport retries.
     *
     * @param kind - Initial submission or the one exact recovery submission.
     * @param payload - Validated canonical caption request.
     */
    private setRequestOperation(
        kind: ServerAnalysisRequestOperation['kind'],
        payload: RequestServerAnalysisPayload,
    ): void {
        this.pendingOperation = {
            operationId: this.nextOperationId,
            kind,
            payload: structuredClone(payload),
        };
        this.nextOperationId += 1;
        this.transportRetryCount = 0;
    }

    /**
     * Advances to owner-authorized polling and resets only transport retries.
     *
     * @param payload - Validated job and server transcript identity.
     */
    private setPollOperation(payload: RefreshServerAnalysisStatusPayload): void {
        this.pendingOperation = {
            operationId: this.nextOperationId,
            kind: SERVER_ANALYSIS_OPERATION_KIND.Poll,
            payload: structuredClone(payload),
        };
        this.nextOperationId += 1;
        this.transportRetryCount = 0;
    }

    /**
     * Retains validated captions only when they still belong to this active video.
     *
     * @param captions - Successful player-mediated caption capture.
     * @param durationSec - Optional untrusted player duration hint.
     * @returns Defensive request payload, or `null` for stale/cancelled input.
     */
    acceptCaptions(
        captions: CaptionsFromContentSuccessPayload,
        durationSec?: number,
    ): RequestServerAnalysisPayload | null {
        if (!this.isActive() || captions.videoId !== this.videoId) {
            return null;
        }
        const canonical = CaptionTranscriptCanonicalizer.canonicalize({
            languageCode: captions.languageCode,
            segments: captions.segments,
        });
        if (!canonical.ok) {
            return null;
        }
        const duration =
            durationSec !== undefined &&
            Number.isFinite(durationSec) &&
            durationSec >= 0 &&
            durationSec <= MAX_TRANSCRIPT_TIMELINE_SEC
                ? { durationSec }
                : {};
        const parsed = v.safeParse(requestServerAnalysisPayloadSchema, {
            sessionId: this.sessionId,
            videoId: this.videoId,
            ...duration,
            languageCode: canonical.transcript.languageCode,
            segments: canonical.transcript.segments,
        });
        if (!parsed.success) {
            return null;
        }
        this.retainedRequest = structuredClone(parsed.output);
        this.setRequestOperation(
            SERVER_ANALYSIS_OPERATION_KIND.Submit,
            parsed.output,
        );
        return structuredClone(parsed.output);
    }

    /**
     * Returns accepted captions only after capture has completed successfully.
     *
     * @returns Defensive transcript request, or `null` before readiness.
     */
    getRetainedRequest(): RequestServerAnalysisPayload | null {
        if (!this.isActive() || this.retainedRequest === null) {
            return null;
        }
        return structuredClone(this.retainedRequest);
    }

    /**
     * Exposes the immutable watch identity without exposing retained captions.
     *
     * @returns Video id owned by this session.
     */
    getVideoId(): string {
        return this.videoId;
    }

    /**
     * Exposes the fixed wall-clock deadline to the content timer owner.
     *
     * @returns Epoch milliseconds when the final-poll policy begins.
     */
    getDeadlineAtMs(): number {
        return this.deadlineAtMs;
    }

    /**
     * Checks the fixed deadline without mutating recovery state.
     *
     * @param nowMs - Current wall-clock time.
     * @returns Whether the bounded session lifetime has elapsed.
     */
    isDeadlineReached(nowMs = Date.now()): boolean {
        return nowMs >= this.deadlineAtMs;
    }

    /**
     * Pins the authoritative processing identity for stateless future polls.
     *
     * @param jobId - Opaque backend job identifier.
     * @param identity - Server-authoritative transcript identity from the ack.
     * @returns Validated poll payload, or `null` for mismatched state.
     */
    pinProcessing(
        jobId: string,
        identity: ServerTranscriptIdentity,
    ): RefreshServerAnalysisStatusPayload | null {
        if (
            !this.isActive() ||
            this.retainedRequest === null ||
            identity.videoId !== this.videoId ||
            identity.languageCode !== this.retainedRequest.languageCode
        ) {
            return null;
        }
        const parsed = v.safeParse(refreshServerAnalysisStatusPayloadSchema, {
            sessionId: this.sessionId,
            videoId: this.videoId,
            jobId,
            identity,
        });
        if (!parsed.success) {
            return null;
        }
        this.pollPayload = structuredClone(parsed.output);
        this.setPollOperation(parsed.output);
        return structuredClone(parsed.output);
    }

    /**
     * Returns the identity-bearing poll state after a processing acknowledgement.
     *
     * @returns Defensive poll payload, or `null` before processing.
     */
    getPollPayload(): RefreshServerAnalysisStatusPayload | null {
        if (!this.isActive() || this.pollPayload === null) {
            return null;
        }
        return structuredClone(this.pollPayload);
    }

    /**
     * Returns the operation transport must replay after a lost acknowledgement.
     *
     * @returns Defensive current operation, or `null` after route completion.
     */
    getPendingOperation(): ServerAnalysisPendingOperation | null {
        if (!this.isActive() || this.pendingOperation === null) {
            return null;
        }
        return ServerAnalysisSession.cloneOperation(this.pendingOperation);
    }

    /**
     * Rejects a late response after an authoritative ack advanced the session.
     *
     * @param operationId - Local identity captured before runtime messaging.
     * @returns Whether that operation still owns the active response slot.
     */
    isCurrentOperation(operationId: number): boolean {
        return (
            this.isActive() &&
            this.pendingOperation?.operationId === operationId
        );
    }

    /**
     * Consumes the next deterministic retry slot for the same operation.
     *
     * @returns Retry operation and delay, or `null` when recovery is exhausted.
     */
    takeTransportRetry(): ServerAnalysisTransportRetry | null {
        if (!this.isActive() || this.pendingOperation === null) {
            return null;
        }
        const retryAfterMs =
            SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS[this.transportRetryCount];
        if (retryAfterMs === undefined) {
            return null;
        }
        this.transportRetryCount += 1;
        return {
            operation: ServerAnalysisSession.cloneOperation(
                this.pendingOperation,
            ),
            retryAfterMs,
            retryNumber: this.transportRetryCount,
        };
    }

    /**
     * Releases the retained transcript for one exact recovery submission only.
     *
     * @returns Original validated request once, then `null`.
     */
    takeExactResubmission(): RequestServerAnalysisPayload | null {
        if (
            !this.isActive() ||
            this.retainedRequest === null ||
            this.resubmissionUsed
        ) {
            return null;
        }
        this.resubmissionUsed = true;
        this.pollPayload = null;
        this.setRequestOperation(
            SERVER_ANALYSIS_OPERATION_KIND.ExactResubmit,
            this.retainedRequest,
        );
        return structuredClone(this.retainedRequest);
    }

    /**
     * Releases one final poll without creating another retryable operation.
     *
     * @returns Current poll exactly once, otherwise `null`.
     */
    takeFinalPoll(): ServerAnalysisPollOperation | null {
        if (
            !this.isActive() ||
            this.finalPollUsed ||
            this.pendingOperation?.kind !== SERVER_ANALYSIS_OPERATION_KIND.Poll
        ) {
            return null;
        }
        this.finalPollUsed = true;
        return structuredClone(this.pendingOperation);
    }

    /**
     * Reports whether new route work may still advance this session.
     *
     * @returns Whether the session remains active.
     */
    isActive(): boolean {
        return this.state === SERVER_ANALYSIS_SESSION_STATE.Active;
    }

    /**
     * Reports terminal state without making a same-video session restartable.
     *
     * @returns Whether an authoritative terminal outcome already won.
     */
    isTerminal(): boolean {
        return this.state === SERVER_ANALYSIS_SESSION_STATE.Terminal;
    }

    /**
     * Retains one safe local failure before analysis becomes terminal.
     *
     * @param event - Caption or transport failure without sensitive details.
     * @returns Whether this became the pending terminal event.
     */
    retainTerminalEvent(event: ServerAnalysisTerminalEvent): boolean {
        if (!this.isActive() || this.pendingTerminalEvent !== null) {
            return false;
        }
        this.pendingTerminalEvent = structuredClone(event);
        this.terminalEventDeliveryRetryCount = 0;
        return true;
    }

    /**
     * Exposes only the bounded event required to rebuild the runtime message.
     *
     * @returns Pending terminal event, or `null` after acknowledgement.
     */
    getPendingTerminalEvent(): ServerAnalysisTerminalEvent | null {
        if (!this.isTerminal()) {
            return null;
        }
        return this.pendingTerminalEvent === null
            ? null
            : structuredClone(this.pendingTerminalEvent);
    }

    /**
     * Separately cancels delivery when navigation invalidates a terminal route.
     *
     * @returns Signal that remains live through the analysis terminal transition.
     */
    getTerminalEventDeliverySignal(): AbortSignal {
        return this.terminalEventDeliveryAbortController.signal;
    }

    /**
     * Consumes one bounded retry delay while retaining the terminal event.
     *
     * @returns Next retry delay, or `null` after this wake cycle is exhausted.
     */
    takeTerminalEventDeliveryRetry(): ServerAnalysisTerminalEventDeliveryRetry | null {
        if (!this.isTerminal() || this.pendingTerminalEvent === null) {
            return null;
        }
        const retryAfterMs =
            SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS[
                this.terminalEventDeliveryRetryCount
            ];
        if (retryAfterMs === undefined) {
            return null;
        }
        this.terminalEventDeliveryRetryCount += 1;
        return {
            retryAfterMs,
            retryNumber: this.terminalEventDeliveryRetryCount,
        };
    }

    /**
     * Replenishes delivery attempts only after a worker readiness wake.
     *
     * @returns Whether a pending terminal event may be attempted again.
     */
    restartTerminalEventDeliveryRetries(): boolean {
        if (!this.isTerminal() || this.pendingTerminalEvent === null) {
            return false;
        }
        this.terminalEventDeliveryRetryCount = 0;
        return true;
    }

    /**
     * Clears the retained event exactly once after a valid background ack.
     *
     * @returns Whether this was the first accepted acknowledgement.
     */
    acknowledgeTerminalEventDelivery(): boolean {
        if (!this.isTerminal() || this.pendingTerminalEvent === null) {
            return false;
        }
        this.pendingTerminalEvent = null;
        this.terminalEventDeliveryRetryCount = 0;
        return true;
    }

    /**
     * Accepts only the first terminal block delivery for playback state.
     *
     * @returns Whether this delivery became the authoritative terminal outcome.
     */
    acceptTerminalDelivery(): boolean {
        if (!this.isActive() || this.terminalDeliveryAccepted) {
            return false;
        }
        this.terminalDeliveryAccepted = true;
        return true;
    }

    /**
     * Releases sensitive data while retaining a terminal same-video sentinel.
     *
     * @returns Whether this call performed the first terminal transition.
     */
    complete(): boolean {
        if (!this.isActive()) {
            return false;
        }
        this.state = SERVER_ANALYSIS_SESSION_STATE.Terminal;
        this.abortController.abort();
        this.retainedRequest = null;
        this.pollPayload = null;
        this.pendingOperation = null;
        return true;
    }

    /**
     * Invalidates capture, polling, retained captions, and late completion.
     *
     * @returns Whether this call performed route cancellation.
     */
    cancel(): boolean {
        if (this.state === SERVER_ANALYSIS_SESSION_STATE.Cancelled) {
            return false;
        }
        this.state = SERVER_ANALYSIS_SESSION_STATE.Cancelled;
        this.abortController.abort();
        this.retainedRequest = null;
        this.pollPayload = null;
        this.pendingOperation = null;
        this.pendingTerminalEvent = null;
        this.terminalEventDeliveryRetryCount = 0;
        this.terminalEventDeliveryAbortController.abort();
        return true;
    }
}
