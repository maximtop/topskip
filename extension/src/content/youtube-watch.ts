import * as v from 'valibot';

import {
    evaluatePromoBlocksSkip,
    promoBlockStartKey,
    resetFiredIndicesOnBackwardSeek,
} from '@/content/promo-skip-logic';
import {
    E2E_HOST,
    getWatchVideoIdFromSearch,
    shouldActivateTopSkip,
} from '@/content/page-guards';
import {
    buildRefreshServerAnalysisStatusMessage,
    buildRequestServerAnalysisMessage,
    shouldUseServerAnalysis,
} from '@/content/server-analysis-request';
import { ServerAnalysisSession } from '@/content/server-analysis-session';
import { contentLog } from '@/content/content-log';
import { ContentServerAnalysisLog } from '@/content/server-analysis-log';
import { WatchCaptions } from '@/content/watch-captions';
import browser from '@/shared/browser';
import {
    ANALYSIS_MODE,
    MS_PER_SECOND,
    type AnalysisMode,
    type UserPreferences,
} from '@/shared/constants';
import {
    CAPTION_CAPTURE_FAILURE_REASON,
    pickMessage,
    requestServerAnalysisResponseSchema,
    TOPSKIP_MESSAGE,
    type RequestServerAnalysisResponse,
    type ServerAnalysisSessionEventPayload,
} from '@/shared/messages';
import type { PromoBlock } from '@topskip/common/promo-types';
import { translator } from '@/shared/i18n/translator';
import {
    SKIP_TOAST_BOTTOM_PX,
    SKIP_TOAST_DISPLAY_MS,
    SKIP_TOAST_FADE_MS,
    SKIP_TOAST_ID,
    SKIP_TOAST_Z_INDEX,
    VIDEO_BINDING_POLL_INTERVAL_MS,
    YOUTUBE_AD_OVERLAY_SELECTOR,
    YOUTUBE_PLAYER_SELECTOR,
    YOUTUBE_VIDEO_ELEMENT_SELECTOR,
} from '@/content/youtube-dom';

/**
 * Stores the teardown callback for each bound `<video>` element.
 * Using a WeakMap avoids patching the DOM element with extension-private
 * properties and allows GC if the element is removed.
 */
const videoCleanup = new WeakMap<HTMLVideoElement, () => void>();

/**
 * Retains an assigned route until navigation clears the current-video lock.
 *
 * @param currentMode - Route already assigned to the active video, if any.
 * @param prefs - Latest preference snapshot.
 * @returns Existing route, or the selected route when the video is first routed.
 */
export function resolveAnalysisModeForCurrentVideo(
    currentMode: AnalysisMode | null,
    prefs: UserPreferences,
): AnalysisMode | null {
    if (currentMode !== null) {
        return currentMode;
    }
    return prefs.enabled ? prefs.analysisMode : null;
}

/**
 * Rejects late Server blocks after navigation or a same-video session replacement.
 *
 * @param input - Current route identity and the delivered block-message identity.
 * @returns Whether playback may accept the blocks.
 */
export function shouldAcceptPromoBlocksForActiveRoute(input: {
    currentVideoId: string | null;
    messageVideoId: string;
    source: 'server' | 'local_cache' | 'server_cache' | 'local_provider';
    activeSessionId: string | null;
    messageSessionId?: string;
}): boolean {
    if (input.messageVideoId !== input.currentVideoId) {
        return false;
    }
    if (input.source === 'local_provider') {
        return true;
    }
    return (
        input.activeSessionId !== null &&
        input.messageSessionId === input.activeSessionId
    );
}

/**
 * Prevents binding polls and player swaps from repeating a BYOK readiness probe.
 *
 * @param analysisMode - Route locked to the current video.
 * @param videoId - Current non-empty video id.
 * @param requestedVideoId - Video id already preflighted, if any.
 * @returns Whether the current video needs its one readiness probe.
 */
export function shouldRequestByokSetupPreflight(
    analysisMode: AnalysisMode | null,
    videoId: string,
    requestedVideoId: string | null,
): boolean {
    return analysisMode === ANALYSIS_MODE.Byok && requestedVideoId !== videoId;
}

/**
 * YouTube watch DOM + runtime messaging; not instantiable.
 */
