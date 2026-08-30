import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const storage = await vi.hoisted(async () => {
    const { createMemoryStorageArea } = await import(
        '../../helpers/memory-storage-area',
    );
    return { local: createMemoryStorageArea() };
});

vi.mock('@/shared/browser', () => ({
    default: {
        storage: {
            local: {
                get: storage.local.get,
                set: storage.local.set,
                remove: storage.local.remove,
                setAccessLevel: vi.fn().mockResolvedValue(undefined),
            },
        },
    },
}));

import { DebugLogStore } from '@/background/debug-log/debug-log-store';
import {
    BYTES_PER_KIB,
    STORAGE_KEY_DEBUG_LOG_INDEX,
    STORAGE_KEY_DEBUG_LOG_PREFIX,
    STORAGE_KEY_DEBUG_LOG_SEGMENT_PREFIX,
    STORAGE_KEY_DEBUG_LOG_SWITCH,
} from '@/shared/constants';
import {
    DEBUG_LOG_CAP_BYTES,
    DEBUG_LOG_FLUSH_DEBOUNCE_MS,
    DEBUG_LOG_FLUSH_MAX_PENDING_EVENTS,
    DEBUG_LOG_MEMORY_TAIL_LIMIT,
    DEBUG_LOG_PERSISTED_OVERHEAD_BYTES,
    DEBUG_LOG_PREVIEW_TAIL_BYTES,
    DEBUG_LOG_SEGMENT_MAX_BYTES,
    DEBUG_LOG_STORE_VERSION,
} from '@/shared/debug-log-constants';
import { utf8ByteLength } from '@/shared/debug-log-format';
import { DEV_DEBUG_LOG_SEED_STATE } from '@/shared/messages';
import { spyOnAllConsole } from '../../helpers/console-spy';

/**
 * SC-007: the store never touches the network — every describe block in this
 * file installs this spy and asserts it stayed idle.
 */
const fetchSpy = vi.fn();

const NOW_MS = 1_900_000_000_000;
const SWITCH_KEY = STORAGE_KEY_DEBUG_LOG_SWITCH;
const INDEX_KEY = STORAGE_KEY_DEBUG_LOG_INDEX;
const ZERO_DROPPED = {
    incognito: 0,
    coalesced: 0,
    ceiling: 0,
    unreachable: 0,
    lost: 0,
};

/**
 * Persisted shape read back from the memory storage in assertions.
 */
type StoredIndex = {
    segments: { id: number; bytes: number; count: number; firstTsMs: number }[];
    nextSegmentId: number;
    retiredSegmentIds: number[];
    eventCount: number;
    sizeBytes: number;
    evictedCount: number;
    revision: number;
};

/**
 * The store is format-agnostic; any text works as a line in these tests.
 */
function line(text: string, n = 0): string {
    return `${new Date(NOW_MS + n).toISOString()} w0#${n} bg ${text}`;
}

/**
 * Storage key of one segment, mirroring the store's private helper.
 */
function segmentKey(id: number): string {
    return `${STORAGE_KEY_DEBUG_LOG_SEGMENT_PREFIX}${id}`;
}

/**
 * Every persisted key that belongs to the debug log.
 */
function debugLogKeys(): string[] {
    return Object.keys(storage.local.data).filter((key) =>
        key.startsWith(STORAGE_KEY_DEBUG_LOG_PREFIX),
    );
}

/**
 * Approximates Chrome's accounting: JSON-serialized key plus value length.
 */
function persistedDebugLogBytes(): number {
    return debugLogKeys().reduce(
        (sum, key) =>
            sum +
            utf8ByteLength(JSON.stringify(key)) +
            utf8ByteLength(JSON.stringify(storage.local.data[key])),
        0,
    );
}

/**
 * Reads the persisted index for structural assertions.
 */
function storedIndex(): StoredIndex {
    return storage.local.data[INDEX_KEY] as StoredIndex;
}

/**
 * Accounted size definition from the spec: UTF-8 bytes of every line plus one
 * newline terminator per line.
 */
function accountedBytes(lines: readonly string[]): number {
    return lines.length === 0 ? 0 : utf8ByteLength(`${lines.join('\n')}\n`);
}

/**
 * Valid persisted index with every counter at its fresh value.
 */
