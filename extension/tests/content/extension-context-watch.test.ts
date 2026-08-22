import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtimeState = vi.hoisted(
    (): { id: string | undefined; throwOnRead: boolean } => ({
        id: 'extension-id',
        throwOnRead: false,
    }),
);

vi.mock('@/shared/browser', () => ({
    default: {
        runtime: {
            get id(): string | undefined {
                if (runtimeState.throwOnRead) {
                    throw new Error('Extension context invalidated.');
                }
                return runtimeState.id;
            },
        },
    },
}));

import {
    EXTENSION_CONTEXT_POLL_INTERVAL_MS,
    ExtensionContextWatch,
} from '@/content/extension-context-watch';

describe('ExtensionContextWatch', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        runtimeState.id = 'extension-id';
        runtimeState.throwOnRead = false;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('treats a missing runtime id as an invalidated context', () => {
        expect(ExtensionContextWatch.isInvalidated()).toBe(false);
        runtimeState.id = undefined;
        expect(ExtensionContextWatch.isInvalidated()).toBe(true);
        runtimeState.id = '';
        expect(ExtensionContextWatch.isInvalidated()).toBe(true);
    });

    it('treats a throwing runtime access as an invalidated context', () => {
        runtimeState.throwOnRead = true;
        expect(ExtensionContextWatch.isInvalidated()).toBe(true);
    });

    it('notifies once after invalidation and stops polling', () => {
        const onInvalidated = vi.fn();
        ExtensionContextWatch.start(onInvalidated);

        vi.advanceTimersByTime(EXTENSION_CONTEXT_POLL_INTERVAL_MS * 3);
        expect(onInvalidated).not.toHaveBeenCalled();

        runtimeState.id = undefined;
        vi.advanceTimersByTime(EXTENSION_CONTEXT_POLL_INTERVAL_MS);
        expect(onInvalidated).toHaveBeenCalledOnce();

        vi.advanceTimersByTime(EXTENSION_CONTEXT_POLL_INTERVAL_MS * 3);
        expect(onInvalidated).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('stops polling when a replacement bundle disposes the watch', () => {
        const onInvalidated = vi.fn();
        const stop = ExtensionContextWatch.start(onInvalidated);

        stop();
        stop();
        runtimeState.id = undefined;
        vi.advanceTimersByTime(EXTENSION_CONTEXT_POLL_INTERVAL_MS * 2);

        expect(onInvalidated).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});