export class YoutubeWatch {
    /**
     * Preferences from background; `null` means routing waits for GET_PREFS.
     */
    private static prefs: UserPreferences | null = null;
    /**
     * Watch URL video id (or e2e fixture id) for the bound player.
     */
    private static currentVideoId: string | null = null;
    /**
     * Analysis route fixed for the lifetime of the current video id.
     */
    private static analysisModeForCurrentVideo: AnalysisMode | null = null;
    /**
     * Video id whose caption-independent BYOK readiness probe was sent.
     */
    private static byokPreflightVideoId: string | null = null;
    /**
     * Active Server route owns cancellation, retained captions, and poll identity.
     */
    private static serverAnalysisSession: ServerAnalysisSession | null = null;
    /**
     * Timer id for the content-owned server job polling loop.
     */
    private static serverAnalysisPollTimerId: number | null = null;
    /**
     * Last emitted route snapshot prevents the binding poll from flooding logs.
     */
    private static serverAnalysisRouteLogKey: string | null = null;
    /**
     * Last video id for which BYOK caption capture was scheduled.
     */
    private static captionScheduledVideoId: string | null = null;
    /**
     * Last `timeupdate` position used for seek / skip heuristics.
     */
    private static lastTime = 0;
    /**
     * True while the user is scrubbing so we do not treat jumps as promos.
     */
    private static isSeeking = false;
    /**
     * Currently bound `<video>` element, if any.
     */
    private static boundVideo: HTMLVideoElement | null = null;
    /**
     * Merged promo blocks from background for the current video.
     */
    private static promoBlocks: PromoBlock[] = [];
    /**
     * Rounded {@link promoBlockStartKey} for blocks that already skipped.
     */
    private static firedPromoBlockStartKeys = new Set<number>();

    /**
     * Current page’s watch `v` query param (or e2e fixture id).
     *
     * @returns The video id from the URL, or `null`.
     */
    private static getWatchVideoId(): string | null {
        return getWatchVideoIdFromSearch(location.hostname, location.search);
    }

    /**
     * Whether this document URL is one TopSkip should handle (watch or e2e).
     *
     * @returns `true` when TopSkip should run on this page.
     */
    static shouldActivateForPage(): boolean {
        return shouldActivateTopSkip({
            hostname: location.hostname,
            pathname: location.pathname,
            search: location.search,
        });
    }

    /**
     * Heuristic: true when the YouTube player UI indicates an ad is showing.
     *
     * @returns Whether an ad overlay appears active.
     */
    private static isLikelyAdPlaying(): boolean {
        const overlay = document.querySelector(YOUTUBE_AD_OVERLAY_SELECTOR);
        if (overlay) {
            const style = getComputedStyle(overlay);
            if (style.display !== 'none' && style.visibility !== 'hidden') {
                return true;
            }
        }
        const player = document.querySelector(YOUTUBE_PLAYER_SELECTOR);
        return player?.classList.contains('ad-showing') ?? false;
    }

    /**
     * Resolves the primary watch `<video>` element (main player or e2e page).
     *
     * @returns The main player video element, or `null` if not found.
     */
    private static getMainVideo(): HTMLVideoElement | null {
        if (location.hostname === E2E_HOST) {
            const v = document.querySelector('video');
            return v instanceof HTMLVideoElement ? v : null;
        }
        const el = document.querySelector(YOUTUBE_VIDEO_ELEMENT_SELECTOR);
        return el instanceof HTMLVideoElement ? el : null;
    }

    /**
     * Brief on-screen confirmation after a skip seek is applied.
     */
    private static showSkipToast(): void {
        let root = document.getElementById(SKIP_TOAST_ID);
        if (!root) {
            root = document.createElement('div');
            root.id = SKIP_TOAST_ID;
            root.style.cssText = [
                'position:fixed',
                `bottom:${SKIP_TOAST_BOTTOM_PX}px`,
                'left:50%',
                'transform:translateX(-50%)',
                `z-index:${SKIP_TOAST_Z_INDEX}`,
                'background:rgba(15,23,42,0.92)',
                'color:#fff',
                'padding:0.625rem 1rem',
                'border-radius:0.5rem',
                'border:1px solid rgba(255,255,255,0.12)',
                'box-shadow:0 14px 30px rgba(15,23,42,0.35)',
                'font:0.8125rem/1.4 system-ui,' +
                    '-apple-system,"Segoe UI",Roboto,' +
                    'Helvetica,Arial,sans-serif',
                'pointer-events:none',
                `transition:opacity ${SKIP_TOAST_FADE_MS}ms ease-out`,
            ].join(';');
            document.documentElement.appendChild(root);
        }
        root.textContent = translator.getMessage('content_skip_applied');
        root.style.opacity = '1';

        const prefersReducedMotion = window.matchMedia(
            '(prefers-reduced-motion: reduce)',
        ).matches;

        window.setTimeout(() => {
            if (prefersReducedMotion) {
                root.style.opacity = '0';
                root.remove();
            } else {
                root.style.opacity = '0';
                window.setTimeout(() => {
                    root.remove();
                }, SKIP_TOAST_FADE_MS);
            }
        }, SKIP_TOAST_DISPLAY_MS);
    }

