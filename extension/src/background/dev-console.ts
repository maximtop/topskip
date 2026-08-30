/**
 * Dev-build-only console mirror for free-form background diagnostics.
 *
 * Holds the `__TOPSKIP_INCLUDE_DEV_LOCAL__` gate in one place, inside the
 * method bodies, so call sites log like a plain logger with no gating
 * argument; in beta/release the define collapses the guard and both
 * methods become no-ops. Unlike an inline define block at the call site,
 * the message literals remain in the production bundle (only the output is
 * suppressed) — fine for these non-sensitive lines. Transcript- or
 * marker-bearing dev logs (promo bundle builders, chunk dumps) must keep
 * their inline define blocks so the release-artifact greps stay clean; do
 * not route them through here.
 */
export class DevConsole {
    /**
     * Prints one info line in dev builds only.
     *
     * @param parts - Console arguments forwarded verbatim.
     */
    static info(...parts: readonly unknown[]): void {
        if (!__TOPSKIP_INCLUDE_DEV_LOCAL__) {
            return;
        }
        console.info(...parts);
    }

    /**
     * Prints one warn line in dev builds only.
     *
     * @param parts - Console arguments forwarded verbatim.
     */
    static warn(...parts: readonly unknown[]): void {
        if (!__TOPSKIP_INCLUDE_DEV_LOCAL__) {
            return;
        }
        console.warn(...parts);
    }
}
