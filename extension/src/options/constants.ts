/**
 * Bounded re-read cadence for the Diagnostics status while the section is
 * visible. The spec caps it at five seconds; the status read is cheap and
 * never carries the preview tail or the bundle.
 */
export const OPTIONS_DIAGNOSTICS_REFRESH_MS = 5_000;

/**
 * Bounds one status or preview read so a lost MV3 reply cannot hang the
 * Diagnostics section.
 */
export const OPTIONS_DIAGNOSTICS_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Bounds the on-click bundle snapshot read for Copy/Download so the clipboard
 * write or anchor click still happens inside the browser's
 * transient-activation window.
 */
export const OPTIONS_DIAGNOSTICS_BUNDLE_TIMEOUT_MS = 3_000;

/**
 * Object URLs are revoked only once the browser had ample time to start the
 * download they back.
 */
export const OPTIONS_DOWNLOAD_URL_REVOKE_DELAY_MS = 60_000;

/**
 * `options.html#<section>` deep links carry the section id after this prefix;
 * the page reads the hash once on load and never writes it.
 */
export const OPTIONS_SECTION_HASH_PREFIX = '#';
