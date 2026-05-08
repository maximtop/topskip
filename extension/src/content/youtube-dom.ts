/**
 * YouTube DOM selectors and skip-toast timing constants used by the watch
 * content script.
 *
 * Kept co-located in `src/content/` because they are bundle-specific (only
 * the content script touches the YouTube DOM).
 */

/**
 * CSS selector for the YouTube ad overlay element.
 */
export const YOUTUBE_AD_OVERLAY_SELECTOR = '.ytp-ad-player-overlay';

/**
 * CSS selector for the YouTube player container.
 */
export const YOUTUBE_PLAYER_SELECTOR = '#movie_player';

/**
 * CSS selector for the primary `<video>` element inside the player.
 */
export const YOUTUBE_VIDEO_ELEMENT_SELECTOR = `${YOUTUBE_PLAYER_SELECTOR} video`;

/**
 * Skip-toast unique DOM id.
 */
export const SKIP_TOAST_ID = 'topskip-toast';

/**
 * Opacity transition duration (ms) for the skip-toast fade-out animation.
 * When `prefers-reduced-motion` is active, the fade is skipped entirely and
 * the element is removed immediately.
 */
export const SKIP_TOAST_FADE_MS = 200;

/**
 * Total display duration (ms) of the skip-toast before it begins fading out.
 */
export const SKIP_TOAST_DISPLAY_MS = 2500;

/**
 * Poll interval (ms) for the `setInterval` that re-syncs the video-element
 * binding after YouTube SPA navigations replace the `<video>` node.
 */
export const VIDEO_BINDING_POLL_INTERVAL_MS = 500;

/**
 * Bottom offset (px) from the viewport edge for the skip-toast.
 */
export const SKIP_TOAST_BOTTOM_PX = 88;

/**
 * CSS z-index stacking context level above player UI for the toast.
 */
export const SKIP_TOAST_Z_INDEX = 10000;
