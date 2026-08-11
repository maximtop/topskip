import { beforeEach, describe, expect, it, vi } from 'vitest';

const { notify, sessionStorageData, sessionGet, sessionSet } = vi.hoisted(
    () => {
        const data: Record<string, unknown> = {};
        return {
            notify: vi.fn(),
            sessionStorageData: data,
            sessionGet: vi.fn(),
            sessionSet: vi.fn(),
        };
    },
);

vi.mock('@/background/messaging/broadcast-promo-detection-updated', () => ({
    PromoDetectionBroadcast: { notify },
}));

vi.mock('@/shared/browser', () => ({
    default: {
        storage: {
            session: { get: sessionGet, set: sessionSet },
        },
    },
}));

import { PromoDetectionStore } from '@/background/promo-detection-store';
import type { PromoDetectionStatePayload } from '@/shared/messages';

const SESSION_STORAGE_KEY = 'topskipPromoDetectionStore';
const TAB_ID = 42;
const OTHER_TAB_ID = 84;
const VIDEO_ID = 'dQw4w9WgXcQ';
const SESSION_A = '00000000-0000-4000-8000-000000000001';
const SESSION_B = '00000000-0000-4000-8000-000000000002';

/**
 * Restores the ordinary in-memory implementation after tests replace a
 * storage method with a deferred or rejected operation.
 *
 * @returns Nothing.
 */
function restoreSessionStorageMocks(): void {
    sessionGet.mockImplementation((key: string) =>
        Promise.resolve(
            key in sessionStorageData
                ? { [key]: sessionStorageData[key] }
                : {},
        ),
    );
    sessionSet.mockImplementation((items: Record<string, unknown>) => {
        Object.assign(sessionStorageData, items);
        return Promise.resolve();
    });
}

/**
 * Simulates an MV3 service-worker restart while keeping the mocked
 * `storage.session` backing object alive.
 *
 * @returns Freshly evaluated store module.
 */
async function restartWorker(): Promise<typeof PromoDetectionStore> {
    vi.resetModules();
    const mod = await import('@/background/promo-detection-store');
    return mod.PromoDetectionStore;
}

/**
 * Advances enough promise reactions to distinguish an immediate no-op return
 * from one blocked on a deliberately unresolved persistence write.
 *
 * @returns Promise resolved after two microtask checkpoints.
 */
