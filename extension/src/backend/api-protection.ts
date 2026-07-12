import { MS_PER_SECOND } from '@/shared/constants';

const LOCAL_RATE_LIMIT_WINDOW_MS = 60_000;
const LOCAL_COLD_JOB_START_LIMIT = 2;

/**
 * Cost classes keep cheap lookups from consuming expensive-work capacity.
 */
export const BACKEND_REQUEST_COST_CLASS = {
    CacheLookup: 'cache_lookup',
    JobJoin: 'job_join',
    ColdJobStart: 'cold_job_start',
} as const;

/**
 * Request cost classes used by the local backend protection hook.
 */
type BackendRequestCostClass =
    (typeof BACKEND_REQUEST_COST_CLASS)[keyof typeof BACKEND_REQUEST_COST_CLASS];

/**
 * Protection decisions are retryable only when the cold-start bucket is full.
 */
type BackendProtectionDecision =
    | { allowed: true; costClass: BackendRequestCostClass }
    | {
          allowed: false;
          costClass: typeof BACKEND_REQUEST_COST_CLASS.ColdJobStart;
          retryAfterSec: number;
      };

/**
 * Owns local API cost accounting and fixed-window cold-start limits; static API only.
 */
export class BackendApiProtection {
    /**
     * A zero value lets the first request define the active local window.
     */
    private static windowStartedAtMs = 0;

    /**
     * Cheap cache diagnostics prove cache hits do not spend cold-start quota.
     */
    private static cacheLookups = 0;

    /**
     * Cheap join diagnostics prove duplicate requests do not spend cold-start quota.
     */
    private static jobJoins = 0;

    /**
     * Cold starts are bounded because they represent future extraction/model work.
     */
    private static coldJobStarts = 0;

    /**
     * Evaluates and records a local request cost class.
     *
     * @param input - Request cost class and the time used for fixed-window accounting.
     * @returns Allow/deny decision for the local backend request.
     */
    static evaluate(input: {
        costClass: BackendRequestCostClass;
        nowMs: number;
    }): BackendProtectionDecision {
        BackendApiProtection.rollWindow(input.nowMs);

        if (input.costClass === BACKEND_REQUEST_COST_CLASS.CacheLookup) {
            BackendApiProtection.cacheLookups += 1;
            return { allowed: true, costClass: input.costClass };
        }

        if (input.costClass === BACKEND_REQUEST_COST_CLASS.JobJoin) {
            BackendApiProtection.jobJoins += 1;
            return { allowed: true, costClass: input.costClass };
        }

        if (BackendApiProtection.coldJobStarts >= LOCAL_COLD_JOB_START_LIMIT) {
            return {
                allowed: false,
                costClass: input.costClass,
                retryAfterSec: BackendApiProtection.retryAfterSec(input.nowMs),
            };
        }

        BackendApiProtection.coldJobStarts += 1;
        return { allowed: true, costClass: input.costClass };
    }

    /**
     * Clears process-local counters so unit tests stay independent.
     */
    static resetForTests(): void {
        BackendApiProtection.windowStartedAtMs = 0;
        BackendApiProtection.cacheLookups = 0;
        BackendApiProtection.jobJoins = 0;
        BackendApiProtection.coldJobStarts = 0;
    }

    /**
     * Exposes diagnostics used to verify cost classes remain separate.
     *
     * @returns Current local protection counters.
     */
    static snapshotForTests(): {
        cacheLookups: number;
        jobJoins: number;
        coldJobStarts: number;
    } {
        return {
            cacheLookups: BackendApiProtection.cacheLookups,
            jobJoins: BackendApiProtection.jobJoins,
            coldJobStarts: BackendApiProtection.coldJobStarts,
        };
    }

    /**
     * Starts a fresh local window when the current one has expired.
     *
     * @param nowMs - Timestamp used for deterministic fixed-window tests.
     */
    private static rollWindow(nowMs: number): void {
        if (
            BackendApiProtection.windowStartedAtMs !== 0 &&
            nowMs - BackendApiProtection.windowStartedAtMs <
                LOCAL_RATE_LIMIT_WINDOW_MS
        ) {
            return;
        }

        BackendApiProtection.windowStartedAtMs = nowMs;
        BackendApiProtection.cacheLookups = 0;
        BackendApiProtection.jobJoins = 0;
        BackendApiProtection.coldJobStarts = 0;
    }

    /**
     * Converts the remaining fixed-window duration into retry metadata.
     *
     * @param nowMs - Timestamp used for deterministic retry calculations.
     * @returns Positive retry delay in seconds.
     */
    private static retryAfterSec(nowMs: number): number {
        const windowEndsAtMs =
            BackendApiProtection.windowStartedAtMs + LOCAL_RATE_LIMIT_WINDOW_MS;
        const remainingSec = Math.ceil(
            (windowEndsAtMs - nowMs) / MS_PER_SECOND,
        );
        return Math.max(1, remainingSec);
    }
}
