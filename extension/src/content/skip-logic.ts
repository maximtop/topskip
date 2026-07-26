import { SKIP_END_SEC, SKIP_START_SEC } from '@/shared/constants';

/**
 * Max jump between timeupdates treated as playback (not a seek).
 */
export const MAX_PLAYBACK_DELTA_SEC = 2.75;

/**
 * Result of the legacy fixed-window skip decision.
 */
export type SkipDecision =
    | { action: 'none' }
    | { action: 'skip'; targetTime: number };

/**
 * Target time after skip: min(skip end, duration). Returns null if skip should
 * not run.
 *
 * @param duration Media duration in seconds.
 * @returns Seek target seconds, or `null` when skipping does not apply.
 */
export function computeSkipTarget(duration: number): number | null {
    if (!Number.isFinite(duration) || duration <= 0) {
        return null;
    }
    if (duration < SKIP_START_SEC) {
        return null;
    }
    return Math.min(SKIP_END_SEC, duration);
}

/**
 * Playback state needed to decide whether fixed-window skip should fire.
 */
export type ShouldFireSkipInput = {
    prevTime: number;
    currentTime: number;
    skipFired: boolean;
    enabled: boolean;
    duration: number;
    /**
     * True while the browser is seeking (user scrub or programmatic seek).
     */
    isSeeking: boolean;
};

/**
 * Decide whether to fire the one-time 30→60 skip when crossing SKIP_START_SEC
 * during playback.
 *
 * @param input Previous/current time, duration, enabled flag, and seek state.
 * @returns Whether to skip and the target time, or no action.
 */
export function evaluateSkipOnTimeUpdate(
    input: ShouldFireSkipInput,
): SkipDecision {
    const { prevTime, currentTime, skipFired, enabled, duration, isSeeking } =
        input;

    if (!enabled || skipFired) {
        return { action: 'none' };
    }

    const target = computeSkipTarget(duration);
    if (target === null) {
        return { action: 'none' };
    }

    if (isSeeking) {
        return { action: 'none' };
    }

    const crossed =
        prevTime < SKIP_START_SEC &&
        currentTime >= SKIP_START_SEC &&
        currentTime < SKIP_END_SEC + 0.001;

    if (!crossed) {
        return { action: 'none' };
    }

    const delta = currentTime - prevTime;
    if (delta > MAX_PLAYBACK_DELTA_SEC) {
        return { action: 'none' };
    }

    return { action: 'skip', targetTime: target };
}