    /**
     * Seeks the video after a promo-block skip decision.
     *
     * @param video Active watch player element.
     * @param targetTime Seek target in seconds
     */
    private static applyPromoSeek(
        video: HTMLVideoElement,
        targetTime: number,
    ): void {
        video.currentTime = targetTime;
        YoutubeWatch.lastTime = targetTime;
        YoutubeWatch.showSkipToast();
    }

    /**
     * `timeupdate` handler: evaluates skip logic and updates `lastTime` / seek
     * state.
     *
     * @param video Active watch player element.
     */
    private static onTimeUpdate(video: HTMLVideoElement): void {
        if (
            YoutubeWatch.prefs?.enabled === false ||
            YoutubeWatch.isLikelyAdPlaying()
        ) {
            YoutubeWatch.lastTime = video.currentTime;
            return;
        }

        const duration = video.duration;
        if (
            !Number.isFinite(duration) ||
            duration === Number.POSITIVE_INFINITY
        ) {
            YoutubeWatch.lastTime = video.currentTime;
            return;
        }

        const currentTime = video.currentTime;
        const prev = YoutubeWatch.lastTime;

        if (YoutubeWatch.promoBlocks.length > 0) {
            // Log significant jumps that didn't come through
            // seeking/seeked (video element swap or MSE).
            const delta = currentTime - prev;
            if (Math.abs(delta) > 2) {
                contentLog.info(
                    'timeupdate jump',
                    prev.toFixed(2),
                    '→',
                    currentTime.toFixed(2),
                    'seeking=',
                    YoutubeWatch.isSeeking,
                );
            }

            resetFiredIndicesOnBackwardSeek({
                currentTime,
                prevTime: prev,
                blocks: YoutubeWatch.promoBlocks,
                firedStartKeys: YoutubeWatch.firedPromoBlockStartKeys,
            });

            const decision = evaluatePromoBlocksSkip({
                prevTime: prev,
                currentTime,
                duration,
                isSeeking: YoutubeWatch.isSeeking,
                firedStartKeys: YoutubeWatch.firedPromoBlockStartKeys,
                blocks: YoutubeWatch.promoBlocks,
            });
            if (decision.action === 'skip') {
                contentLog.info(
                    'SKIP block',
                    decision.blockIndex,
                    'at',
                    currentTime.toFixed(2),
                    '→',
                    decision.targetTime.toFixed(2),
                    'prev=',
                    prev.toFixed(2),
                    'fired=',
                    JSON.stringify([...YoutubeWatch.firedPromoBlockStartKeys]),
                );
                const blk = YoutubeWatch.promoBlocks[decision.blockIndex];
                if (blk !== undefined) {
                    YoutubeWatch.firedPromoBlockStartKeys.add(
                        promoBlockStartKey(blk.startSec),
                    );
                }
                YoutubeWatch.applyPromoSeek(video, decision.targetTime);
            } else {
                YoutubeWatch.lastTime = currentTime;
            }
            return;
        }

        YoutubeWatch.lastTime = currentTime;
    }

