import { PromoDetectionBroadcast } from '@/background/messaging/broadcast-promo-detection-updated';
import browser from '@/shared/browser';
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
 * `storage.session` key mirroring the in-memory maps across MV3 service-worker
 * restarts. Session storage is trusted-context-only and dies with the browser.
 */
const SESSION_STORAGE_KEY = 'topskipPromoDetectionStore';

/**
 * Structural check for the persisted mirror; payloads are trusted because only
 * this store (a trusted context) writes the key.
 */
const persistedStoreSchema = v.strictObject({
    tabState: v.array(
        v.tuple([v.number(), v.looseObject({ status: v.string() })]),
    ),
    activeServerSession: v.array(v.tuple([v.number(), v.string()])),
    retiredServerSessions: v.array(v.tuple([v.number(), v.array(v.string())])),
});

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
     * Single-flight hydration from `storage.session`; `null` until first use.
     */
    private static hydration: Promise<void> | null = null;

    /**
     * Restores the maps persisted before the last service-worker restart.
     * In-memory entries win over persisted ones: a write that landed before
     * hydration finished is fresher than anything the dead worker saved.
     *
     * @returns Promise that settles once the maps are hydrated
     */
    static ready(): Promise<void> {
        PromoDetectionStore.hydration ??= PromoDetectionStore.hydrate();
        return PromoDetectionStore.hydration;
    }

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
        PromoDetectionStore.persist();
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
        PromoDetectionStore.persist();
    }

    /**
     * Mirrors the maps to `storage.session` after hydration settles, so a
     * pre-hydration write cannot clobber entries the dead worker persisted.
     */
    private static persist(): void {
        void PromoDetectionStore.ready()
            .then(() =>
                browser.storage.session.set({
                    [SESSION_STORAGE_KEY]: {
                        tabState: [...PromoDetectionStore.tabState],
                        activeServerSession: [
                            ...PromoDetectionStore.activeServerSession,
                        ],
                        retiredServerSessions: [
                            ...PromoDetectionStore.retiredServerSessions,
                        ].map(([tabId, sessions]): [number, string[]] => [
                            tabId,
                            [...sessions],
                        ]),
                    },
                }),
            )
            .catch(() => {
                // Session storage unavailable: state stays memory-only.
            });
    }

    /**
     * Loads and validates the persisted mirror; malformed data is dropped.
     *
     * @returns Promise that settles once in-memory maps are merged
     */
    private static async hydrate(): Promise<void> {
        let stored: unknown;
        try {
            const raw = await browser.storage.session.get(SESSION_STORAGE_KEY);
            stored = Reflect.get(raw, SESSION_STORAGE_KEY);
        } catch {
            return;
        }
        const parsed = v.safeParse(persistedStoreSchema, stored);
        if (!parsed.success) {
            return;
        }
        for (const [tabId, state] of parsed.output.tabState) {
            if (!PromoDetectionStore.tabState.has(tabId)) {
                PromoDetectionStore.tabState.set(
                    tabId,
                    state as PromoDetectionStatePayload,
                );
            }
        }
        for (const [tabId, sessionId] of parsed.output.activeServerSession) {
            if (!PromoDetectionStore.activeServerSession.has(tabId)) {
                PromoDetectionStore.activeServerSession.set(tabId, sessionId);
            }
        }
        for (const [tabId, sessions] of parsed.output.retiredServerSessions) {
            if (!PromoDetectionStore.retiredServerSessions.has(tabId)) {
                PromoDetectionStore.retiredServerSessions.set(
                    tabId,
                    new Set(sessions),
                );
            }
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
