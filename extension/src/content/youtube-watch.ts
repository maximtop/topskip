import {
  evaluatePromoBlocksSkip,
  resetFiredIndicesOnBackwardSeek,
} from '@/content/promo-skip-logic';
import {
  E2E_HOST,
  getWatchVideoIdFromSearch,
  shouldActivateTopSkip,
} from '@/content/page-guards';
import { contentLog } from '@/content/content-log';
import { WatchCaptions } from '@/content/watch-captions';
import type { UserPreferences } from '@/shared/constants';
import browser from '@/shared/browser';
import { TOPSKIP_MESSAGE } from '@/shared/messages';
import type { PromoBlock } from '@/shared/promo-types';
import { translator } from '@/shared/i18n/translator';

type VideoWithCleanup = HTMLElement & { __topskipCleanup?: () => void };

/**
 * YouTube watch DOM + runtime messaging; not instantiable.
 */
export class YoutubeWatch {
  private constructor() {}

  private static enabled = true;
  private static currentVideoId: string | null = null;
  private static lastTime = 0;
  private static isSeeking = false;
  private static boundVideo: HTMLVideoElement | null = null;
  private static promoBlocks: PromoBlock[] = [];
  private static firedPromoBlockIndices = new Set<number>();

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
    const overlay = document.querySelector('.ytp-ad-player-overlay');
    if (overlay) {
      const style = getComputedStyle(overlay);
      if (style.display !== 'none' && style.visibility !== 'hidden') {
        return true;
      }
    }
    const player = document.querySelector('#movie_player');
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
    const el = document.querySelector('#movie_player video');
    return el instanceof HTMLVideoElement ? el : null;
  }

  /**
   * Brief on-screen confirmation after a skip seek is applied.
   *
   * Uses `role="status"` and `aria-live="polite"` so screen readers announce
   * the skip. Respects `prefers-reduced-motion` by skipping the fade-out
   * transition. Design token values (colors, radius, font) are aligned with
   * the shared theme but hardcoded here because the content bundle must not
   * import Mantine (see AGENTS.md).
   */
  private static showSkipToast(): void {
    const id = 'topskip-toast';
    let root = document.getElementById(id);
    if (!root) {
      root = document.createElement('div');
      root.id = id;
      root.setAttribute('role', 'status');
      root.setAttribute('aria-live', 'polite');
      root.style.cssText = [
        'position:fixed',
        'bottom:88px',
        'left:50%',
        'transform:translateX(-50%)',
        'z-index:10000',
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
        'transition:opacity 200ms ease-out',
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
        }, 200);
      }
    }, 2500);
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
    if (!Number.isFinite(duration) || duration === Number.POSITIVE_INFINITY) {
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
        firedIndices: YoutubeWatch.firedPromoBlockIndices,
      });

      const decision = evaluatePromoBlocksSkip({
        prevTime: prev,
        currentTime,
        duration,
        isSeeking: YoutubeWatch.isSeeking,
        firedIndices: YoutubeWatch.firedPromoBlockIndices,
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
          JSON.stringify([
            ...YoutubeWatch.firedPromoBlockIndices,
          ]),
        );
        YoutubeWatch.firedPromoBlockIndices.add(
          decision.blockIndex,
        );
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
          JSON.stringify([
            ...YoutubeWatch.firedPromoBlockIndices,
          ]),
        );
        resetFiredIndicesOnBackwardSeek({
          currentTime: video.currentTime,
          prevTime: YoutubeWatch.lastTime,
          blocks: YoutubeWatch.promoBlocks,
          firedIndices:
            YoutubeWatch.firedPromoBlockIndices,
        });
        contentLog.info(
          'after reset fired=',
          JSON.stringify([
            ...YoutubeWatch.firedPromoBlockIndices,
          ]),
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

    (video as VideoWithCleanup).__topskipCleanup = () => {
      video.removeEventListener('seeking', onSeeking);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('timeupdate', onTu);
    };
  }

  /**
   * Removes listeners from the previously bound video, if any.
   */
  private static unbindVideo(): void {
    if (!YoutubeWatch.boundVideo) {
      return;
    }
    const bound = YoutubeWatch.boundVideo as VideoWithCleanup;
    const cleanup = bound.__topskipCleanup;
    cleanup?.();
    bound.__topskipCleanup = undefined;
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
    YoutubeWatch.firedPromoBlockIndices.clear();
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
      WatchCaptions.scheduleForVideoId(vid);
      if (video) {
        YoutubeWatch.bindVideo(video);
      }
      return;
    }

    if (video && YoutubeWatch.boundVideo !== video) {
      contentLog.info(
        'video element swap detected, rebinding',
      );
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
        /* keep default enabled */
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
    if (!message || typeof message !== 'object') {
      return;
    }
    const m = message as {
      type?: string;
      videoId?: string;
      promoBlocks?: PromoBlock[];
    };
    if (m.type !== TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED) {
      return;
    }
    if (typeof m.videoId !== 'string' || !Array.isArray(m.promoBlocks)) {
      contentLog.warn(
        'PROMO_BLOCKS_DETECTED: bad payload',
        { videoId: m.videoId, blocks: m.promoBlocks },
      );
      return;
    }
    if (m.videoId !== YoutubeWatch.currentVideoId) {
      contentLog.warn(
        'PROMO_BLOCKS_DETECTED: videoId mismatch',
        { msg: m.videoId, current: YoutubeWatch.currentVideoId },
      );
      return;
    }
    contentLog.info(
      'blocks received',
      m.promoBlocks.length,
      'blocks for',
      m.videoId,
      JSON.stringify(m.promoBlocks),
    );
    YoutubeWatch.promoBlocks = m.promoBlocks;
    YoutubeWatch.firedPromoBlockIndices.clear();
  }

  /**
   * Updates `enabled` when the background broadcasts PREFS_UPDATED.
   *
   * @param message Runtime message payload.
   */
  private static onPrefsUpdatedMessage(message: unknown): void {
    if (!message || typeof message !== 'object') {
      return;
    }
    const m = message as { type?: string; prefs?: UserPreferences };
    if (
      m.type === TOPSKIP_MESSAGE.PREFS_UPDATED &&
      m.prefs &&
      typeof m.prefs.enabled === 'boolean'
    ) {
      YoutubeWatch.enabled = m.prefs.enabled;
    }
  }

  /**
   * Wires SPA hooks, video binding, and runtime messaging for prefs.
   */
  static init(): void {
    YoutubeWatch.loadEnabledFromBackground();
    browser.runtime.onMessage.addListener((message: unknown) => {
      YoutubeWatch.onPrefsUpdatedMessage(message);
      YoutubeWatch.onPromoBlocksMessage(message);
    });

    YoutubeWatch.currentVideoId = YoutubeWatch.getWatchVideoId();
    const start = YoutubeWatch.getMainVideo();
    if (start) {
      YoutubeWatch.bindVideo(start);
    }
    WatchCaptions.scheduleForVideoId(YoutubeWatch.currentVideoId);

    const onNav = (): void => {
      YoutubeWatch.syncVideoBinding();
    };

    window.addEventListener('popstate', onNav);
    window.addEventListener('yt-navigate-finish', onNav as EventListener);

    setInterval(() => {
      YoutubeWatch.syncVideoBinding();
    }, 500);
  }
}
