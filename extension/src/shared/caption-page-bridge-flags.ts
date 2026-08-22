/**
 * Page-global names the MAIN caption bridge uses to find and retire a previous
 * instance. The background reads the install flag before re-attaching so an
 * orphaned bundle that is still mid-teardown cannot retire the replacement.
 */
export const CAPTION_PAGE_BRIDGE_INSTALL_FLAG = '__topskipCaptionCaptureInstalled';

/**
 * Teardown hook published by the currently installed MAIN bridge.
 */
export const CAPTION_PAGE_BRIDGE_TEARDOWN_FLAG = '__topskipCaptionCaptureTeardown';
