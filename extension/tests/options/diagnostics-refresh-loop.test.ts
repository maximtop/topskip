import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
    type Mock,
} from 'vitest';

import { OPTIONS_DIAGNOSTICS_REFRESH_MS } from '@/options/constants';
import {
    DiagnosticsRefreshLoop,
    type DiagnosticsRefreshReads,
    type DiagnosticsRefreshSink,
} from '@/options/diagnostics-refresh-loop';
import type { DebugLogStatusPayload } from '@/shared/messages';

// The loop's default reads import `@/options/diagnostics-request`, which pulls
// in `@/shared/browser` (webextension-polyfill throws when loaded outside an
// extension). Every test injects fake reads, so a minimal stub suffices.
vi.mock('@/shared/browser', () => ({
    default: { runtime: { sendMessage: vi.fn() } },
}));

const STATUS: DebugLogStatusPayload = {
    enabled: true,
    hasLog: true,
    enabledAtMs: 1_755_856_800_000,
    disabledAtMs: null,
    eventCount: 1,
    sizeBytes: 80,
    capBytes: 5 * 1024 * 1024,
    evictedCount: 0,
    oldestRetainedMs: 1_755_856_800_000,
    dropped: { incognito: 0, coalesced: 0, ceiling: 0, unreachable: 0, lost: 0 },
    revision: 1,
};
const PREVIEW = { text: 'line\n', shownBytes: 5, totalBytes: 5, revision: 1 };

type Spy = ReturnType<typeof vi.fn>;

type LoopHarness = {
    loop: DiagnosticsRefreshLoop;
    // The read mocks carry the real signatures so `mockImplementationOnce`
    // callbacks returning a Promise satisfy no-misused-promises (a bare
    // `vi.fn()` types its implementation as void-returning in Vitest 4).
    reads: {
        requestStatus: Mock<DiagnosticsRefreshReads['requestStatus']>;
        requestPreview: Mock<DiagnosticsRefreshReads['requestPreview']>;
    };
    sink: { onStatus: Spy; onPreview: Spy; onUnavailable: Spy };
};

/**
 * Builds a loop over scripted reads and spy sinks.
 *
 * @returns Loop plus its spies.
 */
function makeLoop(): LoopHarness {
    const reads = {
        requestStatus: vi.fn<DiagnosticsRefreshReads['requestStatus']>(),
        requestPreview: vi.fn<DiagnosticsRefreshReads['requestPreview']>(),
    };
    const sink = {
        onStatus: vi.fn(),
        onPreview: vi.fn(),
        onUnavailable: vi.fn(),
    };
    const typedReads: DiagnosticsRefreshReads = reads;
    const typedSink: DiagnosticsRefreshSink = sink;
    return {
        loop: new DiagnosticsRefreshLoop(typedSink, typedReads),
        reads,
        sink,
    };
}

describe('DiagnosticsRefreshLoop', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('reads status then the preview on the first refresh', async () => {
        const { loop, reads, sink } = makeLoop();
        reads.requestStatus.mockResolvedValue(STATUS);
        reads.requestPreview.mockResolvedValue(PREVIEW);

        loop.refreshNow();
        await vi.advanceTimersByTimeAsync(0);

        expect(sink.onStatus).toHaveBeenCalledWith(STATUS);
        expect(sink.onPreview).toHaveBeenCalledWith(PREVIEW);
        expect(reads.requestPreview).toHaveBeenCalledTimes(1);
        loop.stop();
    });

    it('polls at the bounded cadence and skips the preview while the revision is unchanged', async () => {
        const { loop, reads, sink } = makeLoop();
        reads.requestStatus.mockResolvedValue(STATUS);
        reads.requestPreview.mockResolvedValue(PREVIEW);
        loop.refreshNow();
        await vi.advanceTimersByTimeAsync(0);

        await vi.advanceTimersByTimeAsync(OPTIONS_DIAGNOSTICS_REFRESH_MS - 1);
        expect(reads.requestStatus).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(reads.requestStatus).toHaveBeenCalledTimes(2);
        expect(reads.requestPreview).toHaveBeenCalledTimes(1);
        expect(sink.onStatus).toHaveBeenCalledTimes(2);

        reads.requestStatus.mockResolvedValue({ ...STATUS, revision: 2 });
        reads.requestPreview.mockResolvedValue({ ...PREVIEW, revision: 2 });
        await vi.advanceTimersByTimeAsync(OPTIONS_DIAGNOSTICS_REFRESH_MS);
        expect(reads.requestPreview).toHaveBeenCalledTimes(2);
        expect(sink.onPreview).toHaveBeenLastCalledWith({
            ...PREVIEW,
            revision: 2,
        });
        loop.stop();
    });

    it('clears the preview and reads none while no log is stored', async () => {
        const { loop, reads, sink } = makeLoop();
        reads.requestStatus.mockResolvedValue({ ...STATUS, hasLog: false });

        loop.refreshNow();
        await vi.advanceTimersByTimeAsync(0);

        expect(reads.requestPreview).not.toHaveBeenCalled();
        expect(sink.onPreview).toHaveBeenCalledWith(null);
        loop.stop();
    });

    it('reports unavailable on a failed read and keeps polling', async () => {
        const { loop, reads, sink } = makeLoop();
        reads.requestStatus.mockRejectedValueOnce(new Error('timed out'));
        loop.refreshNow();
        await vi.advanceTimersByTimeAsync(0);
        expect(sink.onUnavailable).toHaveBeenCalledTimes(1);

        reads.requestStatus.mockResolvedValue(STATUS);
        reads.requestPreview.mockResolvedValue(PREVIEW);
        await vi.advanceTimersByTimeAsync(OPTIONS_DIAGNOSTICS_REFRESH_MS);
        expect(sink.onStatus).toHaveBeenCalledWith(STATUS);
        loop.stop();
    });

    it('coalesces an explicit refresh with a read in flight into one follow-up', async () => {
        const { loop, reads } = makeLoop();
        let resolveStatus: (status: DebugLogStatusPayload) => void = () => {};
        reads.requestStatus.mockImplementationOnce(
            () =>
                new Promise<DebugLogStatusPayload>((resolve) => {
                    resolveStatus = resolve;
                }),
        );
        reads.requestStatus.mockResolvedValue({ ...STATUS, hasLog: false });

        loop.refreshNow();
        loop.refreshNow();
        loop.refreshNow();
        expect(reads.requestStatus).toHaveBeenCalledTimes(1);

        resolveStatus({ ...STATUS, hasLog: false });
        await vi.advanceTimersByTimeAsync(0);
        expect(reads.requestStatus).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(OPTIONS_DIAGNOSTICS_REFRESH_MS - 1);
        expect(reads.requestStatus).toHaveBeenCalledTimes(2);
        loop.stop();
    });

    it('performs no reads and drops late completions after stop', async () => {
        const { loop, reads, sink } = makeLoop();
        let resolveStatus: (status: DebugLogStatusPayload) => void = () => {};
        reads.requestStatus.mockImplementation(
            () =>
                new Promise<DebugLogStatusPayload>((resolve) => {
                    resolveStatus = resolve;
                }),
        );
        loop.refreshNow();
        loop.stop();
        resolveStatus(STATUS);
        await vi.advanceTimersByTimeAsync(OPTIONS_DIAGNOSTICS_REFRESH_MS * 2);

        expect(sink.onStatus).not.toHaveBeenCalled();
        expect(reads.requestStatus).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);

        loop.refreshNow();
        expect(reads.requestStatus).toHaveBeenCalledTimes(1);
    });
});