function indexFixture(overrides: Partial<StoredIndex> = {}): Record<string, unknown> {
    return {
        version: DEBUG_LOG_STORE_VERSION,
        enabledAtMs: NOW_MS,
        disabledAtMs: null,
        eventCount: 0,
        sizeBytes: 0,
        evictedCount: 0,
        oldestRetainedMs: null,
        dropped: { ...ZERO_DROPPED },
        revision: 1,
        segments: [],
        nextSegmentId: 0,
        retiredSegmentIds: [],
        ...overrides,
    };
}

/**
 * Simulates an MV3 worker restart while the mocked storage survives.
 */
async function restartWorker(): Promise<typeof DebugLogStore> {
    vi.resetModules();
    const mod = await import('@/background/debug-log/debug-log-store');
    return mod.DebugLogStore;
}

/**
 * Hydrates with the release default and turns the switch on.
 */
async function enabledStore(): Promise<void> {
    await DebugLogStore.ready(false);
    await DebugLogStore.enable(NOW_MS);
}

/**
 * Fills an enabled store with 1 KiB lines until one more line would cross the
 * cap; every batch is flushed so the next append evicts exactly one segment and
 * touches at most one segment key.
 */
async function fillToCap(store: typeof DebugLogStore): Promise<string> {
    const filler = line('c'.repeat(1000));
    const fillerBytes = utf8ByteLength(filler) + 1;
    for (;;) {
        const headroom = DEBUG_LOG_CAP_BYTES - store.getStatus().sizeBytes;
        const count = Math.min(100, Math.floor(headroom / fillerBytes));
        if (count === 0) {
            return filler;
        }
        store.append(Array.from({ length: count }, () => filler));
        await store.flush();
    }
}

/**
 * Deterministic PRNG so randomized sequences are reproducible.
 */
