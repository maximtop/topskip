/**
 * Emitted file names of the two watch bundles. The manifest composer and the
 * popup-driven re-attach must inject exactly the same files so a re-attached
 * document runs the code a fresh navigation would have received.
 */
export const CONTENT_SCRIPT_BUNDLE = {
    MainBridge: 'caption-page-bridge.js',
    IsolatedWatch: 'content.js',
} as const;