    /**
     * Attaches listeners to the active video and tracks seek vs playback.
     *
     * @param video Active element.
     */
    private static bindVideo(video: HTMLVideoElement): void {
        if (YoutubeWatch.boundVideo === video) {
            return;
        }
        YoutubeWatch.unbindVideo();
        YoutubeWatch.boundVideo = video;
        YoutubeWatch.isSeeking = false;
        YoutubeWatch.lastTime = video.currentTime;

        const onSeeking = (): void => {
            YoutubeWatch.isSeeking = true;
            if (YoutubeWatch.promoBlocks.length > 0) {
                contentLog.info(
                    'seeking started at',
                    video.currentTime.toFixed(2),
                    'lastTime=',
                    YoutubeWatch.lastTime.toFixed(2),
                );
            }
        };
        const onSeeked = (): void => {
            YoutubeWatch.isSeeking = false;
            if (
                YoutubeWatch.promoBlocks.length > 0 &&
                video.currentTime < YoutubeWatch.lastTime
            ) {
                contentLog.info(
                    'backward seeked:',
                    YoutubeWatch.lastTime.toFixed(2),
                    '→',
                    video.currentTime.toFixed(2),
                    'fired=',
                    JSON.stringify([...YoutubeWatch.firedPromoBlockStartKeys]),
                );
                resetFiredIndicesOnBackwardSeek({
                    currentTime: video.currentTime,
                    prevTime: YoutubeWatch.lastTime,
                    blocks: YoutubeWatch.promoBlocks,
                    firedStartKeys: YoutubeWatch.firedPromoBlockStartKeys,
                });
                contentLog.info(
                    'after reset fired=',
                    JSON.stringify([...YoutubeWatch.firedPromoBlockStartKeys]),
                );
            } else if (YoutubeWatch.promoBlocks.length > 0) {
                contentLog.info(
                    'forward seeked:',
                    YoutubeWatch.lastTime.toFixed(2),
                    '→',
                    video.currentTime.toFixed(2),
                );
            }
            YoutubeWatch.lastTime = video.currentTime;
        };
        const onTu = (): void => {
            YoutubeWatch.onTimeUpdate(video);
        };

        video.addEventListener('seeking', onSeeking);
        video.addEventListener('seeked', onSeeked);
        video.addEventListener('timeupdate', onTu);

        videoCleanup.set(video, () => {
            video.removeEventListener('seeking', onSeeking);
            video.removeEventListener('seeked', onSeeked);
            video.removeEventListener('timeupdate', onTu);
        });
    }

    /**
     * Removes listeners from the previously bound video, if any.
     */
    private static unbindVideo(): void {
        if (!YoutubeWatch.boundVideo) {
            return;
        }
        videoCleanup.get(YoutubeWatch.boundVideo)?.();
        videoCleanup.delete(YoutubeWatch.boundVideo);
        YoutubeWatch.boundVideo = null;
    }

    /**
     * Clears binding when the watch URL’s video id changes (SPA navigation).
     *
     * @param videoId New id or null.
     */
    private static resetForNewVideo(videoId: string | null): void {
        YoutubeWatch.unbindVideo();
        YoutubeWatch.cancelServerAnalysisSession('navigation');
        YoutubeWatch.currentVideoId = videoId;
        YoutubeWatch.analysisModeForCurrentVideo = null;
        YoutubeWatch.byokPreflightVideoId = null;
        YoutubeWatch.serverAnalysisRouteLogKey = null;
        YoutubeWatch.captionScheduledVideoId = null;
        YoutubeWatch.lastTime = 0;
        YoutubeWatch.promoBlocks = [];
        YoutubeWatch.firedPromoBlockStartKeys.clear();
    }

    /**
     * Stops the pending server-job polling loop for this watch page.
     *
     * @param reason - Stable reason included when an active poll is stopped.
     */
    private static clearServerAnalysisPolling(reason = 'cleared'): void {
        const pollPayload =
            YoutubeWatch.serverAnalysisSession?.getPollPayload() ?? null;
        if (
            YoutubeWatch.serverAnalysisPollTimerId !== null ||
            pollPayload !== null
        ) {
            ContentServerAnalysisLog.info('polling-stopped', {
                videoId: pollPayload?.videoId,
                jobId: pollPayload?.jobId,
                reason,
            });
        }
        if (YoutubeWatch.serverAnalysisPollTimerId !== null) {
            window.clearTimeout(YoutubeWatch.serverAnalysisPollTimerId);
        }
        YoutubeWatch.serverAnalysisPollTimerId = null;
    }

    /**
     * Cancels the complete Server route so late same-video work cannot be applied.
     *
     * @param reason - Stable route invalidation reason for development logs.
     */
    private static cancelServerAnalysisSession(reason: string): void {
        YoutubeWatch.clearServerAnalysisPolling(reason);
        const session = YoutubeWatch.serverAnalysisSession;
        if (session !== null) {
            session.cancel();
            void YoutubeWatch.sendServerAnalysisSessionEvent(
                session,
                'cancelled',
            );
        }
        YoutubeWatch.serverAnalysisSession = null;
    }

    /**
     * Narrows runtime acks from background server-analysis handlers.
     *
     * @param response - Untyped `runtime.sendMessage` response.
     * @returns Whether the response has the supported ack shape.
     */
    private static isServerAnalysisResponse(
        response: unknown,
    ): response is RequestServerAnalysisResponse {
        return v.safeParse(requestServerAnalysisResponseSchema, response)
            .success;
    }

