import * as v from 'valibot';

import type { CaptionsFromContentSuccessPayload } from '@/shared/messages';
import {
    refreshServerAnalysisStatusPayloadSchema,
    requestServerAnalysisPayloadSchema,
    serverAnalysisSessionIdSchema,
    type RefreshServerAnalysisStatusPayload,
    type RequestServerAnalysisPayload,
} from '@/shared/messages';
import {
    CaptionTranscriptCanonicalizer,
    MAX_TRANSCRIPT_TIMELINE_SEC,
} from '@topskip/common/captions/canonical-transcript';
import type { ServerTranscriptIdentity } from '@topskip/common/server-analysis-contract';

/**
 * Retains one accepted caption payload across polling and one deploy recovery.
 */
export class ServerAnalysisSession {
    /**
     * Stable UUID lets content reject late same-video results.
     */
    readonly sessionId: string;

    /**
     * Abort signal owns capture and polling cancellation for this route attempt.
     */
    readonly signal: AbortSignal;

    /**
     * Active watch identity prevents cross-navigation payload reuse.
     */
    private readonly videoId: string;

    /**
     * Controller invalidates all async work when the route is superseded.
     */
    private readonly abortController: AbortController;

    /**
     * Captions stay in content memory only until terminal completion or cancellation.
     */
    private retainedRequest: RequestServerAnalysisPayload | null = null;

    /**
     * Processing identity is carried by every poll instead of background memory.
     */
    private pollPayload: RefreshServerAnalysisStatusPayload | null = null;

    /**
     * One-shot recovery prevents repeated deploy failures from looping submissions.
     */
    private resubmissionUsed = false;

    /**
     * Initializes state only after the factory validates the externally visible UUID.
     *
     * @param videoId - Watch video owned by the session.
     * @param sessionId - Validated bounded UUID.
     */
    private constructor(videoId: string, sessionId: string) {
        this.videoId = videoId;
        this.sessionId = sessionId;
        this.abortController = new AbortController();
        this.signal = this.abortController.signal;
    }

    /**
     * Creates an isolated route session with an injectable UUID factory for tests.
     *
     * @param videoId - Current watch video identifier.
     * @param sessionIdFactory - UUID source, normally Web Crypto.
     * @returns Fresh cancellable Server-analysis session.
     */
    static create(
        videoId: string,
        sessionIdFactory: () => string = (): string => crypto.randomUUID(),
    ): ServerAnalysisSession {
        const sessionId = v.parse(
            serverAnalysisSessionIdSchema,
            sessionIdFactory(),
        );
        return new ServerAnalysisSession(videoId, sessionId);
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
        if (this.signal.aborted || captions.videoId !== this.videoId) {
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
        return structuredClone(parsed.output);
    }

    /**
     * Returns accepted captions only after capture has completed successfully.
     *
     * @returns Defensive transcript request, or `null` before readiness.
     */
    getRetainedRequest(): RequestServerAnalysisPayload | null {
        if (this.signal.aborted || this.retainedRequest === null) {
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
            this.signal.aborted ||
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
        return structuredClone(parsed.output);
    }

    /**
     * Returns the identity-bearing poll state after a processing acknowledgement.
     *
     * @returns Defensive poll payload, or `null` before processing.
     */
    getPollPayload(): RefreshServerAnalysisStatusPayload | null {
        if (this.signal.aborted || this.pollPayload === null) {
            return null;
        }
        return structuredClone(this.pollPayload);
    }

    /**
     * Releases the retained transcript for one exact recovery submission only.
     *
     * @returns Original validated request once, then `null`.
     */
    takeExactResubmission(): RequestServerAnalysisPayload | null {
        if (
            this.signal.aborted ||
            this.retainedRequest === null ||
            this.resubmissionUsed
        ) {
            return null;
        }
        this.resubmissionUsed = true;
        this.pollPayload = null;
        return structuredClone(this.retainedRequest);
    }

    /**
     * Releases caption and poll data while keeping the session id valid for block delivery.
     *
     * @returns Nothing.
     */
    complete(): void {
        this.retainedRequest = null;
        this.pollPayload = null;
    }

    /**
     * Invalidates capture, polling, retained captions, and late completion.
     *
     * @returns Nothing.
     */
    cancel(): void {
        if (!this.signal.aborted) {
            this.abortController.abort();
        }
        this.retainedRequest = null;
        this.pollPayload = null;
    }
}
