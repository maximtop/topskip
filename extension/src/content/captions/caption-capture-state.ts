import type {
    CaptionCaptureSession,
    CaptionCaptureSnapshot,
    CapturedTimedtextPayload,
} from '@/content/captions/caption-capture-types';

let nextActivationId = 0;

/**
 * Creates a per-video session token so stale page events can be ignored.
 *
 * @param videoId Current YouTube watch video id.
 * @param captureTimeoutMs Bounded wait for the player-mediated request.
 * @returns New caption capture session.
 */
export function createCaptureSession(
    videoId: string,
    captureTimeoutMs: number,
): CaptionCaptureSession {
    nextActivationId += 1;
    return {
        videoId,
        activationId: `topskip-caption-${String(nextActivationId)}`,
        startedAtMs: Date.now(),
        captureTimeoutMs,
        state: 'idle',
        wasOn: null,
        userIntervened: false,
    };
}

/**
 * Protects the current video from captions captured during SPA navigation.
 *
 * @param session Active capture session.
 * @param payload Page-world timedtext capture payload.
 * @returns Whether the payload belongs to another video.
 */
export function shouldIgnoreCapturedTimedtext(
    session: CaptionCaptureSession,
    payload: CapturedTimedtextPayload,
): boolean {
    return payload.videoId !== session.videoId;
}

/**
 * Restores captions only when TopSkip made the temporary state change.
 *
 * @param snapshot Pre-capture user state plus later intervention flag.
 * @returns Whether cleanup should turn captions back off.
 */
export function shouldRestoreCaptionsOff(
    snapshot: CaptionCaptureSnapshot,
): boolean {
    return !snapshot.wasOn && !snapshot.userIntervened;
}