    /**
     * Schedules the next status refresh while the current video stays active.
     *
     * @param input - Polling job id, video id, and server interval.
     */
    private static scheduleServerAnalysisStatusRefresh(input: {
        session: ServerAnalysisSession;
        pollAfterSec: number;
    }): void {
        const pollPayload = input.session.getPollPayload();
        if (
            pollPayload === null ||
            input.session !== YoutubeWatch.serverAnalysisSession
        ) {
            return;
        }
        if (YoutubeWatch.serverAnalysisPollTimerId !== null) {
            window.clearTimeout(YoutubeWatch.serverAnalysisPollTimerId);
        }
        ContentServerAnalysisLog.info('polling-scheduled', {
            videoId: pollPayload.videoId,
            jobId: pollPayload.jobId,
            pollAfterSec: input.pollAfterSec,
        });
        YoutubeWatch.serverAnalysisPollTimerId = window.setTimeout(() => {
            void YoutubeWatch.refreshServerAnalysisStatus();
        }, input.pollAfterSec * MS_PER_SECOND);
    }

    /**
     * Sends a status refresh only when the page still owns the same job/video.
     *
     * @returns Promise resolved after the refresh response is handled.
     */
    private static async refreshServerAnalysisStatus(): Promise<void> {
        const session = YoutubeWatch.serverAnalysisSession;
        const pollPayload = session?.getPollPayload() ?? null;
        YoutubeWatch.serverAnalysisPollTimerId = null;

        if (
            session === null ||
            pollPayload === null ||
            pollPayload.videoId !== YoutubeWatch.currentVideoId ||
            YoutubeWatch.analysisModeForCurrentVideo !== ANALYSIS_MODE.Server ||
            YoutubeWatch.prefs === null ||
            !shouldUseServerAnalysis(YoutubeWatch.prefs)
        ) {
            YoutubeWatch.cancelServerAnalysisSession('route-inactive');
            return;
        }

        try {
            ContentServerAnalysisLog.info('poll-request-sent', {
                videoId: pollPayload.videoId,
                jobId: pollPayload.jobId,
            });
            const response = await browser.runtime.sendMessage(
                buildRefreshServerAnalysisStatusMessage(pollPayload),
            );
            await YoutubeWatch.handleServerAnalysisResponse(response, session);
        } catch {
            ContentServerAnalysisLog.warn('poll-request-failed', {
                videoId: pollPayload.videoId,
                jobId: pollPayload.jobId,
            });
            YoutubeWatch.cancelServerAnalysisSession('runtime-error');
        }
    }

    /**
     * Applies background acks to the content-owned polling lifecycle.
     *
     * @param response - Untyped ack from the background.
     * @param session - Active content-owned session that produced the request.
     * @returns Promise resolved after polling or terminal state is updated.
     */
    private static async handleServerAnalysisResponse(
        response: unknown,
        session: ServerAnalysisSession,
    ): Promise<void> {
        const retained = session.getRetainedRequest();
        const videoId = retained?.videoId ?? session.getPollPayload()?.videoId;
        if (
            session !== YoutubeWatch.serverAnalysisSession ||
            videoId === undefined ||
            videoId !== YoutubeWatch.currentVideoId ||
            YoutubeWatch.analysisModeForCurrentVideo !== ANALYSIS_MODE.Server ||
            YoutubeWatch.prefs === null ||
            !shouldUseServerAnalysis(YoutubeWatch.prefs)
        ) {
            if (session === YoutubeWatch.serverAnalysisSession) {
                YoutubeWatch.cancelServerAnalysisSession('stale-response');
            }
            return;
        }
        if (!YoutubeWatch.isServerAnalysisResponse(response)) {
            ContentServerAnalysisLog.warn('runtime-ack-invalid', { videoId });
            YoutubeWatch.cancelServerAnalysisSession('invalid-ack');
            return;
        }

        ContentServerAnalysisLog.info('runtime-ack', {
            videoId,
            status: response.ok ? response.status : 'failed',
            jobId:
                response.ok && response.status === 'processing'
                    ? response.jobId
                    : undefined,
        });

        if (!response.ok) {
            YoutubeWatch.clearServerAnalysisPolling('background-error');
            session.complete();
            return;
        }

        if (response.status === 'processing') {
            const pollPayload = session.pinProcessing(
                response.jobId,
                response.identity,
            );
            if (pollPayload === null) {
                YoutubeWatch.cancelServerAnalysisSession(
                    'processing-identity-mismatch',
                );
                return;
            }
            YoutubeWatch.scheduleServerAnalysisStatusRefresh({
                session,
                pollAfterSec: response.pollAfterSec,
            });
            return;
        }

        if (response.status === 'resubmit_required') {
            const request = session.takeExactResubmission();
            if (request === null) {
                YoutubeWatch.cancelServerAnalysisSession(
                    'resubmit-payload-missing',
                );
                YoutubeWatch.syncVideoBinding();
                return;
            }
            YoutubeWatch.clearServerAnalysisPolling('resubmit');
            try {
                const retried = await browser.runtime.sendMessage(
                    buildRequestServerAnalysisMessage(request),
                );
                await YoutubeWatch.handleServerAnalysisResponse(
                    retried,
                    session,
                );
            } catch {
                YoutubeWatch.cancelServerAnalysisSession(
                    'resubmit-runtime-error',
                );
            }
            return;
        }

        YoutubeWatch.clearServerAnalysisPolling('terminal-response');
        if (response.status === 'inactive') {
            YoutubeWatch.cancelServerAnalysisSession('inactive');
            return;
        }
        session.complete();
    }

