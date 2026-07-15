/**
 * Serializes popup status reads while preserving one coalesced follow-up.
 */
export class DetectionRefreshGuard {
    /**
     * A reserved coalesced follow-up counts as in flight before it starts.
     */
    private refreshInFlight = false;

    /**
     * Repeated interval and broadcast signals collapse into this one bit.
     */
    private followUpQueued = false;

    /**
     * Coalesced reads are ordered and must publish periodically even when each
     * request is slower than the polling interval.
     */
    private currentIsCoalescedFollowUp = false;

    /**
     * Successful reads make later transport failures non-destructive.
     */
    private hasSuccessfulSnapshot = false;

    /**
     * Starts a read or queues one follow-up when another read owns the slot.
     *
     * @returns Whether the caller should start a status read immediately.
     */
    requestRefresh(): boolean {
        if (this.refreshInFlight) {
            this.followUpQueued = true;
            return false;
        }

        this.refreshInFlight = true;
        this.currentIsCoalescedFollowUp = false;
        return true;
    }

    /**
     * Releases the current slot or reserves it for the one queued follow-up.
     * An ordinary superseded result stays hidden, while an already-coalesced
     * result is applied to prevent perpetual starvation under slow reads.
     *
     * @returns Whether to apply this completion and run a queued follow-up.
     */
    completeRefresh(): {
        applyCompletion: boolean;
        runFollowUp: boolean;
    } {
        const runFollowUp = this.followUpQueued;
        const applyCompletion = !runFollowUp || this.currentIsCoalescedFollowUp;

        this.followUpQueued = false;
        this.refreshInFlight = runFollowUp;
        this.currentIsCoalescedFollowUp = runFollowUp;

        return { applyCompletion, runFollowUp };
    }

    /**
     * Records that popup state now has a trustworthy background snapshot.
     */
    markSuccessfulSnapshot(): void {
        this.hasSuccessfulSnapshot = true;
    }

    /**
     * Keeps a transient refresh failure from replacing a trustworthy snapshot.
     *
     * @returns Whether the popup has never loaded a successful snapshot.
     */
    shouldSurfaceFailure(): boolean {
        return !this.hasSuccessfulSnapshot;
    }
}
