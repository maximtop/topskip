/**
 * Promise-based WebExtension API (`browser.*`) via Mozilla’s polyfill
 * (Chrome uses `chrome.*` under the hood).
 * Import this module instead of using the global `chrome` object in
 * application code.
 */
import browser from 'webextension-polyfill';

export default browser;