    /**
     * Sends one caption-independent provider readiness probe for a BYOK video.
     *
     * @param videoId - Video assigned to the locked BYOK route.
     */
    private static requestByokSetupPreflight(videoId: string): void {
        if (
            !shouldRequestByokSetupPreflight(
                YoutubeWatch.analysisModeForCurrentVideo,
                videoId,
                YoutubeWatch.byokPreflightVideoId,
            )
        ) {
            return;
        }
        YoutubeWatch.byokPreflightVideoId = videoId;
        void browser.runtime
            .sendMessage({
                type: TOPSKIP_MESSAGE.PREFLIGHT_BYOK_SETUP,
                payload: { videoId },
            })
            .catch(() => {
                // The background owns setup status; caption capture remains independent.
            });
    }

    /**
     * Sends a local phase event without giving content access to backend HTTP.
     *
     * @param session - Active route session.
     * @param event - Safe local acquisition outcome.
     * @returns Promise resolved after best-effort background delivery.
     */
    private static async sendServerAnalysisSessionEvent(
        session: ServerAnalysisSession,
        event: ServerAnalysisSessionEventPayload['event'],
    ): Promise<void> {
        try {
            await browser.runtime.sendMessage({
                type: TOPSKIP_MESSAGE.SERVER_ANALYSIS_SESSION_EVENT,
                payload: {
                    event,
                    sessionId: session.sessionId,
                    videoId: session.getVideoId(),
                },
            });
        } catch {
            // Background state is advisory; route cancellation remains content-owned.
        }
    }

    /**
     * Captures captions before the first Server request and retains them for recovery.
     *
     * @param session - Active cancellable route session.
     * @param video - Bound player used only for an optional duration hint.
     * @param videoId - Watch video owned by the session.
     * @returns Promise resolved after the request or local terminal outcome.
     */
    private static async captureAndRequestServerAnalysis(
        session: ServerAnalysisSession,
        video: HTMLVideoElement,
        videoId: string,
    ): Promise<void> {
        await YoutubeWatch.sendServerAnalysisSessionEvent(
            session,
            'acquisition_started',
        );
        WatchCaptions.installPageBridge();
        const capture = await WatchCaptions.capture({
            videoId,
            signal: session.signal,
        });
        if (
            session !== YoutubeWatch.serverAnalysisSession ||
            session.signal.aborted ||
            capture.status === 'cancelled'
        ) {
            return;
        }
        if (capture.status === 'failed') {
            const event =
                capture.failure.reason ===
                CAPTION_CAPTURE_FAILURE_REASON.CaptionsUnavailable
                    ? 'captions_unavailable'
                    : 'caption_extraction_failed';
            await YoutubeWatch.sendServerAnalysisSessionEvent(session, event);
            session.complete();
            return;
        }

        const retained = session.acceptCaptions(
            capture.payload,
            video.duration,
        );
        if (retained === null) {
            await YoutubeWatch.sendServerAnalysisSessionEvent(
                session,
                'caption_extraction_failed',
            );
            session.complete();
            return;
        }

        ContentServerAnalysisLog.info('runtime-request-sent', {
            videoId,
            durationSec: retained.durationSec,
        });
        try {
            const response = await browser.runtime.sendMessage(
                buildRequestServerAnalysisMessage(retained),
            );
            await YoutubeWatch.handleServerAnalysisResponse(response, session);
        } catch {
            ContentServerAnalysisLog.warn('runtime-request-failed', {
                videoId,
            });
            YoutubeWatch.cancelServerAnalysisSession('runtime-error');
        }
    }

