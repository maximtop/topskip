import { expect, vi, type MockInstance } from 'vitest';

/**
 * Silenced spies on every console method a TopSkip module may call.
 */
export type ConsoleSpies = {
    log: MockInstance<typeof console.log>;
    info: MockInstance<typeof console.info>;
    debug: MockInstance<typeof console.debug>;
    warn: MockInstance<typeof console.warn>;
    error: MockInstance<typeof console.error>;
};

/**
 * The one console line FR-034 allows per worker start.
 */
const STARTUP_LINE = '[TopSkip] Service worker started';

/**
 * Installs silenced spies on `log/info/debug/warn/error`; restore with
 * `vi.restoreAllMocks()` in `afterEach`.
 *
 * @returns The spies, keyed by method name.
 */
export function spyOnAllConsole(): ConsoleSpies {
    return {
        log: vi.spyOn(console, 'log').mockImplementation(() => {}),
        info: vi.spyOn(console, 'info').mockImplementation(() => {}),
        debug: vi.spyOn(console, 'debug').mockImplementation(() => {}),
        warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
        error: vi.spyOn(console, 'error').mockImplementation(() => {}),
    };
}

/**
 * Asserts release-like console quietness: `info` was called zero times or
 * exactly once with the startup line (and a build label), and no other
 * method was called at all.
 *
 * @param spies - Spies from {@link spyOnAllConsole}.
 */
export function expectOnlyStartupLine(spies: ConsoleSpies): void {
    const infoCalls = spies.info.mock.calls;
    expect(infoCalls.length).toBeLessThanOrEqual(1);
    for (const call of infoCalls) {
        expect(call[0]).toBe(STARTUP_LINE);
        expect(call).toHaveLength(2);
    }
    expect(spies.log).not.toHaveBeenCalled();
    expect(spies.debug).not.toHaveBeenCalled();
    expect(spies.warn).not.toHaveBeenCalled();
    expect(spies.error).not.toHaveBeenCalled();
}
