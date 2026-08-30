import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeState = vi.hoisted(
    (): { id: string | undefined } => ({ id: 'extension-id' }),
);

const { disposeWatch, initWatch, teardownPageBridge } = vi.hoisted(() => {
    const disposeWatch = vi.fn();
    return {
        disposeWatch,
        initWatch: vi.fn(() => disposeWatch),
        teardownPageBridge: vi.fn(() => Promise.resolve()),
    };
});

vi.mock('@/shared/browser', () => ({
    default: {
        runtime: {
            get id(): string | undefined {
                return runtimeState.id;
            },
        },
    },
}));

vi.mock('@/content/youtube-watch', () => ({
    YoutubeWatch: { init: initWatch },
}));

vi.mock('@/content/watch-captions', () => ({
    WatchCaptions: { teardownPageBridge },
}));

const { debugLogDispose } = vi.hoisted(() => ({ debugLogDispose: vi.fn() }));

vi.mock('@/content/debug-log-client', () => ({
    DebugLogClient: { dispose: debugLogDispose },
}));

import { Content } from '@/content/content';
import { EXTENSION_CONTEXT_POLL_INTERVAL_MS } from '@/content/extension-context-watch';

describe('Content', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        runtimeState.id = 'extension-id';
        disposeWatch.mockClear();
        initWatch.mockClear();
        teardownPageBridge.mockClear();
        debugLogDispose.mockClear();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('disposes the watch and keeps the MAIN bridge when a newer bundle replaces it', () => {
        const dispose = Content.init();
        expect(initWatch).toHaveBeenCalledOnce();

        dispose();
        runtimeState.id = undefined;
        vi.advanceTimersByTime(EXTENSION_CONTEXT_POLL_INTERVAL_MS * 2);

        expect(disposeWatch).toHaveBeenCalledOnce();
        expect(teardownPageBridge).not.toHaveBeenCalled();
        expect(debugLogDispose).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('tears down the orphaned watch and MAIN bridge once the runtime is invalidated', () => {
        Content.init();

        vi.advanceTimersByTime(EXTENSION_CONTEXT_POLL_INTERVAL_MS * 2);
        expect(disposeWatch).not.toHaveBeenCalled();
        expect(teardownPageBridge).not.toHaveBeenCalled();

        runtimeState.id = undefined;
        vi.advanceTimersByTime(EXTENSION_CONTEXT_POLL_INTERVAL_MS);

        expect(disposeWatch).toHaveBeenCalledOnce();
        expect(teardownPageBridge).toHaveBeenCalledOnce();
        expect(debugLogDispose).toHaveBeenCalledOnce();
        expect(debugLogDispose.mock.invocationCallOrder[0]).toBeLessThan(
            disposeWatch.mock.invocationCallOrder[0],
        );
        expect(disposeWatch.mock.invocationCallOrder[0]).toBeLessThan(
            teardownPageBridge.mock.invocationCallOrder[0],
        );

        vi.advanceTimersByTime(EXTENSION_CONTEXT_POLL_INTERVAL_MS * 3);
        expect(disposeWatch).toHaveBeenCalledOnce();
        expect(teardownPageBridge).toHaveBeenCalledOnce();
    });
});