function mulberry32(seed: number): () => number {
    let state = seed;
    return () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Random-length line mixing ASCII and multi-byte characters.
 */
function randomLine(rng: () => number, n: number): string {
    const length = 40 + Math.floor(rng() * 1360);
    const alphabet = 'abcdefghij klmnop=qrstuvwxyz0123456789éü😀';
    let body = '';
    while (body.length < length) {
        body += alphabet[Math.floor(rng() * alphabet.length)];
    }
    return line(body, n);
}

describe('DebugLogStore switch and hydration', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        storage.local.reset();
        storage.local.restore();
        fetchSpy.mockReset();
        vi.stubGlobal('fetch', fetchSpy);
        DebugLogStore.resetForTest();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('reports an inert status before hydration and never throws', () => {
        expect(DebugLogStore.isHydrated()).toBe(false);
        expect(DebugLogStore.isEnabled()).toBe(false);
        expect(() => DebugLogStore.append([line('early')])).not.toThrow();
        expect(DebugLogStore.getStatus()).toEqual({
            enabled: false,
            hasLog: false,
            enabledAtMs: null,
            disabledAtMs: null,
            eventCount: 0,
            sizeBytes: 0,
            capBytes: DEBUG_LOG_CAP_BYTES,
            evictedCount: 0,
            oldestRetainedMs: null,
            dropped: ZERO_DROPPED,
            revision: 0,
        });
    });

    it('leaves the profile default pending for the lifecycle while no switch is persisted', async () => {
        await DebugLogStore.ready(true);
        expect(DebugLogStore.isEnabled()).toBe(false);
        expect(DebugLogStore.consumePendingDefaultEnable()).toBe(true);
        expect(DebugLogStore.consumePendingDefaultEnable()).toBe(false);

        const Release = await restartWorker();
        await Release.ready(false);
        expect(Release.consumePendingDefaultEnable()).toBe(false);
        expect(Release.isEnabled()).toBe(false);
    });

    it('lets a persisted switch win over the profile default in both directions', async () => {
        storage.local.data[SWITCH_KEY] = {
            version: DEBUG_LOG_STORE_VERSION,
            enabled: false,
            lastBuildLabel: null,
        };
        await DebugLogStore.ready(true);
        expect(DebugLogStore.consumePendingDefaultEnable()).toBe(false);
        expect(DebugLogStore.isEnabled()).toBe(false);

        storage.local.data[SWITCH_KEY] = {
            version: DEBUG_LOG_STORE_VERSION,
            enabled: true,
            lastBuildLabel: 'dev-1',
        };
        storage.local.data[INDEX_KEY] = indexFixture();
        const On = await restartWorker();
        await On.ready(false);
        expect(On.isEnabled()).toBe(true);
        expect(On.getLastBuildLabel()).toBe('dev-1');
        expect(On.getStatus()).toMatchObject({ enabled: true, enabledAtMs: NOW_MS });
    });

    it('enable creates a fresh log, disable keeps it, and both are idempotent', async () => {
        await DebugLogStore.ready(false);

        const enabled = await DebugLogStore.enable(NOW_MS);
        expect(enabled).toMatchObject({
            enabled: true,
            hasLog: true,
            enabledAtMs: NOW_MS,
            disabledAtMs: null,
            eventCount: 0,
        });
        expect(storage.local.data[SWITCH_KEY]).toMatchObject({ enabled: true });
        DebugLogStore.append([line('first')], NOW_MS);
        await DebugLogStore.flush();

        const again = await DebugLogStore.enable(NOW_MS + 1);
        expect(again).toMatchObject({ eventCount: 1, enabledAtMs: NOW_MS });

        const disabled = await DebugLogStore.disable(NOW_MS + 2);
        expect(disabled).toMatchObject({
            enabled: false,
            hasLog: true,
            eventCount: 1,
            disabledAtMs: NOW_MS + 2,
        });
        DebugLogStore.append([line('ignored')], NOW_MS + 3);
        expect(DebugLogStore.getStatus().eventCount).toBe(1);
        const disabledAgain = await DebugLogStore.disable(NOW_MS + 4);
        expect(disabledAgain.disabledAtMs).toBe(NOW_MS + 2);

        const reenabled = await DebugLogStore.enable(NOW_MS + 5);
        expect(reenabled).toMatchObject({
            eventCount: 0,
            sizeBytes: 0,
            enabledAtMs: NOW_MS + 5,
            disabledAtMs: null,
            evictedCount: 0,
        });
        expect(JSON.stringify(storage.local.data)).not.toContain('first');
    });

    it('runs the marker callbacks synchronously at the switch boundary', async () => {
        await DebugLogStore.ready(false);

        await DebugLogStore.enable(NOW_MS, () => {
            expect(DebugLogStore.isEnabled()).toBe(true);
            DebugLogStore.append([line('logging-enabled')], NOW_MS);
        });
        expect((await DebugLogStore.readSnapshot()).lines).toEqual([
            line('logging-enabled'),
        ]);

        await DebugLogStore.disable(NOW_MS + 1, () => {
            expect(DebugLogStore.isEnabled()).toBe(true);
            DebugLogStore.append([line('logging-disabled')], NOW_MS + 1);
        });
        const snapshot = await DebugLogStore.readSnapshot();
        expect(snapshot.lines).toEqual([
            line('logging-enabled'),
            line('logging-disabled'),
        ]);
        expect(storage.local.data[segmentKey(0)]).toBe(
            `${line('logging-enabled')}\n${line('logging-disabled')}`,
        );
    });

    it('single-flights concurrent enables so the second does not clear the first', async () => {
        await DebugLogStore.ready(false);
        let markers = 0;

        const first = DebugLogStore.enable(NOW_MS, () => {
            markers += 1;
            DebugLogStore.append([line('marker')], NOW_MS);
        });
        const second = DebugLogStore.enable(NOW_MS + 1, () => {
            markers += 1;
        });
        await Promise.all([first, second]);

        expect(markers).toBe(1);
        expect(DebugLogStore.getStatus()).toMatchObject({
            eventCount: 1,
            enabledAtMs: NOW_MS,
        });
    });

    it('bumps the revision on every persisted change', async () => {
        await DebugLogStore.ready(false);
        const r0 = DebugLogStore.getStatus().revision;
        await DebugLogStore.enable(NOW_MS);
        const r1 = DebugLogStore.getStatus().revision;
        expect(r1).toBeGreaterThan(r0);
        DebugLogStore.append([line('a')]);
        const r2 = DebugLogStore.getStatus().revision;
        expect(r2).toBeGreaterThan(r1);
        DebugLogStore.noteDropped('incognito');
        const r3 = DebugLogStore.getStatus().revision;
        expect(r3).toBeGreaterThan(r2);
        await DebugLogStore.disable(NOW_MS + 1);
        const r4 = DebugLogStore.getStatus().revision;
        expect(r4).toBeGreaterThan(r3);
        expect(storedIndex().revision).toBe(r4);
    });

    it('persists the build label without fixing an undecided switch', async () => {
        await DebugLogStore.ready(true);
        await DebugLogStore.setLastBuildLabel('dev-42');
        expect(storage.local.data[SWITCH_KEY]).toEqual({
            version: DEBUG_LOG_STORE_VERSION,
            enabled: null,
            lastBuildLabel: 'dev-42',
        });

        const Fresh = await restartWorker();
        await Fresh.ready(true);
        expect(Fresh.getLastBuildLabel()).toBe('dev-42');
        expect(Fresh.consumePendingDefaultEnable()).toBe(true);
    });

    it('hasLog is true while enabled or while events are stored', async () => {
        await DebugLogStore.ready(false);
        await expect(DebugLogStore.hasLog()).resolves.toBe(false);
        await DebugLogStore.enable(NOW_MS);
        await expect(DebugLogStore.hasLog()).resolves.toBe(true);
        await DebugLogStore.disable(NOW_MS + 1);
        await expect(DebugLogStore.hasLog()).resolves.toBe(false);
        await DebugLogStore.enable(NOW_MS + 2, () => {
            DebugLogStore.append([line('x')]);
        });
        await DebugLogStore.disable(NOW_MS + 3);
        await expect(DebugLogStore.hasLog()).resolves.toBe(true);
    });

    it('falls back to memory-only defaults without console output when storage fails', async () => {
        const spies = spyOnAllConsole();
        storage.local.get.mockRejectedValueOnce(new Error('storage unavailable'));

        await DebugLogStore.ready(false);

        expect(DebugLogStore.isHydrated()).toBe(true);
        expect(DebugLogStore.isEnabled()).toBe(false);
        for (const spy of Object.values(spies)) {
            expect(spy).not.toHaveBeenCalled();
        }
    });

    it('drops malformed switch and index records instead of hydrating them', async () => {
        storage.local.data[SWITCH_KEY] = { version: 'x' };
        storage.local.data[INDEX_KEY] = { nope: true };
        await DebugLogStore.ready(false);
        expect(DebugLogStore.isEnabled()).toBe(false);
        expect(DebugLogStore.getStatus().eventCount).toBe(0);
        expect(DebugLogStore.consumePendingDefaultEnable()).toBe(false);
    });
});