async function flushPromiseReactions(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe('PromoDetectionStore Server sessions', () => {
    beforeEach(async () => {
        restoreSessionStorageMocks();
        await PromoDetectionStore.clear(TAB_ID);
        await PromoDetectionStore.clear(OTHER_TAB_ID);
        for (const key of Object.keys(sessionStorageData)) {
            delete sessionStorageData[key];
        }
        vi.clearAllMocks();
    });

    it('never broadcasts a backward phase or a stale session', async () => {
        const acquisitionA = {
            videoId: VIDEO_ID,
            status: 'analyzing',
            source: 'server',
            sessionId: SESSION_A,
            serverAnalysisPhase: 'caption_acquisition',
        } as const;
        const analysisA = {
            ...acquisitionA,
            serverAnalysisPhase: 'server_analysis',
        } as const;
        const terminalA = {
            videoId: VIDEO_ID,
            status: 'detected',
            source: 'server_cache',
            sessionId: SESSION_A,
            promoBlocks: [{ startSec: 10, endSec: 20 }],
        } satisfies PromoDetectionStatePayload;
        const acquisitionB = {
            ...acquisitionA,
            sessionId: SESSION_B,
        } as const;
        const analysisB = {
            ...analysisA,
            sessionId: SESSION_B,
        } as const;
        const terminalB = {
            ...terminalA,
            sessionId: SESSION_B,
        } satisfies PromoDetectionStatePayload;

        await PromoDetectionStore.set(TAB_ID, acquisitionA);
        await PromoDetectionStore.set(TAB_ID, analysisA);
        await PromoDetectionStore.set(TAB_ID, acquisitionA);
        expect(PromoDetectionStore.get(TAB_ID)).toEqual(analysisA);

        await PromoDetectionStore.set(TAB_ID, terminalA);
        await PromoDetectionStore.set(TAB_ID, analysisA);
        await PromoDetectionStore.set(TAB_ID, analysisB);
        expect(PromoDetectionStore.get(TAB_ID)).toEqual(terminalA);

        await PromoDetectionStore.set(TAB_ID, acquisitionB);
        await PromoDetectionStore.set(TAB_ID, terminalA);
        await PromoDetectionStore.set(TAB_ID, terminalB);
        expect(PromoDetectionStore.get(TAB_ID)).toEqual(terminalB);
        expect(notify).toHaveBeenCalledTimes(5);
    });

    it('preserves the originating tab id across two-tab broadcasts', async () => {
        const first = {
            videoId: VIDEO_ID,
            status: 'no_promo',
        } satisfies PromoDetectionStatePayload;
        const second = {
            videoId: 'otherVideo',
            status: 'detected',
            promoBlocks: [{ startSec: 4, endSec: 9 }],
        } satisfies PromoDetectionStatePayload;

        await PromoDetectionStore.set(TAB_ID, first);
        await PromoDetectionStore.set(OTHER_TAB_ID, second);
        await PromoDetectionStore.clear(OTHER_TAB_ID);

        expect(notify.mock.calls).toEqual([
            [TAB_ID, first],
            [OTHER_TAB_ID, second],
            [OTHER_TAB_ID, null],
        ]);
    });

    it('rejects malformed Server fields and clears only the matching session', async () => {
        const acquisition = {
            videoId: VIDEO_ID,
            status: 'analyzing',
            source: 'server',
            sessionId: SESSION_B,
            serverAnalysisPhase: 'caption_acquisition',
        } as const;
        await PromoDetectionStore.set(TAB_ID, acquisition);

        const malformedStates = [
            {
                videoId: VIDEO_ID,
                status: 'analyzing',
                source: 'server',
                serverAnalysisPhase: 'caption_acquisition',
            },
            {
                videoId: VIDEO_ID,
                status: 'detected',
                source: 'server_cache',
                sessionId: SESSION_B,
                serverAnalysisPhase: 'server_analysis',
                promoBlocks: [{ startSec: 1, endSec: 2 }],
            },
            {
                videoId: VIDEO_ID,
                status: 'analyzing',
                source: 'local_provider',
                sessionId: SESSION_B,
            },
        ];
        const setMethod = Reflect.get(PromoDetectionStore, 'set');
        if (typeof setMethod !== 'function') {
            throw new Error('Expected detection store setter.');
        }
        for (const malformed of malformedStates) {
            await Reflect.apply(setMethod, PromoDetectionStore, [
                TAB_ID,
                malformed,
            ]);
        }
        expect(PromoDetectionStore.get(TAB_ID)).toEqual(acquisition);

        const clearMethod = Reflect.get(PromoDetectionStore, 'clear');
        if (typeof clearMethod !== 'function') {
            throw new Error('Expected detection store clear method.');
        }
        await Reflect.apply(clearMethod, PromoDetectionStore, [
            TAB_ID,
            SESSION_A,
        ]);
        expect(PromoDetectionStore.get(TAB_ID)).toEqual(acquisition);
        await Reflect.apply(clearMethod, PromoDetectionStore, [
            TAB_ID,
            SESSION_B,
        ]);
        expect(PromoDetectionStore.get(TAB_ID)).toBeNull();
    });

    it('keeps the first terminal state and ignores later terminal updates', async () => {
        const terminal = {
            videoId: VIDEO_ID,
            status: 'detected',
            source: 'server',
            sessionId: SESSION_A,
            promoBlocks: [{ startSec: 10, endSec: 20 }],
        } satisfies PromoDetectionStatePayload;

        await PromoDetectionStore.set(TAB_ID, {
            videoId: VIDEO_ID,
            status: 'analyzing',
            source: 'server',
            sessionId: SESSION_A,
            serverAnalysisPhase: 'caption_acquisition',
        });
        await PromoDetectionStore.set(TAB_ID, terminal);
        vi.clearAllMocks();
        await PromoDetectionStore.set(TAB_ID, {
            videoId: VIDEO_ID,
            status: 'no_promo',
            source: 'server',
            sessionId: SESSION_A,
        });

        expect(sessionSet).not.toHaveBeenCalled();
        expect(notify).not.toHaveBeenCalled();
        expect(PromoDetectionStore.get(TAB_ID)).toEqual(terminal);
    });

    it('accepts terminal as the first observable state for a new session', async () => {
        const terminal = {
            videoId: VIDEO_ID,
            status: 'no_promo',
            source: 'server',
            sessionId: SESSION_A,
        } satisfies PromoDetectionStatePayload;

        await PromoDetectionStore.set(TAB_ID, terminal);
        await PromoDetectionStore.set(TAB_ID, {
            videoId: VIDEO_ID,
            status: 'analyzing',
            source: 'server',
            sessionId: SESSION_A,
            serverAnalysisPhase: 'caption_acquisition',
        });

        expect(PromoDetectionStore.get(TAB_ID)).toEqual(terminal);
        expect(notify).toHaveBeenCalledOnce();
    });

    it('accepts analysis before acquisition without later regression', async () => {
        const analysis = {
            videoId: VIDEO_ID,
            status: 'analyzing',
            source: 'server',
            sessionId: SESSION_A,
            serverAnalysisPhase: 'server_analysis',
        } as const;

        await PromoDetectionStore.set(TAB_ID, analysis);
        await PromoDetectionStore.set(TAB_ID, {
            videoId: VIDEO_ID,
            status: 'analyzing',
            source: 'server',
            sessionId: SESSION_A,
            serverAnalysisPhase: 'caption_acquisition',
        });

        expect(PromoDetectionStore.get(TAB_ID)).toEqual(analysis);
        expect(notify).toHaveBeenCalledOnce();
    });
});

describe('PromoDetectionStore persistence across worker restarts', () => {
    beforeEach(async () => {
        restoreSessionStorageMocks();
        await PromoDetectionStore.clear(TAB_ID);
        for (const key of Object.keys(sessionStorageData)) {
            delete sessionStorageData[key];
        }
        vi.clearAllMocks();
    });

    it('rehydrates the last snapshot after a restart', async () => {
        const terminal = {
            videoId: VIDEO_ID,
            status: 'detected',
            source: 'server',
            sessionId: SESSION_A,
            promoBlocks: [{ startSec: 10, endSec: 20 }],
        } satisfies PromoDetectionStatePayload;
        await PromoDetectionStore.set(TAB_ID, {
            videoId: VIDEO_ID,
            status: 'analyzing',
            source: 'server',
            sessionId: SESSION_A,
            serverAnalysisPhase: 'caption_acquisition',
        });
        await PromoDetectionStore.set(TAB_ID, terminal);

        const FreshStore = await restartWorker();
        expect(FreshStore.get(TAB_ID)).toBeNull();
        await FreshStore.ready();
        expect(FreshStore.get(TAB_ID)).toEqual(terminal);
    });

    it('accepts a terminal snapshot after a mid-analysis restart', async () => {
        await PromoDetectionStore.set(TAB_ID, {
            videoId: VIDEO_ID,
            status: 'analyzing',
            source: 'server',
            sessionId: SESSION_A,
            serverAnalysisPhase: 'caption_acquisition',
        });
        await PromoDetectionStore.set(TAB_ID, {
            videoId: VIDEO_ID,
            status: 'analyzing',
            source: 'server',
            sessionId: SESSION_A,
            serverAnalysisPhase: 'server_analysis',
        });

        const FreshStore = await restartWorker();
        const terminal = {
            videoId: VIDEO_ID,
            status: 'detected',
            source: 'server',
            sessionId: SESSION_A,
            promoBlocks: [{ startSec: 10, endSec: 20 }],
        } satisfies PromoDetectionStatePayload;
        await FreshStore.set(TAB_ID, terminal);
        expect(FreshStore.get(TAB_ID)).toEqual(terminal);

        await FreshStore.set(TAB_ID, {
            videoId: VIDEO_ID,
            status: 'analyzing',
            source: 'server',
            sessionId: SESSION_A,
            serverAnalysisPhase: 'caption_acquisition',
        });
        expect(FreshStore.get(TAB_ID)).toEqual(terminal);
    });

    it('accepts a terminal-first update when hydration retained its session', async () => {
        sessionStorageData[SESSION_STORAGE_KEY] = {
            tabState: [],
            activeServerSession: [[TAB_ID, SESSION_A]],
            retiredServerSessions: [],
        };
        const FreshStore = await restartWorker();
        const terminal = {
            videoId: VIDEO_ID,
            status: 'no_promo',
            source: 'server',
            sessionId: SESSION_A,
        } satisfies PromoDetectionStatePayload;

        await FreshStore.set(TAB_ID, terminal);

        expect(FreshStore.get(TAB_ID)).toEqual(terminal);
    });

    it('clears a persisted tab only after deferred hydration completes', async () => {
        const persisted = {
            tabState: [
                [
                    TAB_ID,
                    {
                        videoId: VIDEO_ID,
                        status: 'analyzing',
                        source: 'server',
                        sessionId: SESSION_A,
                        serverAnalysisPhase: 'server_analysis',
                    },
                ],
            ],
            activeServerSession: [[TAB_ID, SESSION_A]],
            retiredServerSessions: [],
        };
        sessionStorageData[SESSION_STORAGE_KEY] = persisted;
        let resolveHydration = (): void => undefined;
        sessionGet.mockImplementationOnce(
            () =>
                new Promise<Record<string, unknown>>((resolve) => {
                    resolveHydration = (): void => {
                        resolve({ [SESSION_STORAGE_KEY]: persisted });
                    };
                }),
        );
        const FreshStore = await restartWorker();
        let clearSettled = false;

        const pendingClear = FreshStore.clear(TAB_ID).then(() => {
            clearSettled = true;
        });
        await vi.waitFor(() => {
            expect(sessionGet).toHaveBeenCalledOnce();
        });
        await flushPromiseReactions();
        const settledBeforeHydration = clearSettled;
        resolveHydration();
        await pendingClear;

        expect(settledBeforeHydration).toBe(false);
        expect(FreshStore.get(TAB_ID)).toBeNull();
        expect(sessionStorageData[SESSION_STORAGE_KEY]).toEqual({
            tabState: [],
            activeServerSession: [],
            retiredServerSessions: [],
        });
    });

    it('waits for persistence before broadcasting a hydrated update', async () => {
        sessionStorageData[SESSION_STORAGE_KEY] = {
            tabState: [],
            activeServerSession: [[TAB_ID, SESSION_A]],
            retiredServerSessions: [],
        };
        let releaseWrite = (): void => undefined;
        sessionSet.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    releaseWrite = resolve;
                }),
        );
        const FreshStore = await restartWorker();
        const pending = FreshStore.set(TAB_ID, {
            videoId: VIDEO_ID,
            status: 'no_promo',
            source: 'server',
            sessionId: SESSION_A,
        });
        await vi.waitFor(() => {
            expect(sessionSet).toHaveBeenCalledOnce();
        });

        expect(notify).not.toHaveBeenCalled();
        releaseWrite();
        await pending;

        expect(notify).toHaveBeenCalledOnce();
        expect(sessionSet.mock.invocationCallOrder[0]).toBeLessThan(
            notify.mock.invocationCallOrder[0] ?? 0,
        );
    });

    it('serializes snapshots so a slow older write cannot win', async () => {
        const writes: Record<string, unknown>[] = [];
        let releaseFirstWrite = (): void => undefined;
        sessionSet.mockImplementation((items: Record<string, unknown>) => {
            writes.push(structuredClone(items));
            if (writes.length === 1) {
                return new Promise<void>((resolve) => {
                    releaseFirstWrite = resolve;
                });
            }
            Object.assign(sessionStorageData, items);
            return Promise.resolve();
        });
        const acquisition = {
            videoId: VIDEO_ID,
            status: 'analyzing',
            source: 'server',
            sessionId: SESSION_A,
            serverAnalysisPhase: 'caption_acquisition',
        } as const;
        const terminal = {
            videoId: VIDEO_ID,
            status: 'detected',
            source: 'server',
            sessionId: SESSION_A,
            promoBlocks: [{ startSec: 10, endSec: 20 }],
        } satisfies PromoDetectionStatePayload;

        const firstUpdate = PromoDetectionStore.set(TAB_ID, acquisition);
        await vi.waitFor(() => {
            expect(sessionSet).toHaveBeenCalledOnce();
        });
        const secondUpdate = PromoDetectionStore.set(TAB_ID, terminal);
        await Promise.resolve();
        expect(sessionSet).toHaveBeenCalledOnce();

        releaseFirstWrite();
        await Promise.all([firstUpdate, secondUpdate]);

        expect(sessionSet).toHaveBeenCalledTimes(2);
        expect(writes[0]).not.toEqual(writes[1]);
        expect(PromoDetectionStore.get(TAB_ID)).toEqual(terminal);
    });

    it('holds a duplicate terminal ack until the first write settles', async () => {
        await PromoDetectionStore.set(TAB_ID, {
            videoId: VIDEO_ID,
            status: 'analyzing',
            source: 'server',
            sessionId: SESSION_A,
            serverAnalysisPhase: 'caption_acquisition',
        });
        vi.clearAllMocks();
        let releaseWrite = (): void => undefined;
        sessionSet.mockImplementationOnce(
            (items: Record<string, unknown>) =>
                new Promise<void>((resolve) => {
                    releaseWrite = (): void => {
                        Object.assign(sessionStorageData, items);
                        resolve();
                    };
                }),
        );
        const terminal = {
            videoId: VIDEO_ID,
            status: 'detected',
            source: 'server',
            sessionId: SESSION_A,
            promoBlocks: [{ startSec: 10, endSec: 20 }],
        } satisfies PromoDetectionStatePayload;

        const firstUpdate = PromoDetectionStore.set(TAB_ID, terminal);
        await vi.waitFor(() => {
            expect(sessionSet).toHaveBeenCalledOnce();
        });
        let duplicateSettled = false;
        const duplicateUpdate = PromoDetectionStore.set(TAB_ID, {
            ...terminal,
            promoBlocks: [{ startSec: 10, endSec: 20 }],
        }).then(() => {
            duplicateSettled = true;
        });
        await flushPromiseReactions();

        const settledBeforeRelease = duplicateSettled;
        const broadcastBeforeRelease = notify.mock.calls.length;
        releaseWrite();
        await Promise.all([firstUpdate, duplicateUpdate]);

        expect(settledBeforeRelease).toBe(false);
        expect(broadcastBeforeRelease).toBe(0);
        expect(duplicateSettled).toBe(true);
        expect(sessionSet).toHaveBeenCalledOnce();
        expect(notify).toHaveBeenCalledOnce();
    });

    it('holds a duplicate clear ack until the first write settles', async () => {
        await PromoDetectionStore.set(TAB_ID, {
            videoId: VIDEO_ID,
            status: 'no_promo',
        });
        vi.clearAllMocks();
        let releaseWrite = (): void => undefined;
        sessionSet.mockImplementationOnce(
            (items: Record<string, unknown>) =>
                new Promise<void>((resolve) => {
                    releaseWrite = (): void => {
                        Object.assign(sessionStorageData, items);
                        resolve();
                    };
                }),
        );

        const firstClear = PromoDetectionStore.clear(TAB_ID);
        await vi.waitFor(() => {
            expect(sessionSet).toHaveBeenCalledOnce();
        });
        let duplicateSettled = false;
        const duplicateClear = PromoDetectionStore.clear(TAB_ID).then(() => {
            duplicateSettled = true;
        });
        await flushPromiseReactions();

        const settledBeforeRelease = duplicateSettled;
        const broadcastBeforeRelease = notify.mock.calls.length;
        releaseWrite();
        await Promise.all([firstClear, duplicateClear]);

        expect(settledBeforeRelease).toBe(false);
        expect(broadcastBeforeRelease).toBe(0);
        expect(duplicateSettled).toBe(true);
        expect(sessionSet).toHaveBeenCalledOnce();
        expect(notify).toHaveBeenCalledOnce();
    });

    it('broadcasts from memory when session storage is unavailable', async () => {
        sessionSet.mockRejectedValueOnce(new Error('storage unavailable'));
        const state = {
            videoId: VIDEO_ID,
            status: 'no_promo',
        } satisfies PromoDetectionStatePayload;

        await expect(
            PromoDetectionStore.set(TAB_ID, state),
        ).resolves.toBeUndefined();

        expect(PromoDetectionStore.get(TAB_ID)).toEqual(state);
        expect(notify).toHaveBeenCalledWith(TAB_ID, state);
    });

    it('drops malformed persisted data instead of hydrating it', async () => {
        sessionStorageData[SESSION_STORAGE_KEY] = {
            tabState: 'corrupted',
        };
        const FreshStore = await restartWorker();
        await FreshStore.ready();
        expect(FreshStore.get(TAB_ID)).toBeNull();
    });

    it('hydrates before applying a newer write', async () => {
        await PromoDetectionStore.set(TAB_ID, {
            videoId: VIDEO_ID,
            status: 'detected',
            source: 'server',
            sessionId: SESSION_A,
            promoBlocks: [{ startSec: 10, endSec: 20 }],
        });

        const FreshStore = await restartWorker();
        const fresh = {
            videoId: VIDEO_ID,
            status: 'no_promo',
        } satisfies PromoDetectionStatePayload;
        await FreshStore.set(TAB_ID, fresh);
        expect(FreshStore.get(TAB_ID)).toEqual(fresh);
    });
});
