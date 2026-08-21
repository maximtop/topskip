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
import {
    SERVER_ANALYSIS_OPERATION_KIND,
    SERVER_ANALYSIS_RUNTIME_MESSAGE_TIMEOUT_MS,
    ServerAnalysisSession,
    type ServerAnalysisInterruptionReason,
    type ServerAnalysisPendingOperation,
    type ServerAnalysisTerminalEvent,
} from '@/content/server-analysis-session';
import { contentLog } from '@/content/content-log';
import { ContentServerAnalysisLog } from '@/content/server-analysis-log';
import { WatchCaptions } from '@/content/watch-captions';
import browser from '@/shared/browser';
import { getExtensionBuildLabel } from '@/shared/extension-build';
import { formatLogFields } from '@/shared/log-fields';
import {
    ANALYSIS_MODE,
    MS_PER_SECOND,
    userPreferencesSchema,
    type AnalysisMode,
    type UserPreferences,
} from '@/shared/constants';
import {
    CAPTION_CAPTURE_FAILURE_REASON,
    CONTENT_SCRIPT_PROTOCOL_VERSION,
    PROMO_DETECTION_SOURCE,
    pickMessage,
    requestServerAnalysisResponseSchema,
    SERVER_ANALYSIS_INTERRUPTION_REASON,
    SERVER_ANALYSIS_SESSION_EVENT,
    TOPSKIP_MESSAGE,
    type RequestServerAnalysisResponse,
    type ContentRouteStatusResponse,
    type ContentScriptReadyResponse,
    type PromoDetectionSource,
    type ServerAnalysisSessionEventPayload,
    type TopSkipRuntimeMessage,
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
 * A lightweight preferences read should not outlive a suspended MV3 worker.
 */
export const CONTENT_PREFS_REQUEST_TIMEOUT_MS = 2 * MS_PER_SECOND;

/**
 * A short delay avoids a tight wake-up loop while a replacement worker starts.
 */
export const CONTENT_PREFS_RETRY_DELAY_MS = 2 * MS_PER_SECOND;

/**
 * Runtime transport diagnostics are shared by analysis, terminal, and prefs flows.
 */
const CONTENT_RUNTIME_FAILURE_REASON = {
    InvalidResponse: 'invalid-response',
    InvalidAck: 'invalid-ack',
    RuntimeRejected: 'runtime-rejected',
    WatchdogTimeout: 'watchdog-timeout',
} as const;

/**
 * Internal delivery outcomes keep transport state separate from analysis state.
 */
const CONTENT_RUNTIME_OUTCOME_STATUS = {
    Response: 'response',
    Acknowledged: 'acknowledged',
    Failed: 'failed',
    Cancelled: 'cancelled',
} as const;
const SERVER_ANALYSIS_DEADLINE_TIMER_REASON = 'analysis-deadline';
const SERVER_ANALYSIS_FAILED_ACK_LOG_STATUS = 'failed';

/**
 * Stable capture-owner reasons keep route cleanup diagnostics comparable.
 */
const WATCH_CAPTION_CANCEL_REASON = {
    AnalysisModeChanged: 'analysis-mode-changed',
    Disabled: 'disabled',
    Navigation: 'navigation',
} as const;

/**
 * Safe retry reasons keep diagnostics free of rejected runtime details.
 */
type ContentPrefsRetryReason =
    | typeof CONTENT_RUNTIME_FAILURE_REASON.InvalidResponse
    | typeof CONTENT_RUNTIME_FAILURE_REASON.RuntimeRejected
    | typeof CONTENT_RUNTIME_FAILURE_REASON.WatchdogTimeout;

/**
 * Runtime outcomes separate an acknowledged response from worker transport loss.
 */
type ServerAnalysisRuntimeOutcome =
    | {
          status: typeof CONTENT_RUNTIME_OUTCOME_STATUS.Response;
          response: unknown;
      }
    | {
          status: typeof CONTENT_RUNTIME_OUTCOME_STATUS.Failed;
          reason:
              | typeof CONTENT_RUNTIME_FAILURE_REASON.RuntimeRejected
              | typeof CONTENT_RUNTIME_FAILURE_REASON.WatchdogTimeout;
      }
    | { status: typeof CONTENT_RUNTIME_OUTCOME_STATUS.Cancelled };

/**
 * Terminal-event outcomes distinguish a durable ack from safe retry causes.
 */
type ServerAnalysisTerminalEventDeliveryOutcome =
    | { status: typeof CONTENT_RUNTIME_OUTCOME_STATUS.Acknowledged }
    | {
          status: typeof CONTENT_RUNTIME_OUTCOME_STATUS.Failed;
          reason:
              | typeof CONTENT_RUNTIME_FAILURE_REASON.InvalidAck
              | typeof CONTENT_RUNTIME_FAILURE_REASON.RuntimeRejected
              | typeof CONTENT_RUNTIME_FAILURE_REASON.WatchdogTimeout;
      }
    | { status: typeof CONTENT_RUNTIME_OUTCOME_STATUS.Cancelled };

/**
 * A single token prevents an old session with the same local operation number
 * from releasing ownership held by its replacement.
 */
type ServerAnalysisOperationOwner = {
    session: ServerAnalysisSession;
    operationId: number;
};

/**
 * Attempt ownership prevents late terminal-event completions crossing routes.
 */
type ServerAnalysisTerminalEventDeliveryOwner = {
    session: ServerAnalysisSession;
    attemptId: number;
};

/**
 * Retry timer ownership prevents an old route from clearing replacement work.
 */
type ServerAnalysisTerminalEventRetryTimer = {
    session: ServerAnalysisSession;
    timerId: number;
};

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
    source: PromoDetectionSource;
    enabled: boolean;
    analysisMode: AnalysisMode | null;
    activeSessionId: string | null;
    messageSessionId?: string;
}): boolean {
    if (!input.enabled || input.messageVideoId !== input.currentVideoId) {
        return false;
    }
    if (input.source === PROMO_DETECTION_SOURCE.LocalProvider) {
        return input.analysisMode === ANALYSIS_MODE.Byok;
    }
    return (
        input.analysisMode === ANALYSIS_MODE.Server &&
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
     * A request generation lets timed-out replies lose to newer state.
     */
    private static prefsRequestSequence = 0;
    /**
     * Only one logical preferences read may own response application.
     */
    private static activePrefsRequestId: number | null = null;
    /**
     * Timer bounding the currently owned preferences read.
     */
    private static prefsRequestTimeoutTimerId: number | null = null;
    /**
     * Timer delaying the next preferences read after a bounded failure.
     */
    private static prefsRetryTimerId: number | null = null;
    /**
     * Disposed contexts reject every late timer and runtime completion.
     */
    private static prefsLoadingActive = false;
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
     * Runtime recovery waits independently of the backend-requested poll cadence.
     */
    private static serverAnalysisRetryTimerId: number | null = null;
    /**
     * Fixed session deadline remains active across every transport retry.
     */
    private static serverAnalysisDeadlineTimerId: number | null = null;
    /**
     * One owner token prevents concurrent work and cross-session ABA release.
     */
    private static serverAnalysisOperationOwner: ServerAnalysisOperationOwner | null =
        null;

    /**
     * Deadline expiry waits for an in-flight operation before taking the final poll.
     */
    private static serverAnalysisFinalPollPending = false;
    /**
     * Independent terminal-event delivery survives the analysis terminal signal.
     */
    private static terminalEventDeliveryOwner: ServerAnalysisTerminalEventDeliveryOwner | null =
        null;

    /**
     * Monotonic attempt ids reject late completions from timed-out deliveries.
     */
    private static terminalEventDeliveryAttemptSequence = 0;
    /**
     * A retry timer remains tied to the terminal session that scheduled it.
     */
    private static terminalEventRetryTimer: ServerAnalysisTerminalEventRetryTimer | null =
        null;

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
     * Reports route ownership from live content state without exposing tab URL.
     *
     * A just-completed SPA navigation invalidates the old lock immediately,
     * even when the binding poll has not yet finished its normal cleanup.
     *
     * @returns Versioned identity used by background delayed-result guards.
     */
    private static getContentRouteStatus(): ContentRouteStatusResponse {
        const videoId = YoutubeWatch.shouldActivateForPage()
            ? YoutubeWatch.getWatchVideoId()
            : null;
        const routeIsSynchronized = videoId === YoutubeWatch.currentVideoId;
        return {
            ok: true,
            protocolVersion: CONTENT_SCRIPT_PROTOCOL_VERSION,
            extensionVersion: browser.runtime.getManifest().version,
            videoId,
            enabled: YoutubeWatch.prefs?.enabled ?? false,
            analysisMode: routeIsSynchronized
                ? YoutubeWatch.analysisModeForCurrentVideo
                : null,
            serverSessionId: routeIsSynchronized
                ? YoutubeWatch.serverAnalysisSession?.sessionId ?? null
                : null,
        };
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
            YoutubeWatch.prefs?.enabled !== true ||
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
        if (
            YoutubeWatch.analysisModeForCurrentVideo !== null ||
            YoutubeWatch.captionScheduledVideoId !== null
        ) {
            WatchCaptions.cancel(WATCH_CAPTION_CANCEL_REASON.Navigation);
        }
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
     * Returns a disabled static context to a passive document observer without
     * issuing cleanup commands when the route never acquired capture ownership.
     */
    private static deactivateDisabledRoute(): void {
        const hadCaptionRouteOwnership =
            YoutubeWatch.analysisModeForCurrentVideo !== null ||
            YoutubeWatch.serverAnalysisSession !== null ||
            YoutubeWatch.captionScheduledVideoId !== null;

        YoutubeWatch.cancelServerAnalysisSession(
            WATCH_CAPTION_CANCEL_REASON.Disabled,
        );
        if (hadCaptionRouteOwnership) {
            WatchCaptions.cancel(WATCH_CAPTION_CANCEL_REASON.Disabled);
        }
        YoutubeWatch.unbindVideo();
        YoutubeWatch.analysisModeForCurrentVideo = null;
        YoutubeWatch.byokPreflightVideoId = null;
        YoutubeWatch.captionScheduledVideoId = null;
        YoutubeWatch.lastTime = 0;
        YoutubeWatch.isSeeking = false;
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
     * Stops a pending runtime retry without disturbing normal poll scheduling.
     *
     * @param reason - Safe route reason used only in development logs.
     */
    private static clearServerAnalysisRetry(reason: string): void {
        if (YoutubeWatch.serverAnalysisRetryTimerId === null) {
            return;
        }
        window.clearTimeout(YoutubeWatch.serverAnalysisRetryTimerId);
        YoutubeWatch.serverAnalysisRetryTimerId = null;
        ContentServerAnalysisLog.info('runtime-retry-stopped', {
            videoId: YoutubeWatch.serverAnalysisSession?.getVideoId(),
            reason,
        });
    }

    /**
     * Stops the fixed wall-clock deadline after a terminal or cancelled route.
     */
    private static clearServerAnalysisDeadline(): void {
        if (YoutubeWatch.serverAnalysisDeadlineTimerId !== null) {
            window.clearTimeout(YoutubeWatch.serverAnalysisDeadlineTimerId);
        }
        YoutubeWatch.serverAnalysisDeadlineTimerId = null;
        YoutubeWatch.serverAnalysisFinalPollPending = false;
    }

    /**
     * Clears every content-owned timer associated with the active Server route.
     *
     * @param reason - Safe route reason used by timer diagnostics.
     * @param session - Route whose operation ownership may be released.
     */
    private static clearServerAnalysisTimers(
        reason: string,
        session: ServerAnalysisSession | null,
    ): void {
        YoutubeWatch.clearServerAnalysisPolling(reason);
        YoutubeWatch.clearServerAnalysisRetry(reason);
        YoutubeWatch.clearServerAnalysisDeadline();
        if (
            session === null ||
            YoutubeWatch.serverAnalysisOperationOwner?.session === session
        ) {
            YoutubeWatch.serverAnalysisOperationOwner = null;
        }
    }

    /**
     * Clears only terminal-event transport owned by the invalidated route.
     *
     * @param reason - Safe lifecycle reason for diagnostics.
     * @param session - Route whose delivery work may be released.
     */
    private static clearTerminalEventDelivery(
        reason: string,
        session: ServerAnalysisSession | null,
    ): void {
        const retry = YoutubeWatch.terminalEventRetryTimer;
        if (retry !== null && (session === null || retry.session === session)) {
            window.clearTimeout(retry.timerId);
            YoutubeWatch.terminalEventRetryTimer = null;
            ContentServerAnalysisLog.info('terminal-event-retry-stopped', {
                videoId: retry.session.getVideoId(),
                reason,
            });
        }
        if (
            session === null ||
            YoutubeWatch.terminalEventDeliveryOwner?.session === session
        ) {
            YoutubeWatch.terminalEventDeliveryOwner = null;
        }
    }

    /**
     * Keeps the completed session as a same-video sentinel against recapture.
     *
     * @param session - Active session receiving its first terminal outcome.
     * @param reason - Safe terminal reason used by timer diagnostics.
     */
    private static completeServerAnalysisSession(
        session: ServerAnalysisSession,
        reason: string,
    ): void {
        if (
            session !== YoutubeWatch.serverAnalysisSession ||
            !session.isActive()
        ) {
            return;
        }
        YoutubeWatch.clearServerAnalysisTimers(reason, session);
        session.complete();
    }

    /**
     * Keeps a safe local failure deliverable after analysis becomes terminal.
     *
     * @param session - Active route receiving its terminal local failure.
     * @param event - Safe event retained without captions or server payloads.
     * @param reason - Safe timer-cleanup reason.
     */
    private static completeServerAnalysisSessionWithEvent(
        session: ServerAnalysisSession,
        event: ServerAnalysisTerminalEvent,
        reason: string,
    ): void {
        if (
            session !== YoutubeWatch.serverAnalysisSession ||
            !session.isActive() ||
            !session.retainTerminalEvent(event)
        ) {
            return;
        }
        YoutubeWatch.clearServerAnalysisTimers(reason, session);
        session.complete();
        void YoutubeWatch.deliverPendingTerminalEvent(session);
    }

    /**
     * Cancels the complete Server route so late same-video work cannot be applied.
     *
     * @param reason - Stable route invalidation reason for development logs.
     */
    private static cancelServerAnalysisSession(reason: string): void {
        const session = YoutubeWatch.serverAnalysisSession;
        YoutubeWatch.clearServerAnalysisTimers(reason, session);
        YoutubeWatch.clearTerminalEventDelivery(reason, session);
        if (session !== null) {
            session.cancel();
            void YoutubeWatch.sendServerAnalysisSessionEvent(
                session,
                SERVER_ANALYSIS_SESSION_EVENT.Cancelled,
            );
        }
        YoutubeWatch.serverAnalysisSession = null;
    }

    /**
     * Ends transport recovery without making the same watch route restartable.
     *
     * @param session - Active route session that could not continue safely.
     * @param reason - Typed local interruption shown by the background state.
     */
    private static interruptServerAnalysisSession(
        session: ServerAnalysisSession,
        reason: ServerAnalysisInterruptionReason,
    ): void {
        YoutubeWatch.completeServerAnalysisSessionWithEvent(
            session,
            {
                event: SERVER_ANALYSIS_SESSION_EVENT.AnalysisInterrupted,
                reason,
            },
            reason,
        );
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
     * Rechecks all route ownership before sending or applying asynchronous work.
     *
     * @param session - Session expected to own the current Server route.
     * @returns Whether the same tab route may still advance that session.
     */
    private static isServerAnalysisRouteActive(
        session: ServerAnalysisSession,
    ): boolean {
        return (
            session === YoutubeWatch.serverAnalysisSession &&
            session.isActive() &&
            session.getVideoId() === YoutubeWatch.currentVideoId &&
            YoutubeWatch.analysisModeForCurrentVideo === ANALYSIS_MODE.Server &&
            YoutubeWatch.prefs !== null &&
            shouldUseServerAnalysis(YoutubeWatch.prefs)
        );
    }

    /**
     * Converts the retained operation into its existing validated runtime envelope.
     *
     * @param operation - Immutable submit, exact resubmit, or poll operation.
     * @returns Runtime message owned by the background HTTP boundary.
     */
    private static buildServerAnalysisOperationMessage(
        operation: ServerAnalysisPendingOperation,
    ): TopSkipRuntimeMessage {
        return operation.kind === SERVER_ANALYSIS_OPERATION_KIND.Poll
            ? buildRefreshServerAnalysisStatusMessage(operation.payload)
            : buildRequestServerAnalysisMessage(operation.payload);
    }

    /**
     * Bounds a runtime acknowledgement and wakes immediately on route abort.
     *
     * @param session - Active route session owning cancellation.
     * @param message - Validated runtime message for the background.
     * @returns Acknowledgement, transport failure, or local cancellation.
     */
    private static async waitForServerAnalysisRuntime(
        session: ServerAnalysisSession,
        message: TopSkipRuntimeMessage,
    ): Promise<ServerAnalysisRuntimeOutcome> {
        if (session.signal.aborted) {
            return { status: CONTENT_RUNTIME_OUTCOME_STATUS.Cancelled };
        }

        return new Promise((resolve) => {
            let settled = false;
            const finish = (outcome: ServerAnalysisRuntimeOutcome): void => {
                if (settled) {
                    return;
                }
                settled = true;
                window.clearTimeout(timeoutId);
                session.signal.removeEventListener('abort', onAbort);
                resolve(outcome);
            };
            const onAbort = (): void => {
                finish({ status: CONTENT_RUNTIME_OUTCOME_STATUS.Cancelled });
            };
            const timeoutId = window.setTimeout(() => {
                finish({
                    status: CONTENT_RUNTIME_OUTCOME_STATUS.Failed,
                    reason: CONTENT_RUNTIME_FAILURE_REASON.WatchdogTimeout,
                });
            }, SERVER_ANALYSIS_RUNTIME_MESSAGE_TIMEOUT_MS);
            session.signal.addEventListener('abort', onAbort, { once: true });

            try {
                const pending = browser.runtime.sendMessage(message);
                void pending.then(
                    (response: unknown) => {
                        finish({
                            status: CONTENT_RUNTIME_OUTCOME_STATUS.Response,
                            response,
                        });
                    },
                    () => {
                        finish({
                            status: CONTENT_RUNTIME_OUTCOME_STATUS.Failed,
                            reason:
                                CONTENT_RUNTIME_FAILURE_REASON.RuntimeRejected,
                        });
                    },
                );
            } catch {
                finish({
                    status: CONTENT_RUNTIME_OUTCOME_STATUS.Failed,
                    reason: CONTENT_RUNTIME_FAILURE_REASON.RuntimeRejected,
                });
            }
        });
    }

    /**
     * Arms one fixed deadline independent of poll cadence and transport retries.
     *
     * @param session - Newly created Server route session.
     */
    private static scheduleServerAnalysisDeadline(
        session: ServerAnalysisSession,
    ): void {
        YoutubeWatch.clearServerAnalysisDeadline();
        const delayMs = Math.max(0, session.getDeadlineAtMs() - Date.now());
        YoutubeWatch.serverAnalysisDeadlineTimerId = window.setTimeout(() => {
            YoutubeWatch.serverAnalysisDeadlineTimerId = null;
            YoutubeWatch.handleServerAnalysisDeadline(session);
        }, delayMs);
    }

    /**
     * Queues one final poll, waiting for an already in-flight operation if needed.
     *
     * @param session - Session whose wall-clock lifetime has elapsed.
     */
    private static handleServerAnalysisDeadline(
        session: ServerAnalysisSession,
    ): void {
        if (!YoutubeWatch.isServerAnalysisRouteActive(session)) {
            return;
        }
        YoutubeWatch.clearServerAnalysisPolling(
            SERVER_ANALYSIS_DEADLINE_TIMER_REASON,
        );
        YoutubeWatch.clearServerAnalysisRetry(
            SERVER_ANALYSIS_DEADLINE_TIMER_REASON,
        );
        YoutubeWatch.serverAnalysisFinalPollPending = true;
        YoutubeWatch.runFinalServerAnalysisPoll(session);
    }

    /**
     * Executes the one final poll or publishes deadline interruption when unavailable.
     *
     * @param session - Active session at or beyond its fixed deadline.
     */
    private static runFinalServerAnalysisPoll(
        session: ServerAnalysisSession,
    ): void {
        if (
            !YoutubeWatch.serverAnalysisFinalPollPending ||
            YoutubeWatch.serverAnalysisOperationOwner !== null ||
            !YoutubeWatch.isServerAnalysisRouteActive(session)
        ) {
            return;
        }
        YoutubeWatch.serverAnalysisFinalPollPending = false;
        const operation = session.takeFinalPoll();
        if (operation === null) {
            YoutubeWatch.interruptServerAnalysisSession(
                session,
                SERVER_ANALYSIS_INTERRUPTION_REASON.AnalysisDeadlineExceeded,
            );
            return;
        }
        void YoutubeWatch.executeServerAnalysisOperation(
            session,
            operation,
            true,
        );
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
            !YoutubeWatch.isServerAnalysisRouteActive(input.session)
        ) {
            return;
        }
        if (input.session.isDeadlineReached()) {
            YoutubeWatch.handleServerAnalysisDeadline(input.session);
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
     * Schedules the next replay of exactly the operation whose ack was lost.
     *
     * @param session - Active Server route session.
     * @param failureReason - Bounded transport failure classification.
     */
    private static scheduleServerAnalysisTransportRetry(
        session: ServerAnalysisSession,
        failureReason:
            | typeof CONTENT_RUNTIME_FAILURE_REASON.RuntimeRejected
            | typeof CONTENT_RUNTIME_FAILURE_REASON.WatchdogTimeout,
    ): void {
        if (!YoutubeWatch.isServerAnalysisRouteActive(session)) {
            return;
        }
        if (
            session.isDeadlineReached() ||
            YoutubeWatch.serverAnalysisFinalPollPending
        ) {
            YoutubeWatch.handleServerAnalysisDeadline(session);
            return;
        }
        const retry = session.takeTransportRetry();
        if (retry === null) {
            YoutubeWatch.interruptServerAnalysisSession(
                session,
                SERVER_ANALYSIS_INTERRUPTION_REASON.RuntimeUnavailable,
            );
            return;
        }

        YoutubeWatch.clearServerAnalysisRetry('retry-replaced');
        ContentServerAnalysisLog.warn('runtime-operation-retry-scheduled', {
            videoId: session.getVideoId(),
            operation: retry.operation.kind,
            retryNumber: retry.retryNumber,
            retryAfterMs: retry.retryAfterMs,
            reason: failureReason,
            ...(retry.operation.kind === SERVER_ANALYSIS_OPERATION_KIND.Poll
                ? { jobId: retry.operation.payload.jobId }
                : {}),
        });
        YoutubeWatch.serverAnalysisRetryTimerId = window.setTimeout(() => {
            YoutubeWatch.serverAnalysisRetryTimerId = null;
            if (session.isDeadlineReached()) {
                YoutubeWatch.handleServerAnalysisDeadline(session);
                return;
            }
            void YoutubeWatch.executeServerAnalysisOperation(
                session,
                retry.operation,
            );
        }, retry.retryAfterMs);
    }

    /**
     * Sends every Server runtime operation through one watchdog/retry boundary.
     *
     * @param session - Active route session.
     * @param operation - Immutable submit, exact resubmit, or poll operation.
     * @param isFinalPoll - Whether deadline policy forbids another retry.
     * @returns Promise resolved after response or recovery scheduling.
     */
    private static async executeServerAnalysisOperation(
        session: ServerAnalysisSession,
        operation: ServerAnalysisPendingOperation,
        isFinalPoll = false,
    ): Promise<void> {
        if (
            !YoutubeWatch.isServerAnalysisRouteActive(session) ||
            !session.isCurrentOperation(operation.operationId) ||
            YoutubeWatch.serverAnalysisOperationOwner !== null
        ) {
            return;
        }

        YoutubeWatch.clearServerAnalysisRetry('operation-started');
        YoutubeWatch.serverAnalysisOperationOwner = {
            session,
            operationId: operation.operationId,
        };
        ContentServerAnalysisLog.info('runtime-operation-sent', {
            videoId: session.getVideoId(),
            operation: operation.kind,
            finalPoll: isFinalPoll,
            ...(operation.kind === SERVER_ANALYSIS_OPERATION_KIND.Poll
                ? { jobId: operation.payload.jobId }
                : {}),
        });
        const outcome = await YoutubeWatch.waitForServerAnalysisRuntime(
            session,
            YoutubeWatch.buildServerAnalysisOperationMessage(operation),
        );
        if (
            YoutubeWatch.serverAnalysisOperationOwner?.session === session &&
            YoutubeWatch.serverAnalysisOperationOwner.operationId ===
                operation.operationId
        ) {
            YoutubeWatch.serverAnalysisOperationOwner = null;
        }

        if (
            outcome.status === CONTENT_RUNTIME_OUTCOME_STATUS.Cancelled ||
            !YoutubeWatch.isServerAnalysisRouteActive(session) ||
            !session.isCurrentOperation(operation.operationId)
        ) {
            return;
        }

        if (outcome.status === CONTENT_RUNTIME_OUTCOME_STATUS.Response) {
            YoutubeWatch.handleServerAnalysisResponse(
                outcome.response,
                session,
                isFinalPoll,
            );
        } else if (isFinalPoll) {
            YoutubeWatch.interruptServerAnalysisSession(
                session,
                SERVER_ANALYSIS_INTERRUPTION_REASON.AnalysisDeadlineExceeded,
            );
        } else {
            YoutubeWatch.scheduleServerAnalysisTransportRetry(
                session,
                outcome.reason,
            );
        }

        if (
            YoutubeWatch.serverAnalysisFinalPollPending &&
            YoutubeWatch.serverAnalysisOperationOwner === null &&
            YoutubeWatch.isServerAnalysisRouteActive(session)
        ) {
            YoutubeWatch.runFinalServerAnalysisPoll(session);
        }
    }

    /**
     * Sends a status refresh only when the page still owns the same job/video.
     *
     * @returns Promise resolved after the refresh response is handled.
     */
    private static async refreshServerAnalysisStatus(): Promise<void> {
        const session = YoutubeWatch.serverAnalysisSession;
        const operation = session?.getPendingOperation() ?? null;
        YoutubeWatch.serverAnalysisPollTimerId = null;

        if (
            session === null ||
            operation?.kind !== SERVER_ANALYSIS_OPERATION_KIND.Poll ||
            !YoutubeWatch.isServerAnalysisRouteActive(session)
        ) {
            YoutubeWatch.cancelServerAnalysisSession('route-inactive');
            return;
        }
        await YoutubeWatch.executeServerAnalysisOperation(session, operation);
    }

    /**
     * Applies background acks to the content-owned polling lifecycle.
     *
     * @param response - Untyped ack from the background.
     * @param session - Active content-owned session that produced the request.
     * @param isFinalPoll - Whether a processing ack must end at the deadline.
     */
    private static handleServerAnalysisResponse(
        response: unknown,
        session: ServerAnalysisSession,
        isFinalPoll = false,
    ): void {
        if (session.isTerminal()) {
            return;
        }
        const videoId = session.getVideoId();
        if (
            !YoutubeWatch.isServerAnalysisRouteActive(session)
        ) {
            if (session === YoutubeWatch.serverAnalysisSession) {
                YoutubeWatch.cancelServerAnalysisSession('stale-response');
            }
            return;
        }
        if (!YoutubeWatch.isServerAnalysisResponse(response)) {
            ContentServerAnalysisLog.warn('runtime-ack-invalid', { videoId });
            YoutubeWatch.interruptServerAnalysisSession(
                session,
                SERVER_ANALYSIS_INTERRUPTION_REASON.RuntimeUnavailable,
            );
            return;
        }

        ContentServerAnalysisLog.info('runtime-ack', {
            videoId,
            status: response.ok
                ? response.status
                : SERVER_ANALYSIS_FAILED_ACK_LOG_STATUS,
            jobId:
                response.ok && response.status === 'processing'
                    ? response.jobId
                    : undefined,
        });

        if (!response.ok) {
            YoutubeWatch.completeServerAnalysisSession(
                session,
                'background-error',
            );
            return;
        }

        if (response.status === 'processing') {
            const pollPayload = session.pinProcessing(
                response.jobId,
                response.identity,
            );
            if (pollPayload === null) {
                YoutubeWatch.interruptServerAnalysisSession(
                    session,
                    SERVER_ANALYSIS_INTERRUPTION_REASON.RuntimeUnavailable,
                );
                return;
            }
            if (isFinalPoll) {
                YoutubeWatch.interruptServerAnalysisSession(
                    session,
                    SERVER_ANALYSIS_INTERRUPTION_REASON
                        .AnalysisDeadlineExceeded,
                );
                return;
            }
            if (
                session.isDeadlineReached() ||
                YoutubeWatch.serverAnalysisFinalPollPending
            ) {
                YoutubeWatch.serverAnalysisFinalPollPending = true;
                return;
            }
            YoutubeWatch.scheduleServerAnalysisStatusRefresh({
                session,
                pollAfterSec: response.pollAfterSec,
            });
            return;
        }

        if (response.status === 'resubmit_required') {
            if (isFinalPoll || session.isDeadlineReached()) {
                YoutubeWatch.interruptServerAnalysisSession(
                    session,
                    SERVER_ANALYSIS_INTERRUPTION_REASON
                        .AnalysisDeadlineExceeded,
                );
                return;
            }
            const request = session.takeExactResubmission();
            if (request === null) {
                YoutubeWatch.interruptServerAnalysisSession(
                    session,
                    SERVER_ANALYSIS_INTERRUPTION_REASON.RuntimeUnavailable,
                );
                return;
            }
            YoutubeWatch.clearServerAnalysisPolling('resubmit');
            const operation = session.getPendingOperation();
            if (operation !== null) {
                void YoutubeWatch.executeServerAnalysisOperation(
                    session,
                    operation,
                );
            }
            return;
        }

        if (response.status === 'inactive') {
            YoutubeWatch.completeServerAnalysisSession(session, 'inactive');
            return;
        }
        YoutubeWatch.completeServerAnalysisSession(
            session,
            'terminal-response',
        );
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
        try {
            const pending = browser.runtime.sendMessage({
                type: TOPSKIP_MESSAGE.PREFLIGHT_BYOK_SETUP,
                payload: { videoId },
            });
            void pending.catch(() => {
                // The background owns setup status; caption capture remains independent.
            });
        } catch {
            // Reloaded content contexts cannot reach the replacement background.
        }
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
        event: Exclude<
            ServerAnalysisSessionEventPayload['event'],
            | typeof SERVER_ANALYSIS_SESSION_EVENT.AnalysisInterrupted
            | typeof SERVER_ANALYSIS_SESSION_EVENT.CaptionsUnavailable
            | typeof SERVER_ANALYSIS_SESSION_EVENT.CaptionExtractionFailed
        >,
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
     * Accepts only a durable acknowledgement from the background event handler.
     *
     * @param response - Opaque runtime acknowledgement.
     * @returns Whether background accepted and persisted the terminal event.
     */
    private static isTerminalEventDeliveryAck(response: unknown): boolean {
        return (
            response !== null &&
            typeof response === 'object' &&
            Reflect.get(response, 'ok') === true
        );
    }

    /**
     * Rejects delivery work after navigation, acknowledgement, or cancellation.
     *
     * @param session - Terminal session expected to own the pending event.
     * @returns Whether the same terminal route still needs delivery.
     */
    private static isTerminalEventDeliveryCurrent(
        session: ServerAnalysisSession,
    ): boolean {
        return (
            session === YoutubeWatch.serverAnalysisSession &&
            session.isTerminal() &&
            session.getPendingTerminalEvent() !== null &&
            !session.getTerminalEventDeliverySignal().aborted &&
            session.getVideoId() === YoutubeWatch.currentVideoId
        );
    }

    /**
     * Bounds one terminal-event acknowledgement and wakes on route cancellation.
     *
     * @param session - Terminal route retaining the event.
     * @param event - Safe local terminal event without captions or server data.
     * @returns Durable ack, retryable failure, or route cancellation.
     */
    private static async waitForTerminalEventDelivery(
        session: ServerAnalysisSession,
        event: ServerAnalysisTerminalEvent,
    ): Promise<ServerAnalysisTerminalEventDeliveryOutcome> {
        const signal = session.getTerminalEventDeliverySignal();
        if (signal.aborted) {
            return { status: CONTENT_RUNTIME_OUTCOME_STATUS.Cancelled };
        }
        return new Promise((resolve) => {
            let settled = false;
            const finish = (
                outcome: ServerAnalysisTerminalEventDeliveryOutcome,
            ): void => {
                if (settled) {
                    return;
                }
                settled = true;
                window.clearTimeout(timeoutId);
                signal.removeEventListener('abort', onAbort);
                resolve(outcome);
            };
            const onAbort = (): void => {
                finish({ status: CONTENT_RUNTIME_OUTCOME_STATUS.Cancelled });
            };
            const timeoutId = window.setTimeout(() => {
                finish({
                    status: CONTENT_RUNTIME_OUTCOME_STATUS.Failed,
                    reason: CONTENT_RUNTIME_FAILURE_REASON.WatchdogTimeout,
                });
            }, SERVER_ANALYSIS_RUNTIME_MESSAGE_TIMEOUT_MS);
            signal.addEventListener('abort', onAbort, { once: true });

            try {
                const pending = browser.runtime.sendMessage({
                    type: TOPSKIP_MESSAGE.SERVER_ANALYSIS_SESSION_EVENT,
                    payload: {
                        ...event,
                        sessionId: session.sessionId,
                        videoId: session.getVideoId(),
                    },
                });
                void pending.then(
                    (response: unknown) => {
                        finish(
                            YoutubeWatch.isTerminalEventDeliveryAck(response)
                                ? {
                                        status:
                                            CONTENT_RUNTIME_OUTCOME_STATUS
                                                .Acknowledged,
                                    }
                                : {
                                        status:
                                            CONTENT_RUNTIME_OUTCOME_STATUS
                                                .Failed,
                                        reason:
                                            CONTENT_RUNTIME_FAILURE_REASON
                                                .InvalidAck,
                                    },
                        );
                    },
                    () => {
                        finish({
                            status: CONTENT_RUNTIME_OUTCOME_STATUS.Failed,
                            reason:
                                CONTENT_RUNTIME_FAILURE_REASON.RuntimeRejected,
                        });
                    },
                );
            } catch {
                finish({
                    status: CONTENT_RUNTIME_OUTCOME_STATUS.Failed,
                    reason: CONTENT_RUNTIME_FAILURE_REASON.RuntimeRejected,
                });
            }
        });
    }

    /**
     * Schedules one bounded retry while retaining the terminal event on exhaustion.
     *
     * @param session - Terminal route retaining the event.
     * @param failureReason - Safe transport classification for diagnostics.
     */
    private static scheduleTerminalEventDeliveryRetry(
        session: ServerAnalysisSession,
        failureReason: Exclude<
            ServerAnalysisTerminalEventDeliveryOutcome,
            | { status: typeof CONTENT_RUNTIME_OUTCOME_STATUS.Acknowledged }
            | { status: typeof CONTENT_RUNTIME_OUTCOME_STATUS.Cancelled }
        >['reason'],
    ): void {
        if (!YoutubeWatch.isTerminalEventDeliveryCurrent(session)) {
            return;
        }
        const retry = session.takeTerminalEventDeliveryRetry();
        const event = session.getPendingTerminalEvent();
        if (retry === null || event === null) {
            ContentServerAnalysisLog.warn('terminal-event-delivery-exhausted', {
                videoId: session.getVideoId(),
                event: event?.event,
                reason: failureReason,
            });
            return;
        }
        ContentServerAnalysisLog.warn('terminal-event-retry-scheduled', {
            videoId: session.getVideoId(),
            event: event.event,
            retryNumber: retry.retryNumber,
            retryAfterMs: retry.retryAfterMs,
            reason: failureReason,
        });
        const timerId = window.setTimeout(() => {
            if (
                YoutubeWatch.terminalEventRetryTimer?.session !== session ||
                YoutubeWatch.terminalEventRetryTimer.timerId !== timerId
            ) {
                return;
            }
            YoutubeWatch.terminalEventRetryTimer = null;
            void YoutubeWatch.deliverPendingTerminalEvent(session);
        }, retry.retryAfterMs);
        YoutubeWatch.terminalEventRetryTimer = { session, timerId };
    }

    /**
     * Delivers one retained terminal event through an ownership-safe attempt.
     *
     * @param session - Terminal route retaining the event.
     * @returns Promise resolved after ack or recovery scheduling.
     */
    private static async deliverPendingTerminalEvent(
        session: ServerAnalysisSession,
    ): Promise<void> {
        const event = session.getPendingTerminalEvent();
        if (
            event === null ||
            !YoutubeWatch.isTerminalEventDeliveryCurrent(session) ||
            YoutubeWatch.terminalEventDeliveryOwner !== null ||
            YoutubeWatch.terminalEventRetryTimer !== null
        ) {
            return;
        }
        YoutubeWatch.terminalEventDeliveryAttemptSequence += 1;
        const attemptId = YoutubeWatch.terminalEventDeliveryAttemptSequence;
        YoutubeWatch.terminalEventDeliveryOwner = { session, attemptId };
        ContentServerAnalysisLog.info('terminal-event-delivery-sent', {
            videoId: session.getVideoId(),
            event: event.event,
            attemptId,
        });
        const outcome = await YoutubeWatch.waitForTerminalEventDelivery(
            session,
            event,
        );
        if (
            YoutubeWatch.terminalEventDeliveryOwner?.session === session &&
            YoutubeWatch.terminalEventDeliveryOwner.attemptId === attemptId
        ) {
            YoutubeWatch.terminalEventDeliveryOwner = null;
        }
        if (
            outcome.status === CONTENT_RUNTIME_OUTCOME_STATUS.Cancelled ||
            !YoutubeWatch.isTerminalEventDeliveryCurrent(session)
        ) {
            return;
        }
        if (outcome.status === CONTENT_RUNTIME_OUTCOME_STATUS.Acknowledged) {
            if (session.acknowledgeTerminalEventDelivery()) {
                ContentServerAnalysisLog.info(
                    'terminal-event-delivery-acknowledged',
                    {
                        videoId: session.getVideoId(),
                        event: event.event,
                    },
                );
            }
            return;
        }
        YoutubeWatch.scheduleTerminalEventDeliveryRetry(
            session,
            outcome.reason,
        );
    }

    /**
     * Replenishes exhausted delivery only when a live worker probes this bundle.
     */
    private static resumePendingTerminalEventDelivery(): void {
        const session = YoutubeWatch.serverAnalysisSession;
        if (
            session === null ||
            YoutubeWatch.terminalEventDeliveryOwner !== null ||
            YoutubeWatch.terminalEventRetryTimer !== null ||
            !YoutubeWatch.isTerminalEventDeliveryCurrent(session) ||
            !session.restartTerminalEventDeliveryRetries()
        ) {
            return;
        }
        const event = session.getPendingTerminalEvent();
        ContentServerAnalysisLog.info('terminal-event-delivery-resumed', {
            videoId: session.getVideoId(),
            event: event?.event,
        });
        void YoutubeWatch.deliverPendingTerminalEvent(session);
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
        void YoutubeWatch.sendServerAnalysisSessionEvent(
            session,
            SERVER_ANALYSIS_SESSION_EVENT.AcquisitionStarted,
        );
        WatchCaptions.preparePageBridge();
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
            const eventName =
                capture.failure.reason ===
                CAPTION_CAPTURE_FAILURE_REASON.CaptionsUnavailable
                    ? SERVER_ANALYSIS_SESSION_EVENT.CaptionsUnavailable
                    : SERVER_ANALYSIS_SESSION_EVENT.CaptionExtractionFailed;
            const event: ServerAnalysisTerminalEvent = {
                event: eventName,
            };
            YoutubeWatch.completeServerAnalysisSessionWithEvent(
                session,
                event,
                'caption-acquisition-failed',
            );
            return;
        }

        const retained = session.acceptCaptions(
            capture.payload,
            video.duration,
        );
        if (retained === null) {
            YoutubeWatch.completeServerAnalysisSessionWithEvent(
                session,
                {
                    event: SERVER_ANALYSIS_SESSION_EVENT
                        .CaptionExtractionFailed,
                },
                'caption-validation-failed',
            );
            return;
        }

        const operation = session.getPendingOperation();
        if (operation === null) {
            YoutubeWatch.interruptServerAnalysisSession(
                session,
                SERVER_ANALYSIS_INTERRUPTION_REASON.RuntimeUnavailable,
            );
            return;
        }
        await YoutubeWatch.executeServerAnalysisOperation(session, operation);
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

        YoutubeWatch.clearTerminalEventDelivery('new-session', null);
        const session = ServerAnalysisSession.create(videoId);
        YoutubeWatch.serverAnalysisSession = session;
        YoutubeWatch.scheduleServerAnalysisDeadline(session);
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
        const isNewVideo = vid !== YoutubeWatch.currentVideoId;

        if (isNewVideo) {
            YoutubeWatch.resetForNewVideo(vid);
        }

        const prefs = YoutubeWatch.prefs;
        if (prefs === null) {
            YoutubeWatch.logServerAnalysisRoute({
                videoId: vid,
                outcome: 'waiting-for-prefs',
                hasVideo: false,
            });
            return;
        }
        if (!prefs.enabled) {
            YoutubeWatch.deactivateDisabledRoute();
            YoutubeWatch.logServerAnalysisRoute({
                videoId: vid,
                outcome: 'disabled',
                hasVideo: false,
                enabled: prefs.enabled,
                analysisMode: prefs.analysisMode,
            });
            return;
        }

        const video = YoutubeWatch.getMainVideo();

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
            YoutubeWatch.deactivateDisabledRoute();
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
        WatchCaptions.preparePageBridge();
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
     * Narrows an untrusted runtime reply before it may control route selection.
     *
     * @param response - Opaque GET_PREFS acknowledgement.
     * @returns Valid preferences or `null` when another read is required.
     */
    private static parsePrefsResponse(
        response: unknown,
    ): UserPreferences | null {
        if (
            response === null ||
            typeof response !== 'object' ||
            Reflect.get(response, 'ok') !== true
        ) {
            return null;
        }
        const parsed = v.safeParse(
            userPreferencesSchema,
            Reflect.get(response, 'prefs'),
        );
        return parsed.success ? parsed.output : null;
    }

    /**
     * Clears the watchdog owned by the current logical preferences read.
     */
    private static clearPrefsRequestTimeout(): void {
        if (YoutubeWatch.prefsRequestTimeoutTimerId !== null) {
            window.clearTimeout(YoutubeWatch.prefsRequestTimeoutTimerId);
        }
        YoutubeWatch.prefsRequestTimeoutTimerId = null;
    }

    /**
     * Clears a delayed retry after valid state or context disposal.
     */
    private static clearPrefsRetry(): void {
        if (YoutubeWatch.prefsRetryTimerId !== null) {
            window.clearTimeout(YoutubeWatch.prefsRetryTimerId);
        }
        YoutubeWatch.prefsRetryTimerId = null;
    }

    /**
     * Invalidates pending ownership so its eventual reply cannot mutate state.
     */
    private static invalidatePrefsLoading(): void {
        YoutubeWatch.clearPrefsRequestTimeout();
        YoutubeWatch.clearPrefsRetry();
        YoutubeWatch.activePrefsRequestId = null;
    }

    /**
     * Stops all preferences recovery when this content context is replaced.
     */
    private static stopPrefsLoading(): void {
        YoutubeWatch.prefsLoadingActive = false;
        YoutubeWatch.invalidatePrefsLoading();
    }

    /**
     * Releases one request only if it still owns the latest generation.
     *
     * @param requestId - Generation captured before runtime messaging.
     * @returns Whether this completion may advance preferences state.
     */
    private static finishPrefsRequest(requestId: number): boolean {
        if (
            !YoutubeWatch.prefsLoadingActive ||
            YoutubeWatch.activePrefsRequestId !== requestId
        ) {
            return false;
        }
        YoutubeWatch.clearPrefsRequestTimeout();
        YoutubeWatch.activePrefsRequestId = null;
        return true;
    }

    /**
     * Schedules another bounded read while no valid snapshot has arrived.
     *
     * @param reason - Safe classification for development diagnostics.
     */
    private static schedulePrefsRetry(reason: ContentPrefsRetryReason): void {
        if (
            !YoutubeWatch.prefsLoadingActive ||
            YoutubeWatch.prefs !== null ||
            YoutubeWatch.activePrefsRequestId !== null ||
            YoutubeWatch.prefsRetryTimerId !== null
        ) {
            return;
        }
        ContentServerAnalysisLog.warn('prefs-load-retry-scheduled', {
            reason,
            retryAfterMs: CONTENT_PREFS_RETRY_DELAY_MS,
        });
        YoutubeWatch.prefsRetryTimerId = window.setTimeout(() => {
            YoutubeWatch.prefsRetryTimerId = null;
            YoutubeWatch.loadPrefsFromBackground();
        }, CONTENT_PREFS_RETRY_DELAY_MS);
    }

    /**
     * Converts a rejected or timed-out owned read into a delayed retry.
     *
     * @param requestId - Generation that observed the transport failure.
     * @param reason - Safe retry classification.
     */
    private static handlePrefsRequestFailure(
        requestId: number,
        reason: ContentPrefsRetryReason,
    ): void {
        if (!YoutubeWatch.finishPrefsRequest(requestId)) {
            return;
        }
        YoutubeWatch.schedulePrefsRetry(reason);
    }

    /**
     * Reads initial preferences until a valid response or broadcast wins.
     */
    private static loadPrefsFromBackground(): void {
        if (
            !YoutubeWatch.prefsLoadingActive ||
            YoutubeWatch.prefs !== null ||
            YoutubeWatch.activePrefsRequestId !== null ||
            YoutubeWatch.prefsRetryTimerId !== null
        ) {
            return;
        }

        YoutubeWatch.prefsRequestSequence += 1;
        const requestId = YoutubeWatch.prefsRequestSequence;
        YoutubeWatch.activePrefsRequestId = requestId;
        YoutubeWatch.prefsRequestTimeoutTimerId = window.setTimeout(() => {
            YoutubeWatch.handlePrefsRequestFailure(
                requestId,
                CONTENT_RUNTIME_FAILURE_REASON.WatchdogTimeout,
            );
        }, CONTENT_PREFS_REQUEST_TIMEOUT_MS);

        try {
            const pending = browser.runtime.sendMessage({
                type: TOPSKIP_MESSAGE.GET_PREFS,
            });
            void pending.then(
                (response: unknown) => {
                    if (!YoutubeWatch.finishPrefsRequest(requestId)) {
                        return;
                    }
                    const prefs = YoutubeWatch.parsePrefsResponse(response);
                    if (prefs === null) {
                        YoutubeWatch.schedulePrefsRetry(
                            CONTENT_RUNTIME_FAILURE_REASON.InvalidResponse,
                        );
                        return;
                    }
                    YoutubeWatch.prefs = prefs;
                    ContentServerAnalysisLog.info('prefs-loaded', {
                        enabled: prefs.enabled,
                        analysisMode: prefs.analysisMode,
                    });
                    YoutubeWatch.syncVideoBinding();
                },
                () => {
                    YoutubeWatch.handlePrefsRequestFailure(
                        requestId,
                        CONTENT_RUNTIME_FAILURE_REASON.RuntimeRejected,
                    );
                },
            );
        } catch {
            YoutubeWatch.handlePrefsRequestFailure(
                requestId,
                CONTENT_RUNTIME_FAILURE_REASON.RuntimeRejected,
            );
        }
    }

    /**
     * Starts a fresh recovery lifecycle for this content context.
     */
    private static startPrefsLoading(): void {
        YoutubeWatch.invalidatePrefsLoading();
        YoutubeWatch.prefs = null;
        YoutubeWatch.prefsLoadingActive = true;
        YoutubeWatch.loadPrefsFromBackground();
    }

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
                enabled: YoutubeWatch.prefs?.enabled === true,
                analysisMode: YoutubeWatch.analysisModeForCurrentVideo,
                activeSessionId:
                    YoutubeWatch.serverAnalysisSession?.sessionId ?? null,
                ...('sessionId' in m ? { messageSessionId: m.sessionId } : {}),
            })
        ) {
            contentLog.warn(
                'PROMO_BLOCKS_DETECTED: videoId mismatch',
                formatLogFields({
                    msg: videoId,
                    current: YoutubeWatch.currentVideoId,
                }),
            );
            return;
        }
        if (m.source !== PROMO_DETECTION_SOURCE.LocalProvider) {
            const session = YoutubeWatch.serverAnalysisSession;
            if (session === null || !session.acceptTerminalDelivery()) {
                return;
            }
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
        YoutubeWatch.invalidatePrefsLoading();
        const previousPrefs = YoutubeWatch.prefs;
        YoutubeWatch.prefs = m.prefs;
        if (!m.prefs.enabled) {
            YoutubeWatch.deactivateDisabledRoute();
            YoutubeWatch.syncVideoBinding();
            return;
        }

        const replacesActiveAnalysisMode =
            previousPrefs?.enabled === true &&
            previousPrefs.analysisMode !== m.prefs.analysisMode;
        if (replacesActiveAnalysisMode) {
            YoutubeWatch.cancelServerAnalysisSession(
                WATCH_CAPTION_CANCEL_REASON.AnalysisModeChanged,
            );
            WatchCaptions.cancel(
                WATCH_CAPTION_CANCEL_REASON.AnalysisModeChanged,
            );
            YoutubeWatch.analysisModeForCurrentVideo = null;
            YoutubeWatch.byokPreflightVideoId = null;
            YoutubeWatch.captionScheduledVideoId = null;
            YoutubeWatch.lastTime = YoutubeWatch.boundVideo?.currentTime ?? 0;
            YoutubeWatch.isSeeking = false;
            YoutubeWatch.promoBlocks = [];
            YoutubeWatch.firedPromoBlockStartKeys.clear();
        }
        YoutubeWatch.syncVideoBinding();
    }

    /**
     * Wires SPA hooks, video binding, and runtime messaging for prefs.
     *
     * @returns Cleanup callback for replacement content bundles.
     */
    static init(): () => void {
        ContentServerAnalysisLog.info('content-initialized', {
            videoId: YoutubeWatch.getWatchVideoId(),
            version: getExtensionBuildLabel(),
        });
        YoutubeWatch.startPrefsLoading();
        // `runtime.onMessage` replies reach the sender only when the listener
        // returns a Promise (or `true` plus `sendResponse`); the polyfill
        // treats a plain object as "no reply", and the background gates
        // Server analysis and wake accounting on these two replies.
        const onRuntimeMessage = (message: unknown): unknown => {
            if (
                message !== null &&
                typeof message === 'object' &&
                Reflect.get(message, 'type') ===
                    TOPSKIP_MESSAGE.CONTENT_ROUTE_STATUS
            ) {
                return Promise.resolve(YoutubeWatch.getContentRouteStatus());
            }
            if (
                message !== null &&
                typeof message === 'object' &&
                Reflect.get(message, 'type') ===
                    TOPSKIP_MESSAGE.CONTENT_SCRIPT_READY
            ) {
                YoutubeWatch.resumePendingTerminalEventDelivery();
                const ack: ContentScriptReadyResponse = {
                    ok: true,
                    protocolVersion: CONTENT_SCRIPT_PROTOCOL_VERSION,
                    extensionVersion: browser.runtime.getManifest().version,
                };
                return Promise.resolve(ack);
            }
            YoutubeWatch.onPrefsUpdatedMessage(message);
            YoutubeWatch.onPromoBlocksMessage(message);
            return undefined;
        };
        browser.runtime.onMessage.addListener(onRuntimeMessage);

        YoutubeWatch.syncVideoBinding();

        const onNav = (): void => {
            YoutubeWatch.syncVideoBinding();
        };

        window.addEventListener('popstate', onNav);
        window.addEventListener('yt-navigate-finish', onNav);

        const pollIntervalId = globalThis.setInterval(() => {
            YoutubeWatch.syncVideoBinding();
        }, VIDEO_BINDING_POLL_INTERVAL_MS);

        return (): void => {
            YoutubeWatch.stopPrefsLoading();
            globalThis.clearInterval(pollIntervalId);
            window.removeEventListener('popstate', onNav);
            window.removeEventListener('yt-navigate-finish', onNav);
            try {
                browser.runtime.onMessage.removeListener(onRuntimeMessage);
            } catch {
                // Reloaded extension contexts can no longer access runtime APIs.
            }
            YoutubeWatch.cancelServerAnalysisSession('content-replaced');
            YoutubeWatch.unbindVideo();
            WatchCaptions.dispose();
        };
    }
}