describe('DebugLogStore ring buffer', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        storage.local.reset();
        storage.local.restore();
        fetchSpy.mockReset();
        vi.stubGlobal('fetch', fetchSpy);
        DebugLogStore.resetForTest();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('accounts UTF-8 bytes plus one newline per line exactly', async () => {
        await enabledStore();
        DebugLogStore.append([line('é'), line('😀')]);
        const expected =
            utf8ByteLength(line('é')) + 1 + utf8ByteLength(line('😀')) + 1;
        expect(DebugLogStore.getStatus().sizeBytes).toBe(expected);
        await DebugLogStore.flush();
        expect((await DebugLogStore.readSnapshot()).lines).toEqual([
            line('é'),
            line('😀'),
        ]);
    });

    it('debounces appends into one write and flushes a large burst immediately', async () => {
        await enabledStore();
        storage.local.set.mockClear();
        DebugLogStore.append([line('a')]);
        DebugLogStore.append([line('b')]);
        expect(storage.local.set).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(DEBUG_LOG_FLUSH_DEBOUNCE_MS);
        expect(storage.local.set).toHaveBeenCalledTimes(1);

        const burst = Array.from(
            { length: DEBUG_LOG_FLUSH_MAX_PENDING_EVENTS },
            (_, i) => line('burst', i),
        );
        DebugLogStore.append(burst);
        await vi.advanceTimersByTimeAsync(0);
        expect(storage.local.set).toHaveBeenCalledTimes(2);
        expect(storage.local.data[segmentKey(0)]).toContain(line('burst', 0));
    });

    it('rolls the open segment at the segment bound and rewrites only the tail', async () => {
        await enabledStore();
        const filler = line('x'.repeat(1000));
        const perSegment = Math.floor(
            DEBUG_LOG_SEGMENT_MAX_BYTES / (utf8ByteLength(filler) + 1),
        );
        DebugLogStore.append(Array.from({ length: perSegment + 1 }, () => filler));
        await DebugLogStore.flush();
        expect(storedIndex().segments.map((s) => s.id)).toEqual([0, 1]);
        expect(storedIndex().segments[0]?.count).toBe(perSegment);
        expect(storedIndex().segments[0]?.bytes).toBeLessThanOrEqual(
            DEBUG_LOG_SEGMENT_MAX_BYTES,
        );

        storage.local.set.mockClear();
        DebugLogStore.append([line('tail')]);
        await DebugLogStore.flush();
        expect(storage.local.set).toHaveBeenCalledTimes(1);
        const written = storage.local.set.mock.calls[0]?.[0];
        expect(Object.keys(written).sort()).toEqual([INDEX_KEY, segmentKey(1)].sort());
    });

    it('evicts whole oldest segments at the cap and keeps accounted size exact', async () => {
        await DebugLogStore.ready(false);
        await DebugLogStore.seed(
            {
                state: DEV_DEBUG_LOG_SEED_STATE.On,
                approxBytes: DEBUG_LOG_CAP_BYTES - 8 * BYTES_PER_KIB,
            },
            NOW_MS,
        );
        const before = DebugLogStore.getStatus();
        expect(before.sizeBytes).toBeLessThanOrEqual(DEBUG_LOG_CAP_BYTES);
        expect(before.evictedCount).toBe(0);
        const first = storedIndex().segments[0];
        expect(first).toBeDefined();
        const firstId = first?.id ?? -1;
        const firstCount = first?.count ?? 0;

        const filler = line('y'.repeat(1000));
        DebugLogStore.append(Array.from({ length: 20 }, () => filler), NOW_MS + 1);
        await DebugLogStore.flush();

        const after = DebugLogStore.getStatus();
        expect(after.sizeBytes).toBeLessThanOrEqual(DEBUG_LOG_CAP_BYTES);
        expect(after.evictedCount).toBeGreaterThanOrEqual(firstCount);
        expect(storedIndex().segments[0]?.id).toBeGreaterThan(firstId);
        expect(after.oldestRetainedMs).toBe(storedIndex().segments[0]?.firstTsMs);
        expect(storage.local.data[segmentKey(firstId)]).toBeUndefined();
        expect(storage.local.remove).toHaveBeenCalledWith(
            expect.arrayContaining([segmentKey(firstId)]),
        );

        const snapshot = await DebugLogStore.readSnapshot();
        expect(snapshot.lines).toHaveLength(after.eventCount);
        expect(accountedBytes(snapshot.lines)).toBe(after.sizeBytes);
        expect(snapshot.lines.at(-1)).toBe(filler);
    });

    it('writes at most one segment plus the index when appending at the cap', async () => {
        await enabledStore();
        const filler = await fillToCap(DebugLogStore);
        expect(DebugLogStore.getStatus().evictedCount).toBe(0);
        storage.local.set.mockClear();
        storage.local.remove.mockClear();

        DebugLogStore.append([filler], NOW_MS + 1);
        await DebugLogStore.flush();

        expect(storage.local.set).toHaveBeenCalledTimes(1);
        const written = storage.local.set.mock.calls[0]?.[0];
        const keys = Object.keys(written);
        expect(keys).toContain(INDEX_KEY);
        expect(
            keys.filter((key) => key.startsWith(STORAGE_KEY_DEBUG_LOG_SEGMENT_PREFIX)),
        ).toHaveLength(1);
        expect(storage.local.remove).toHaveBeenCalledTimes(1);
        expect(DebugLogStore.getStatus().evictedCount).toBeGreaterThan(0);
        expect(persistedDebugLogBytes()).toBeLessThanOrEqual(
            DEBUG_LOG_CAP_BYTES + DEBUG_LOG_PERSISTED_OVERHEAD_BYTES,
        );
    });

    it('keeps the accounted size exact and under the cap through randomized appends', async () => {
        await DebugLogStore.ready(false);
        await DebugLogStore.seed(
            {
                state: DEV_DEBUG_LOG_SEED_STATE.On,
                approxBytes: DEBUG_LOG_CAP_BYTES - 16 * BYTES_PER_KIB,
            },
            NOW_MS,
        );
        const rng = mulberry32(7);
        for (let round = 0; round < 30; round += 1) {
            const batch = Array.from(
                { length: 1 + Math.floor(rng() * 40) },
                (_, i) => randomLine(rng, round * 100 + i),
            );
            DebugLogStore.append(batch, NOW_MS + round);
            expect(DebugLogStore.getStatus().sizeBytes).toBeLessThanOrEqual(
                DEBUG_LOG_CAP_BYTES,
            );
            if (round % 5 === 0) {
                await DebugLogStore.flush();
                expect(persistedDebugLogBytes()).toBeLessThanOrEqual(
                    DEBUG_LOG_CAP_BYTES + DEBUG_LOG_PERSISTED_OVERHEAD_BYTES,
                );
            }
        }
        const snapshot = await DebugLogStore.readSnapshot();
        expect(accountedBytes(snapshot.lines)).toBe(snapshot.status.sizeBytes);
        expect(snapshot.lines).toHaveLength(snapshot.status.eventCount);
        expect(snapshot.status.evictedCount).toBeGreaterThan(0);
        expect(persistedDebugLogBytes()).toBeLessThanOrEqual(
            DEBUG_LOG_CAP_BYTES + DEBUG_LOG_PERSISTED_OVERHEAD_BYTES,
        );
    });

    it('never leaves evicted or cleared lines in storage', async () => {
        await enabledStore();
        DebugLogStore.append([line('EVICT_ME_SENTINEL')]);
        const filler = line('z'.repeat(1000));
        const needed = Math.ceil(
            (DEBUG_LOG_CAP_BYTES + DEBUG_LOG_SEGMENT_MAX_BYTES) /
                (utf8ByteLength(filler) + 1),
        );
        for (let written = 0; written < needed; written += 100) {
            DebugLogStore.append(Array.from({ length: 100 }, () => filler));
            await DebugLogStore.flush();
        }
        expect(DebugLogStore.getStatus().evictedCount).toBeGreaterThan(0);
        expect(JSON.stringify(storage.local.data)).not.toContain('EVICT_ME_SENTINEL');

        await DebugLogStore.disable(NOW_MS + 1);
        await DebugLogStore.enable(NOW_MS + 2, () => {
            DebugLogStore.append([line('CLEARED_SENTINEL')]);
        });
        await DebugLogStore.flush();
        expect(JSON.stringify(storage.local.data)).toContain('CLEARED_SENTINEL');
        await DebugLogStore.disable(NOW_MS + 3);
        await DebugLogStore.enable(NOW_MS + 4);
        expect(JSON.stringify(storage.local.data)).not.toContain('CLEARED_SENTINEL');
        expect(debugLogKeys().sort()).toEqual([INDEX_KEY, SWITCH_KEY].sort());
    });

    it('retries a failed write on the next batch, counts tail overflow as lost, stays silent', async () => {
        await enabledStore();
        const spies = spyOnAllConsole();
        storage.local.set.mockRejectedValueOnce(new Error('quota'));
        DebugLogStore.append([line('retry-me')]);
        await DebugLogStore.flush();
        expect(storage.local.data[segmentKey(0)]).toBeUndefined();

        DebugLogStore.append([line('second')]);
        await DebugLogStore.flush();
        expect(storage.local.data[segmentKey(0)]).toBe(
            `${line('retry-me')}\n${line('second')}`,
        );

        storage.local.set.mockRejectedValue(new Error('quota'));
        for (let i = 0; i < DEBUG_LOG_MEMORY_TAIL_LIMIT + 5; i += 1) {
            DebugLogStore.append([line('overflow', i)]);
        }
        expect(DebugLogStore.getStatus().dropped.lost).toBe(5);
        expect(DebugLogStore.getStatus().eventCount).toBe(
            2 + DEBUG_LOG_MEMORY_TAIL_LIMIT,
        );
        await DebugLogStore.flush();
        for (const spy of Object.values(spies)) {
            expect(spy).not.toHaveBeenCalled();
        }

        storage.local.restore();
        await DebugLogStore.flush();
        expect((await DebugLogStore.readSnapshot()).lines).toHaveLength(
            2 + DEBUG_LOG_MEMORY_TAIL_LIMIT,
        );
    });
});

