import { PromoDetectionBroadcast } from '@/background/messaging/broadcast-promo-detection-updated';
import {
    serverAnalysisSessionIdSchema,
    type PromoDetectionStatePayload,
} from '@/shared/messages';
import * as v from 'valibot';

const SERVER_DETECTION_SOURCES = new Set([
    'server',
    'local_cache',
    'server_cache',
]);
const SERVER_ANALYSIS_PHASE_RANK = {
    caption_acquisition: 0,
    server_analysis: 1,
    terminal: 2,
} as const;
const MAX_RETIRED_SERVER_SESSIONS_PER_TAB = 32;

/**
 * Pending phases exclude the terminal rank used only inside the store.
 */
type ServerAnalysisPhase = keyof Omit<
    typeof SERVER_ANALYSIS_PHASE_RANK,
    'terminal'
>;

/**
 * In-memory promo detection snapshots keyed by browser tab id (background
 * only).
 */
export class PromoDetectionStore {
    /**
     * Latest promo detection payload keyed by tab id (memory-only).
     */
    private static readonly tabState = new Map<
        number,
        PromoDetectionStatePayload
    >();

    /**
     * Active session identity lets the store reject late same-video completions.
     */
    private static readonly activeServerSession = new Map<number, string>();

    /**
     * Retired identities prevent a completed or cancelled session from restarting.
     */
    private static readonly retiredServerSessions = new Map<
        number,
        Set<string>
    >();

    /**
     * Returns the last promo detection payload published for a tab.
     *
     * @param tabId - Browser tab id
     * @returns Last known detection snapshot for the tab, or `null`
     */
    static get(tabId: number): PromoDetectionStatePayload | null {
        return PromoDetectionStore.tabState.get(tabId) ?? null;
    }

    /**
     * Stores a snapshot and notifies subscribers (e.g. popup).
     *
     * @param tabId - Browser tab id
     * @param state - Snapshot to store
     */
    static set(tabId: number, state: PromoDetectionStatePayload): void {
        if (!PromoDetectionStore.isValidFieldCombination(state)) {
            return;
        }
        if (PromoDetectionStore.isServerState(state)) {
            if (!PromoDetectionStore.acceptServerTransition(tabId, state)) {
                return;
            }
        } else {
            PromoDetectionStore.retireActiveSession(tabId);
        }
        PromoDetectionStore.tabState.set(tabId, state);
        PromoDetectionBroadcast.notify(state);
    }

    /**
     * Drops state when the tab can no longer receive updates.
     *
     * @param tabId - Browser tab id.
     * @param sessionId - Optional Server session that alone may clear its state.
     */
    static clear(tabId: number, sessionId?: string): void {
        if (
            sessionId !== undefined &&
            PromoDetectionStore.activeServerSession.get(tabId) !== sessionId
        ) {
            return;
        }
        PromoDetectionStore.retireActiveSession(tabId);
        PromoDetectionStore.tabState.delete(tabId);
        PromoDetectionBroadcast.notify(null);
        if (sessionId === undefined) {
            PromoDetectionStore.retiredServerSessions.delete(tabId);
        }
    }

    /**
     * Recognizes states produced by the Server route, including its exact local cache.
     *
     * @param state - Candidate background snapshot.
     * @returns Whether session ordering applies to the state.
     */
    private static isServerState(state: PromoDetectionStatePayload): boolean {
        return (
            state.source !== undefined &&
            SERVER_DETECTION_SOURCES.has(state.source)
        );
    }

