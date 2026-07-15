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
    decideServerAnalysisDuration,
    shouldUseServerAnalysis,
} from '@/content/server-analysis-request';
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
    pickMessage,
    TOPSKIP_MESSAGE,
    type RequestServerAnalysisResponse,
} from '@/shared/messages';
import type { PromoBlock } from '@topskip/common/promo-types';
import { translator } from '@/shared/i18n/translator';
import {
    SKIP_TOAST_BOTTOM_PX,
    SKIP_TOAST_DISPLAY_MS,
    SKIP_TOAST_FADE_MS,
    SKIP_TOAST_ID,
    SKIP_TOAST_Z_INDEX,
    SERVER_ANALYSIS_DURATION_WAIT_MAX_MS,
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
     * Last video id for which server-mode analysis was requested.
     */
    private static serverRequestedVideoId: string | null = null;
    /**
     * Start of the bounded wait for YouTube's asynchronously loaded duration.
     */
    private static serverAnalysisDurationWaitStartedAtMs: number | null = null;
    /**
     * Timer id for the content-owned server job polling loop.
     */
    private static serverAnalysisPollTimerId: number | null = null;
    /**
     * Backend job id currently being polled by this watch page.
     */
    private static serverAnalysisPollingJobId: string | null = null;
    /**
     * Video id paired with the active backend polling job.
     */
    private static serverAnalysisPollingVideoId: string | null = null;
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
        YoutubeWatch.clearServerAnalysisPolling();
        YoutubeWatch.currentVideoId = videoId;
        YoutubeWatch.analysisModeForCurrentVideo = null;
        YoutubeWatch.byokPreflightVideoId = null;
        YoutubeWatch.serverRequestedVideoId = null;
        YoutubeWatch.serverAnalysisDurationWaitStartedAtMs = null;
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
        const jobId = YoutubeWatch.serverAnalysisPollingJobId;
        const videoId = YoutubeWatch.serverAnalysisPollingVideoId;
        if (YoutubeWatch.serverAnalysisPollTimerId !== null || jobId !== null) {
            ContentServerAnalysisLog.info('polling-stopped', {
                videoId,
                jobId,
                reason,
            });
        }
        if (YoutubeWatch.serverAnalysisPollTimerId !== null) {
            window.clearTimeout(YoutubeWatch.serverAnalysisPollTimerId);
        }
        YoutubeWatch.serverAnalysisPollTimerId = null;
        YoutubeWatch.serverAnalysisPollingJobId = null;
        YoutubeWatch.serverAnalysisPollingVideoId = null;
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
        if (response === null || typeof response !== 'object') {
            return false;
        }

        if (!('ok' in response)) {
            return false;
        }
        const ok: unknown = response.ok;
        if (ok === false) {
            return 'error' in response && typeof response.error === 'string';
        }
        if (ok !== true) {
            return false;
        }

        if (!('status' in response)) {
            return false;
        }
        const status: unknown = response.status;
        if (status === 'processing') {
            return (
                'jobId' in response &&
                typeof response.jobId === 'string' &&
                'pollAfterSec' in response &&
                typeof response.pollAfterSec === 'number'
            );
        }

        return (
            status === 'inactive' ||
            status === 'ready' ||
            status === 'no_promo' ||
            status === 'unavailable' ||
            status === 'error' ||
            status === 'rate_limited'
        );
    }

    /**
     * Schedules the next status refresh while the current video stays active.
     *
     * @param input - Polling job id, video id, and server interval.
     */
    private static scheduleServerAnalysisStatusRefresh(input: {
        videoId: string;
        jobId: string;
        pollAfterSec: number;
    }): void {
        YoutubeWatch.clearServerAnalysisPolling();
        YoutubeWatch.serverAnalysisPollingJobId = input.jobId;
        YoutubeWatch.serverAnalysisPollingVideoId = input.videoId;
        ContentServerAnalysisLog.info('polling-scheduled', {
            videoId: input.videoId,
            jobId: input.jobId,
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
        const jobId = YoutubeWatch.serverAnalysisPollingJobId;
        const videoId = YoutubeWatch.serverAnalysisPollingVideoId;
        YoutubeWatch.serverAnalysisPollTimerId = null;

        if (
            jobId === null ||
            videoId === null ||
            videoId !== YoutubeWatch.currentVideoId ||
            YoutubeWatch.analysisModeForCurrentVideo !== ANALYSIS_MODE.Server ||
            YoutubeWatch.prefs === null ||
            !shouldUseServerAnalysis(YoutubeWatch.prefs)
        ) {
            YoutubeWatch.clearServerAnalysisPolling('route-inactive');
            return;
        }

        try {
            const videoDurationSec = YoutubeWatch.boundVideo?.duration;
            const durationSec =
                videoDurationSec !== undefined &&
                Number.isFinite(videoDurationSec) &&
                videoDurationSec > 0
                    ? videoDurationSec
                    : undefined;
            ContentServerAnalysisLog.info('poll-request-sent', {
                videoId,
                jobId,
                durationSec,
            });
            const response = await browser.runtime.sendMessage(
                buildRefreshServerAnalysisStatusMessage({
                    videoId,
                    jobId,
                    durationSec,
                }),
            );
            YoutubeWatch.handleServerAnalysisResponse(response, videoId);
        } catch {
            ContentServerAnalysisLog.warn('poll-request-failed', {
                videoId,
                jobId,
            });
            YoutubeWatch.clearServerAnalysisPolling('runtime-error');
        }
    }

    /**
     * Applies background acks to the content-owned polling lifecycle.
     *
     * @param response - Untyped ack from the background.
     * @param videoId - Video id tied to the request that produced the ack.
     */
    private static handleServerAnalysisResponse(
        response: unknown,
        videoId: string,
    ): void {
        if (
            videoId !== YoutubeWatch.currentVideoId ||
            YoutubeWatch.analysisModeForCurrentVideo !== ANALYSIS_MODE.Server ||
            YoutubeWatch.prefs === null ||
            !shouldUseServerAnalysis(YoutubeWatch.prefs)
        ) {
            YoutubeWatch.clearServerAnalysisPolling('stale-response');
            return;
        }
        if (!YoutubeWatch.isServerAnalysisResponse(response)) {
            ContentServerAnalysisLog.warn('runtime-ack-invalid', { videoId });
            YoutubeWatch.clearServerAnalysisPolling('invalid-ack');
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
            return;
        }

        if (response.status === 'processing') {
            YoutubeWatch.scheduleServerAnalysisStatusRefresh({
                videoId,
                jobId: response.jobId,
                pollAfterSec: response.pollAfterSec,
            });
            return;
        }

        if (response.status === 'inactive') {
            YoutubeWatch.serverRequestedVideoId = null;
        }
        YoutubeWatch.clearServerAnalysisPolling('terminal-response');
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
     * Requests server analysis once for the active video in server mode.
     *
     * @param video Active watch player element.
     * @param videoId Current watch video id.
     * @returns Deduplicated route outcome for development diagnostics.
     */
    private static requestServerAnalysis(
        video: HTMLVideoElement,
        videoId: string,
    ): 'already-requested' | 'server-request' | 'waiting-for-duration' {
        if (YoutubeWatch.serverRequestedVideoId === videoId) {
            return 'already-requested';
        }

        const durationDecision = decideServerAnalysisDuration({
            durationSec: video.duration,
            waitStartedAtMs: YoutubeWatch.serverAnalysisDurationWaitStartedAtMs,
            nowMs: Date.now(),
            maxWaitMs: SERVER_ANALYSIS_DURATION_WAIT_MAX_MS,
        });
        if (durationDecision.status === 'waiting') {
            YoutubeWatch.serverAnalysisDurationWaitStartedAtMs =
                durationDecision.waitStartedAtMs;
            return 'waiting-for-duration';
        }

        YoutubeWatch.serverAnalysisDurationWaitStartedAtMs = null;
        YoutubeWatch.serverRequestedVideoId = videoId;
        const durationSec =
            durationDecision.status === 'ready'
                ? durationDecision.durationSec
                : undefined;
        ContentServerAnalysisLog.info('runtime-request-sent', {
            videoId,
            durationSec,
        });
        void browser.runtime
            .sendMessage(
                buildRequestServerAnalysisMessage({ videoId, durationSec }),
            )
            .then((response: unknown) => {
                YoutubeWatch.handleServerAnalysisResponse(response, videoId);
            })
            .catch(() => {
                ContentServerAnalysisLog.warn('runtime-request-failed', {
                    videoId,
                });
                YoutubeWatch.clearServerAnalysisPolling('runtime-error');
            });
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
            YoutubeWatch.clearServerAnalysisPolling();
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
        if (videoId !== YoutubeWatch.currentVideoId) {
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
        YoutubeWatch.prefs = m.prefs;
        if (!shouldUseServerAnalysis(m.prefs)) {
            YoutubeWatch.clearServerAnalysisPolling();
            YoutubeWatch.serverRequestedVideoId = null;
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