describe('DebugLogStore durability and reads', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        storage.local.reset();
        storage.local.restore();
        fetchSpy.mockReset();
        vi.stubGlobal('fetch', fetchSpy);
        DebugLogStore.resetForTest();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    /**
     * Fills enough 1 KiB lines to close `segments` segments and start another.
     */
    async function fillSegments(store: typeof DebugLogStore, segments: number): Promise<number> {
        const filler = line('f'.repeat(1000));
        const perSegment = Math.floor(
            DEBUG_LOG_SEGMENT_MAX_BYTES / (utf8ByteLength(filler) + 1),
        );
        for (let s = 0; s < segments; s += 1) {
            store.append(Array.from({ length: perSegment }, () => filler));
            await store.flush();
        }
        // `perSegment` fillers leave less than one filler of headroom, so one
        // more filler is what rolls the last segment; the short `after-fill`
        // line alone would still fit and keep it open.
        store.append([filler, line('after-fill')]);
        await store.flush();
        return perSegment;
    }

    it('continues the open segment after a simulated worker restart without losing lines', async () => {
        await enabledStore();
        DebugLogStore.append([line('one'), line('two')]);
        await DebugLogStore.flush();
        const before = DebugLogStore.getStatus();

        const Fresh = await restartWorker();
        await Fresh.ready(false);
        expect(Fresh.getStatus()).toEqual(before);
        Fresh.append([line('three')]);
        await Fresh.flush();

        expect(storedIndex().segments.map((s) => s.id)).toEqual([0]);
        expect((await Fresh.readSnapshot()).lines).toEqual([
            line('one'),
            line('two'),
            line('three'),
        ]);
    });

    it('removes an orphan segment written before its index update and skips its id', async () => {
        await enabledStore();
        DebugLogStore.append([line('a')]);
        await DebugLogStore.flush();
        const orphanId = storedIndex().nextSegmentId;
        storage.local.data[segmentKey(orphanId)] = 'ORPHAN_SENTINEL';

        const Fresh = await restartWorker();
        await Fresh.ready(false);
        expect(storage.local.data[segmentKey(orphanId)]).toBeUndefined();
        await fillSegments(Fresh, 1);
        expect(storedIndex().segments.map((s) => s.id)).toEqual([0, orphanId + 1]);
        expect(JSON.stringify(storage.local.data)).not.toContain('ORPHAN_SENTINEL');
    });

    it('counts a referenced-but-missing tail segment as lost on hydration', async () => {
        await enabledStore();
        DebugLogStore.append([line('a'), line('b')]);
        await DebugLogStore.flush();
        delete storage.local.data[segmentKey(0)];

        const Fresh = await restartWorker();
        await Fresh.ready(false);
        expect(Fresh.getStatus()).toMatchObject({
            eventCount: 0,
            sizeBytes: 0,
        });
        expect(Fresh.getStatus().dropped.lost).toBe(2);
        expect((await Fresh.readSnapshot()).lines).toEqual([]);
    });

    it('counts a missing closed segment as lost when the log is read and repairs the index', async () => {
        await enabledStore();
        const perSegment = await fillSegments(DebugLogStore, 1);
        delete storage.local.data[segmentKey(0)];

        const Fresh = await restartWorker();
        await Fresh.ready(false);
        const snapshot = await Fresh.readSnapshot();
        expect(snapshot.status.dropped.lost).toBe(perSegment);
        expect(snapshot.lines).toHaveLength(snapshot.status.eventCount);
        expect(Fresh.getStatus().eventCount).toBe(snapshot.status.eventCount);
        await Fresh.flush();
        expect(storedIndex().segments.map((s) => s.id)).toEqual([1]);
    });

    it('retries removal of evicted segments whose deletion failed', async () => {
        await enabledStore();
        const filler = await fillToCap(DebugLogStore);
        const firstId = storedIndex().segments[0]?.id ?? -1;
        storage.local.remove.mockRejectedValueOnce(new Error('busy'));

        DebugLogStore.append([filler], NOW_MS + 1);
        await DebugLogStore.flush();
        expect(DebugLogStore.getStatus().evictedCount).toBeGreaterThan(0);
        expect(storage.local.data[segmentKey(firstId)]).toBeDefined();
        expect(storedIndex().retiredSegmentIds).toContain(firstId);

        storage.local.restore();
        DebugLogStore.append([filler], NOW_MS + 2);
        await DebugLogStore.flush();
        expect(storage.local.data[segmentKey(firstId)]).toBeUndefined();
        // The trimmed retired list lands with the next index write.
        DebugLogStore.append([filler], NOW_MS + 3);
        await DebugLogStore.flush();
        expect(storedIndex().retiredSegmentIds).not.toContain(firstId);
    });

    it('returns a consistent snapshot even when lines arrive during the read', async () => {
        await enabledStore();
        await fillSegments(DebugLogStore, 1);
        const original = storage.local.get.getMockImplementation();
        storage.local.get.mockImplementationOnce(async (keys) => {
            DebugLogStore.append([line('late')]);
            return original === undefined ? {} : original(keys);
        });

        const snapshot = await DebugLogStore.readSnapshot();

        expect(snapshot.lines).toHaveLength(snapshot.status.eventCount);
        expect(snapshot.lines).not.toContain(line('late'));
        expect(DebugLogStore.getStatus().eventCount).toBe(snapshot.status.eventCount + 1);
    });

    it('previews only the tail within the byte bound and reports the total size', async () => {
        await enabledStore();
        await fillSegments(DebugLogStore, 3);
        const status = DebugLogStore.getStatus();
        const bound = 10 * BYTES_PER_KIB;

        const preview = await DebugLogStore.readPreview(bound);
        expect(preview.totalBytes).toBe(status.sizeBytes);
        expect(preview.shownBytes).toBeLessThanOrEqual(bound);
        expect(preview.shownBytes).toBe(utf8ByteLength(preview.text));
        expect(preview.text.endsWith(`${line('after-fill')}\n`)).toBe(true);
        expect(preview.revision).toBe(status.revision);

        const full = await DebugLogStore.readPreview(DEBUG_LOG_PREVIEW_TAIL_BYTES);
        expect(full.shownBytes).toBe(full.totalBytes);
    });

    it('seeds each dev state and replaces any previous log', async () => {
        await enabledStore();
        DebugLogStore.append([line('OLD_SENTINEL')]);
        await DebugLogStore.flush();

        await DebugLogStore.seed({ state: DEV_DEBUG_LOG_SEED_STATE.OffEmpty }, NOW_MS);
        expect(DebugLogStore.getStatus()).toMatchObject({
            enabled: false,
            hasLog: false,
            eventCount: 0,
        });
        expect(debugLogKeys()).toEqual([SWITCH_KEY]);
        expect(storage.local.data[SWITCH_KEY]).toMatchObject({ enabled: false });

        await DebugLogStore.seed(
            { state: DEV_DEBUG_LOG_SEED_STATE.OffStored, approxBytes: 4 * BYTES_PER_KIB },
            NOW_MS,
        );
        const stored = DebugLogStore.getStatus();
        expect(stored).toMatchObject({ enabled: false, hasLog: true, disabledAtMs: NOW_MS });
        expect(stored.sizeBytes).toBeGreaterThanOrEqual(4 * BYTES_PER_KIB);
        expect(stored.enabledAtMs).toBeLessThan(NOW_MS);

        await DebugLogStore.seed(
            {
                state: DEV_DEBUG_LOG_SEED_STATE.On,
                approxBytes: 2 * DEBUG_LOG_SEGMENT_MAX_BYTES,
            },
            NOW_MS,
        );
        const on = DebugLogStore.getStatus();
        expect(on).toMatchObject({ enabled: true, disabledAtMs: null });
        expect(storedIndex().segments.length).toBeGreaterThanOrEqual(2);
        expect(JSON.stringify(storage.local.data)).not.toContain('OLD_SENTINEL');
        const snapshot = await DebugLogStore.readSnapshot();
        expect(accountedBytes(snapshot.lines)).toBe(on.sizeBytes);
        expect(snapshot.lines).toHaveLength(on.eventCount);
    });
});
