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
import { contentLog } from '@/content/content-log';
import { WatchCaptions } from '@/content/watch-captions';
import browser from '@/shared/browser';
import type { UserPreferences } from '@/shared/constants';
import { pickMessage, TOPSKIP_MESSAGE } from '@/shared/messages';
import type { PromoBlock } from '@/shared/promo-types';
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
 * YouTube watch DOM + runtime messaging; not instantiable.
 */
export class YoutubeWatch {
    /**
     * Master switch from background; disables skips when user turns TopSkip off.
     */
    private static enabled = true;
    /**
     * Watch URL video id (or e2e fixture id) for the bound player.
     */
    private static currentVideoId: string | null = null;
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
        if (!YoutubeWatch.enabled || YoutubeWatch.isLikelyAdPlaying()) {
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
        YoutubeWatch.currentVideoId = videoId;
        YoutubeWatch.lastTime = 0;
        YoutubeWatch.promoBlocks = [];
        YoutubeWatch.firedPromoBlockStartKeys.clear();
    }

    /**
     * Re-binds or unbinds the video element after navigation or DOM changes.
     */
    private static syncVideoBinding(): void {
        if (!YoutubeWatch.shouldActivateForPage()) {
            YoutubeWatch.unbindVideo();
            return;
        }

        const vid = YoutubeWatch.getWatchVideoId();
        const video = YoutubeWatch.getMainVideo();

        if (vid !== YoutubeWatch.currentVideoId) {
            YoutubeWatch.resetForNewVideo(vid);
            if (video) {
                WatchCaptions.scheduleForVideoId(vid, 'video-id-change');
                YoutubeWatch.bindVideo(video);
            }
            return;
        }

        if (video && YoutubeWatch.boundVideo !== video) {
            contentLog.info('video element swap detected, rebinding');
            WatchCaptions.scheduleForVideoId(vid, 'video-element-ready');
            YoutubeWatch.bindVideo(video);
        }
    }

    /**
     * Initial `enabled` flag from the background (GET_PREFS).
     */
    private static loadEnabledFromBackground(): void {
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
                    if (typeof prefs.enabled === 'boolean') {
                        YoutubeWatch.enabled = prefs.enabled;
                    }
                }
            })
            .catch(() => {
                // keep default enabled
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
        YoutubeWatch.enabled = m.prefs.enabled;
    }

    /**
     * Wires SPA hooks, video binding, and runtime messaging for prefs.
     */
    static init(): void {
        WatchCaptions.installPageBridge();
        YoutubeWatch.loadEnabledFromBackground();
        browser.runtime.onMessage.addListener((message: unknown) => {
            YoutubeWatch.onPrefsUpdatedMessage(message);
            YoutubeWatch.onPromoBlocksMessage(message);
        });

        YoutubeWatch.currentVideoId = YoutubeWatch.getWatchVideoId();
        const start = YoutubeWatch.getMainVideo();
        if (start) {
            WatchCaptions.scheduleForVideoId(
                YoutubeWatch.currentVideoId,
                'init',
            );
            YoutubeWatch.bindVideo(start);
        }

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