    /**
     * Rejects optional-field combinations that would make phase ordering ambiguous.
     *
     * @param state - Candidate background snapshot.
     * @returns Whether Server and BYOK fields form one coherent state.
     */
    private static isValidFieldCombination(
        state: PromoDetectionStatePayload,
    ): boolean {
        const rawSessionId: unknown = Reflect.get(state, 'sessionId');
        const rawPhase: unknown = Reflect.get(state, 'serverAnalysisPhase');
        if (!PromoDetectionStore.isServerState(state)) {
            return rawSessionId === undefined && rawPhase === undefined;
        }
        if (!v.safeParse(serverAnalysisSessionIdSchema, rawSessionId).success) {
            return false;
        }
        if (state.status === 'analyzing') {
            return (
                state.source === 'server' &&
                (rawPhase === 'caption_acquisition' ||
                    rawPhase === 'server_analysis')
            );
        }
        return rawPhase === undefined;
    }

    /**
     * Enforces acquisition-first replacement and nondecreasing phases per session.
     *
     * @param tabId - Browser tab owning the state.
     * @param state - Valid Server snapshot.
     * @returns Whether the transition may replace the current snapshot.
     */
    private static acceptServerTransition(
        tabId: number,
        state: PromoDetectionStatePayload,
    ): boolean {
        const sessionId = PromoDetectionStore.readSessionId(state);
        const phase = PromoDetectionStore.readPhase(state);
        if (sessionId === null || phase === null) {
            return false;
        }
        const activeSessionId =
            PromoDetectionStore.activeServerSession.get(tabId);
        if (activeSessionId !== sessionId) {
            if (
                phase !== 'caption_acquisition' ||
                PromoDetectionStore.retiredServerSessions
                    .get(tabId)
                    ?.has(sessionId) === true
            ) {
                return false;
            }
            PromoDetectionStore.retireActiveSession(tabId);
            PromoDetectionStore.activeServerSession.set(tabId, sessionId);
            return true;
        }

        const current = PromoDetectionStore.tabState.get(tabId);
        if (
            current === undefined ||
            !PromoDetectionStore.isServerState(current)
        ) {
            return phase === 'caption_acquisition';
        }
        const currentPhase = PromoDetectionStore.readPhase(current);
        return (
            currentPhase !== null &&
            SERVER_ANALYSIS_PHASE_RANK[phase] >=
                SERVER_ANALYSIS_PHASE_RANK[currentPhase]
        );
    }

    /**
     * Reads a validated Server session without trusting compile-time callers.
     *
     * @param state - Candidate Server snapshot.
     * @returns Valid UUID or `null`.
     */
    private static readSessionId(
        state: PromoDetectionStatePayload,
    ): string | null {
        const parsed = v.safeParse(
            serverAnalysisSessionIdSchema,
            Reflect.get(state, 'sessionId'),
        );
        return parsed.success ? parsed.output : null;
    }

    /**
     * Maps pending snapshots onto their explicit phase and all others to terminal.
     *
     * @param state - Valid Server snapshot.
     * @returns Ordered phase or `null` for malformed runtime input.
     */
    private static readPhase(
        state: PromoDetectionStatePayload,
    ): ServerAnalysisPhase | 'terminal' | null {
        if (state.status !== 'analyzing') {
            return 'terminal';
        }
        const phase: unknown = Reflect.get(state, 'serverAnalysisPhase');
        return phase === 'caption_acquisition' || phase === 'server_analysis'
            ? phase
            : null;
    }

    /**
     * Moves the current identity to the stale set before route replacement.
     *
     * @param tabId - Browser tab whose active Server session ends.
     * @returns Nothing.
     */
    private static retireActiveSession(tabId: number): void {
        const active = PromoDetectionStore.activeServerSession.get(tabId);
        if (active === undefined) {
            return;
        }
        const retired =
            PromoDetectionStore.retiredServerSessions.get(tabId) ?? new Set();
        retired.add(active);
        if (retired.size > MAX_RETIRED_SERVER_SESSIONS_PER_TAB) {
            const oldest = retired.values().next().value;
            if (oldest !== undefined) {
                retired.delete(oldest);
            }
        }
        PromoDetectionStore.retiredServerSessions.set(tabId, retired);
        PromoDetectionStore.activeServerSession.delete(tabId);
    }
}