    /**
     * Starts one capture-owned Server session without waiting for playback or duration.
     *
     * @param video - Active watch player element.
     * @param videoId - Current watch video id.
     * @returns Deduplicated route outcome for development diagnostics.
     */
    private static requestServerAnalysis(
        video: HTMLVideoElement,
        videoId: string,
    ): 'already-requested' | 'server-request' {
        if (YoutubeWatch.serverAnalysisSession !== null) {
            return 'already-requested';
        }

        const session = ServerAnalysisSession.create(videoId);
        YoutubeWatch.serverAnalysisSession = session;
        void YoutubeWatch.captureAndRequestServerAnalysis(
            session,
            video,
            videoId,
        );
        return 'server-request';
    }

    /**
     * Emits route state only when a meaningful watch prerequisite changes.
     *
     * @param input - Current video identity, prerequisite state, and outcome.
     */
    private static logServerAnalysisRoute(input: {
        videoId: string | null;
        outcome: string;
        hasVideo: boolean;
        enabled?: boolean;
        analysisMode?: AnalysisMode;
    }): void {
        const key = [
            input.videoId ?? 'none',
            input.outcome,
            String(input.hasVideo),
            String(input.enabled),
            input.analysisMode ?? 'unknown',
        ].join('|');
        if (key === YoutubeWatch.serverAnalysisRouteLogKey) {
            return;
        }
        YoutubeWatch.serverAnalysisRouteLogKey = key;
        ContentServerAnalysisLog.info('route-decision', input);
    }

    /**
     * Re-binds or unbinds the video element after navigation or DOM changes.
     */
    private static syncVideoBinding(): void {
        if (!YoutubeWatch.shouldActivateForPage()) {
            YoutubeWatch.logServerAnalysisRoute({
                videoId: null,
                outcome: 'page-inactive',
                hasVideo: false,
            });
            if (YoutubeWatch.currentVideoId !== null) {
                YoutubeWatch.resetForNewVideo(null);
            }
            return;
        }

        const vid = YoutubeWatch.getWatchVideoId();
        const video = YoutubeWatch.getMainVideo();
        const isNewVideo = vid !== YoutubeWatch.currentVideoId;

        if (isNewVideo) {
            YoutubeWatch.resetForNewVideo(vid);
        }

        if (!video) {
            YoutubeWatch.logServerAnalysisRoute({
                videoId: vid,
                outcome: 'waiting-for-video',
                hasVideo: false,
            });
            return;
        }

        const isVideoElementSwap =
            !isNewVideo && YoutubeWatch.boundVideo !== video;
        YoutubeWatch.bindVideo(video);

        const prefs = YoutubeWatch.prefs;
        if (prefs === null) {
            YoutubeWatch.logServerAnalysisRoute({
                videoId: vid,
                outcome: 'waiting-for-prefs',
                hasVideo: true,
            });
            return;
        }

        YoutubeWatch.analysisModeForCurrentVideo =
            resolveAnalysisModeForCurrentVideo(
                YoutubeWatch.analysisModeForCurrentVideo,
                prefs,
            );
        const analysisMode = YoutubeWatch.analysisModeForCurrentVideo;
        if (analysisMode === null) {
            YoutubeWatch.logServerAnalysisRoute({
                videoId: vid,
                outcome: 'disabled',
                hasVideo: true,
                enabled: prefs.enabled,
                analysisMode: prefs.analysisMode,
            });
            YoutubeWatch.cancelServerAnalysisSession('disabled');
            return;
        }

        if (analysisMode === ANALYSIS_MODE.Server) {
            if (vid !== null && shouldUseServerAnalysis(prefs)) {
                const outcome = YoutubeWatch.requestServerAnalysis(video, vid);
                YoutubeWatch.logServerAnalysisRoute({
                    videoId: vid,
                    outcome,
                    hasVideo: true,
                    enabled: prefs.enabled,
                    analysisMode,
                });
            } else {
                YoutubeWatch.logServerAnalysisRoute({
                    videoId: vid,
                    outcome: 'server-inactive',
                    hasVideo: true,
                    enabled: prefs.enabled,
                    analysisMode,
                });
            }
            return;
        }

        YoutubeWatch.logServerAnalysisRoute({
            videoId: vid,
            outcome: 'byok',
            hasVideo: true,
            enabled: prefs.enabled,
            analysisMode,
        });

        if (vid !== null) {
            YoutubeWatch.requestByokSetupPreflight(vid);
        }
        WatchCaptions.installPageBridge();
        if (vid !== null && YoutubeWatch.captionScheduledVideoId !== vid) {
            YoutubeWatch.captionScheduledVideoId = vid;
            WatchCaptions.scheduleForVideoId(vid, 'video-id-change');
            return;
        }

        if (isVideoElementSwap) {
            contentLog.info('video element swap detected, rebinding');
            WatchCaptions.scheduleForVideoId(vid, 'video-element-ready');
        }
    }

