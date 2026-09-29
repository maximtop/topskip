/**
 * @file Ambient declarations for the build-time globals Rspack's
 * `DefinePlugin` injects (see `rspack.config.ts`); these names are a wire
 * format shared with background/content runtime code across the extension.
 */

/**
 * Injected by Rspack `DefinePlugin` from `TOPSKIP_BUILD`
 * (see `rspack.config.ts`).
 */
declare const TOPSKIP_INCLUDE_DEV_LOCAL: boolean;

/**
 * Compile-time gate for detailed caption acquisition diagnostics.
 */
declare const TOPSKIP_CAPTION_CAPTURE_VERBOSE_LOGS: boolean;

/**
 * Backend origin selected by the Rspack build profile.
 */
declare const TOPSKIP_SERVER_BASE_URL: string;

/**
 * Local E2E fixture origin compiled into dev bundles only; `null` in
 * beta/release so no loopback endpoint literal ships.
 */
declare const TOPSKIP_DEV_E2E_ORIGIN: string | null;

/**
 * Compile-time gate for the Chrome built-in AI provider. Off by default; see
 * `INCLUDE_CHROME_BUILTIN_PROVIDER` in `extension/build-modes.ts` for the
 * measurements behind that decision.
 */
declare const TOPSKIP_INCLUDE_CHROME_BUILTIN: boolean;
