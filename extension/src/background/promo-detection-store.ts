import { PromoDetectionBroadcast } from '@/background/messaging/broadcast-promo-detection-updated';
import browser from '@/shared/browser';
import {
    PROMO_DETECTION_SOURCE,
    SERVER_ANALYSIS_PHASE,
    SERVER_ANALYSIS_TERMINAL_PHASE,
    serverAnalysisSessionIdSchema,
    type PromoDetectionStatePayload,
    type ServerPromoDetectionSource,
} from '@/shared/messages';
import { PROMO_DETECTION_STATUS } from '@topskip/common/promo-types';
import * as v from 'valibot';

const SERVER_DETECTION_SOURCES: ReadonlySet<ServerPromoDetectionSource> =
    new Set([
        PROMO_DETECTION_SOURCE.Server,
        PROMO_DETECTION_SOURCE.LocalCache,
        PROMO_DETECTION_SOURCE.ServerCache,
    ]);
const SERVER_ANALYSIS_STORE_PHASE = {
    ...SERVER_ANALYSIS_PHASE,
    Terminal: SERVER_ANALYSIS_TERMINAL_PHASE,
} as const;
const SERVER_ANALYSIS_PHASE_RANK = {
    [SERVER_ANALYSIS_STORE_PHASE.CaptionAcquisition]: 0,
    [SERVER_ANALYSIS_STORE_PHASE.ServerAnalysis]: 1,
    [SERVER_ANALYSIS_STORE_PHASE.Terminal]: 2,
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
 * Store ordering includes the internal terminal sentinel absent from payloads.
 */
type ServerAnalysisStorePhase =
    (typeof SERVER_ANALYSIS_STORE_PHASE)[keyof typeof SERVER_ANALYSIS_STORE_PHASE];

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
     * Chained writes keep an older snapshot from landing after a newer one.
     */
    private static persistence: Promise<void> = Promise.resolve();

    /**
     * Restores the maps persisted before the last service-worker restart.
     * Mutations await this boundary so the dead worker's last snapshot is
     * always considered before a new transition is accepted.
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
     * Stores a snapshot durably enough for worker restart, then notifies
     * subscribers so popup reads cannot race an older session mirror.
     *
     * @param tabId - Browser tab id
     * @param state - Snapshot to store
     * @returns Promise that settles after persistence and notification
     */
    static async set(
        tabId: number,
        state: PromoDetectionStatePayload,
    ): Promise<void> {
        await PromoDetectionStore.ready();
        if (!PromoDetectionStore.isValidFieldCombination(state)) {
            await PromoDetectionStore.waitForQueuedPersistence();
            return;
        }
        const previous = PromoDetectionStore.tabState.get(tabId);
        const activeSessionBefore =
            PromoDetectionStore.activeServerSession.get(tabId);
        if (PromoDetectionStore.isServerState(state)) {
            if (!PromoDetectionStore.acceptServerTransition(tabId, state)) {
                await PromoDetectionStore.waitForQueuedPersistence();
                return;
            }
        } else {
            PromoDetectionStore.retireActiveSession(tabId);
        }
        const sessionChanged =
            activeSessionBefore !==
            PromoDetectionStore.activeServerSession.get(tabId);
        const stateChanged =
            previous === undefined ||
            !PromoDetectionStore.areStatesEqual(previous, state);
        if (!stateChanged && !sessionChanged) {
            await PromoDetectionStore.waitForQueuedPersistence();
            return;
        }
        if (!stateChanged) {
            await PromoDetectionStore.persist();
            return;
        }
        PromoDetectionStore.tabState.set(tabId, state);
        await PromoDetectionStore.persist();
        PromoDetectionBroadcast.notify(tabId, state);
    }

    /**
     * Drops state when the tab can no longer receive updates.
     *
     * @param tabId - Browser tab id.
     * @param sessionId - Optional Server session that alone may clear its state.
     * @returns Promise that settles after persistence and notification.
     */
    static async clear(tabId: number, sessionId?: string): Promise<void> {
        await PromoDetectionStore.ready();
        if (
            sessionId !== undefined &&
            PromoDetectionStore.activeServerSession.get(tabId) !== sessionId
        ) {
            await PromoDetectionStore.waitForQueuedPersistence();
            return;
        }
        const hadActiveSession =
            PromoDetectionStore.activeServerSession.has(tabId);
        PromoDetectionStore.retireActiveSession(tabId);
        const hadState = PromoDetectionStore.tabState.delete(tabId);
        let removedRetiredSessions = false;
        if (sessionId === undefined) {
            removedRetiredSessions =
                PromoDetectionStore.retiredServerSessions.delete(tabId);
        }
        if (!hadActiveSession && !hadState && !removedRetiredSessions) {
            await PromoDetectionStore.waitForQueuedPersistence();
            return;
        }
        await PromoDetectionStore.persist();
        if (hadState) {
            PromoDetectionBroadcast.notify(tabId, null);
        }
    }

    /**
     * Mirrors one immutable point-in-time snapshot through a serialized queue.
     * Storage is best-effort because memory still drives the current worker.
     *
     * @returns Promise that always resolves after this write attempt.
     */
    private static async persist(): Promise<void> {
        const snapshot = {
            tabState: [...PromoDetectionStore.tabState].map(
                ([tabId, state]): [number, PromoDetectionStatePayload] => [
                    tabId,
                    structuredClone(state),
                ],
            ),
            activeServerSession: [
                ...PromoDetectionStore.activeServerSession,
            ],
            retiredServerSessions: [
                ...PromoDetectionStore.retiredServerSessions,
            ].map(([tabId, sessions]): [number, string[]] => [
                tabId,
                [...sessions],
            ]),
        };
        const write = PromoDetectionStore.persistence.then(async () => {
            try {
                await browser.storage.session.set({
                    [SESSION_STORAGE_KEY]: snapshot,
                });
            } catch {
                // Session storage unavailable: state stays memory-only.
            }
        });
        PromoDetectionStore.persistence = write;
        await write;
    }

    /**
     * Keeps no-op and rejected handler acknowledgements behind any snapshot
     * already queued by a concurrent mutation of the same worker state.
     *
     * @returns The persistence tail captured at this acknowledgement boundary.
     */
    private static waitForQueuedPersistence(): Promise<void> {
        return PromoDetectionStore.persistence;
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
        if (
            state.source === undefined ||
            state.source === PROMO_DETECTION_SOURCE.LocalProvider
        ) {
            return false;
        }
        return SERVER_DETECTION_SOURCES.has(state.source);
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
        if (state.status === PROMO_DETECTION_STATUS.Analyzing) {
            return (
                state.source === PROMO_DETECTION_SOURCE.Server &&
                (rawPhase ===
                    SERVER_ANALYSIS_STORE_PHASE.CaptionAcquisition ||
                    rawPhase === SERVER_ANALYSIS_STORE_PHASE.ServerAnalysis)
            );
        }
        return rawPhase === undefined;
    }

    /**
     * Enforces nondecreasing phases and rejects identities already retired.
     * A terminal may be the first observable update after worker restoration.
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
        if (activeSessionId === undefined) {
            const sessionWasRetired =
                PromoDetectionStore.retiredServerSessions
                    .get(tabId)
                    ?.has(sessionId) === true;
            if (sessionWasRetired) {
                return false;
            }
            PromoDetectionStore.activeServerSession.set(tabId, sessionId);
            return true;
        }
        if (activeSessionId !== sessionId) {
            const startsWithAcquisition =
                phase === SERVER_ANALYSIS_STORE_PHASE.CaptionAcquisition;
            const sessionWasRetired =
                PromoDetectionStore.retiredServerSessions
                    .get(tabId)
                    ?.has(sessionId) === true;
            if (!startsWithAcquisition || sessionWasRetired) {
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
            const canEstablishSessionState =
                phase === SERVER_ANALYSIS_STORE_PHASE.CaptionAcquisition ||
                phase === SERVER_ANALYSIS_STORE_PHASE.Terminal;
            return canEstablishSessionState;
        }
        const currentPhase = PromoDetectionStore.readPhase(current);
        const currentIsTerminal =
            currentPhase === SERVER_ANALYSIS_STORE_PHASE.Terminal;
        if (currentIsTerminal) {
            return false;
        }
        const transitionDoesNotRegress =
            currentPhase !== null &&
            SERVER_ANALYSIS_PHASE_RANK[phase] >=
                SERVER_ANALYSIS_PHASE_RANK[currentPhase];
        return transitionDoesNotRegress;
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
    ): ServerAnalysisStorePhase | null {
        if (state.status !== PROMO_DETECTION_STATUS.Analyzing) {
            return SERVER_ANALYSIS_STORE_PHASE.Terminal;
        }
        const phase: unknown = Reflect.get(state, 'serverAnalysisPhase');
        return phase === SERVER_ANALYSIS_STORE_PHASE.CaptionAcquisition ||
            phase === SERVER_ANALYSIS_STORE_PHASE.ServerAnalysis
            ? phase
            : null;
    }

    /**
     * Compares every serialized UI field without treating object identity or
     * property insertion order as a change.
     *
     * @param left - Current snapshot.
     * @param right - Candidate replacement.
     * @returns Whether both snapshots carry the same serialized value.
     */
    private static areStatesEqual(
        left: PromoDetectionStatePayload,
        right: PromoDetectionStatePayload,
    ): boolean {
        return (
            left.videoId === right.videoId &&
            left.status === right.status &&
            left.source === right.source &&
            left.sessionId === right.sessionId &&
            left.serverAnalysisPhase === right.serverAnalysisPhase &&
            left.durationSec === right.durationSec &&
            left.error === right.error &&
            left.partialCoverage === right.partialCoverage &&
            PromoDetectionStore.arePromoBlocksEqual(
                left.promoBlocks,
                right.promoBlocks,
            ) &&
            PromoDetectionStore.areFailureContextsEqual(
                left.serverFailure,
                right.serverFailure,
            )
        );
    }

    /**
     * Compares the small validated block list retained for popup and playback.
     *
     * @param left - Current optional block list.
     * @param right - Candidate optional block list.
     * @returns Whether block boundaries and confidence labels are equal.
     */
    private static arePromoBlocksEqual(
        left: PromoDetectionStatePayload['promoBlocks'],
        right: PromoDetectionStatePayload['promoBlocks'],
    ): boolean {
        if (left === undefined || right === undefined) {
            return left === right;
        }
        return (
            left.length === right.length &&
            left.every((block, index) => {
                const candidate = right[index];
                return (
                    candidate !== undefined &&
                    block.startSec === candidate.startSec &&
                    block.endSec === candidate.endSec &&
                    block.confidence === candidate.confidence
                );
            })
        );
    }

    /**
     * Compares the allow-listed failure metadata without relying on object key
     * order from independently constructed response mappings.
     *
     * @param left - Current optional failure context.
     * @param right - Candidate optional failure context.
     * @returns Whether every safe diagnostic field is equal.
     */
    private static areFailureContextsEqual(
        left: PromoDetectionStatePayload['serverFailure'],
        right: PromoDetectionStatePayload['serverFailure'],
    ): boolean {
        if (left === undefined || right === undefined) {
            return left === right;
        }
        return (
            left.code === right.code &&
            left.supportId === right.supportId &&
            left.retryAfterSec === right.retryAfterSec &&
            left.apiVersion === right.apiVersion &&
            left.algorithmVersion === right.algorithmVersion &&
            left.extensionVersion === right.extensionVersion &&
            left.supportIssueBaseUrl === right.supportIssueBaseUrl
        );
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