    /**
     * Initial preferences from the background (GET_PREFS).
     */
    private static loadPrefsFromBackground(): void {
        void browser.runtime
            .sendMessage({ type: TOPSKIP_MESSAGE.GET_PREFS })
            .then((res: unknown) => {
                if (
                    res &&
                    typeof res === 'object' &&
                    'ok' in res &&
                    (res as { ok: boolean }).ok &&
                    'prefs' in res
                ) {
                    const prefs = (res as { prefs: UserPreferences }).prefs;
                    YoutubeWatch.prefs = prefs;
                    ContentServerAnalysisLog.info('prefs-loaded', {
                        enabled: prefs.enabled,
                        analysisMode: prefs.analysisMode,
                    });
                    YoutubeWatch.syncVideoBinding();
                }
            })
            .catch(() => {
                // keep routing idle until preferences are available
            });
    }

    /**
     * Updates `enabled` when the background broadcasts PREFS_UPDATED.
     *
     * @param message Runtime message payload.
     */
    /**
     * Applies promo blocks delivered from the background for the active video.
     *
     * @param message Runtime message payload
     */
    private static onPromoBlocksMessage(message: unknown): void {
        const m = pickMessage(TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED, message);
        if (!m) {
            return;
        }
        const { videoId, promoBlocks } = m;
        if (
            !shouldAcceptPromoBlocksForActiveRoute({
                currentVideoId: YoutubeWatch.currentVideoId,
                messageVideoId: videoId,
                source: m.source,
                activeSessionId:
                    YoutubeWatch.serverAnalysisSession?.sessionId ?? null,
                ...('sessionId' in m ? { messageSessionId: m.sessionId } : {}),
            })
        ) {
            contentLog.warn('PROMO_BLOCKS_DETECTED: videoId mismatch', {
                msg: videoId,
                current: YoutubeWatch.currentVideoId,
            });
            return;
        }
        contentLog.info(
            'blocks received',
            promoBlocks.length,
            'blocks for',
            videoId,
            JSON.stringify(promoBlocks),
        );
        YoutubeWatch.promoBlocks = promoBlocks;
        YoutubeWatch.firedPromoBlockStartKeys.clear();
    }

    /**
     * Updates `enabled` when the background broadcasts PREFS_UPDATED.
     *
     * @param message Runtime message payload.
     */
    private static onPrefsUpdatedMessage(message: unknown): void {
        const m = pickMessage(TOPSKIP_MESSAGE.PREFS_UPDATED, message);
        if (!m) {
            return;
        }
        const previousMode = YoutubeWatch.prefs?.analysisMode;
        YoutubeWatch.prefs = m.prefs;
        if (!shouldUseServerAnalysis(m.prefs)) {
            YoutubeWatch.cancelServerAnalysisSession('prefs-changed');
        }
        if (
            previousMode !== undefined &&
            previousMode !== m.prefs.analysisMode
        ) {
            YoutubeWatch.analysisModeForCurrentVideo = null;
            YoutubeWatch.byokPreflightVideoId = null;
            YoutubeWatch.captionScheduledVideoId = null;
        }
        YoutubeWatch.syncVideoBinding();
    }

    /**
     * Wires SPA hooks, video binding, and runtime messaging for prefs.
     */
    static init(): void {
        ContentServerAnalysisLog.info('content-initialized', {
            videoId: YoutubeWatch.getWatchVideoId(),
        });
        YoutubeWatch.loadPrefsFromBackground();
        browser.runtime.onMessage.addListener((message: unknown) => {
            YoutubeWatch.onPrefsUpdatedMessage(message);
            YoutubeWatch.onPromoBlocksMessage(message);
        });

        YoutubeWatch.syncVideoBinding();

        const onNav = (): void => {
            YoutubeWatch.syncVideoBinding();
        };

        window.addEventListener('popstate', onNav);
        window.addEventListener('yt-navigate-finish', onNav);

        setInterval(() => {
            YoutubeWatch.syncVideoBinding();
        }, VIDEO_BINDING_POLL_INTERVAL_MS);
    }
}
