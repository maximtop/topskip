/**
 * Dev-build-only console mirror for free-form background diagnostics.
 *
 * Keeps the `__TOPSKIP_INCLUDE_DEV_LOCAL__` gate in one place (as the
 * trailing default, mirroring the server-analysis dev logs) so call sites
 * stay unconditional and beta/release builds stay quiet. Unlike an inline
 * `if (__TOPSKIP_INCLUDE_DEV_LOCAL__)` block, the message literals remain
 * in the production bundle (only the output is suppressed) — fine for
 * these non-sensitive lines. Transcript- or marker-bearing dev logs (promo
 * bundle builders, chunk dumps) must keep their inline define blocks so
 * the release-artifact greps stay clean; do not route them through here.
 */
export class DevConsole {
    /**
     * Prints one info line in dev builds only.
     *
     * @param parts - Console arguments forwarded verbatim.
     * @param enabled - Optional test override for the compile-time dev gate.
     */
    static info(
        parts: readonly unknown[],
        enabled = __TOPSKIP_INCLUDE_DEV_LOCAL__,
    ): void {
        if (!enabled) {
            return;
        }
        console.info(...parts);
    }

    /**
     * Prints one warn line in dev builds only.
     *
     * @param parts - Console arguments forwarded verbatim.
     * @param enabled - Optional test override for the compile-time dev gate.
     */
    static warn(
        parts: readonly unknown[],
        enabled = __TOPSKIP_INCLUDE_DEV_LOCAL__,
    ): void {
        if (!enabled) {
            return;
        }
        console.warn(...parts);
    }
}
