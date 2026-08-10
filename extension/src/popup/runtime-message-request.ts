import browser from '@/shared/browser';
import { getErrorMessage } from '@/shared/error';
import type { TopSkipRuntimeMessage } from '@/shared/messages';

/**
 * Bounds popup-to-worker requests so a lost MV3 reply cannot hold UI state
 * indefinitely, while clearing the timer on every ordinary completion path.
 *
 * @param message - Typed runtime message sent to the background worker.
 * @param timeoutMs - Maximum time to wait for the worker reply.
 * @param timeoutErrorMessage - Safe diagnostic used when the bound expires.
 * @returns Opaque worker response before the bounded timeout.
 */
export function requestPopupRuntimeMessage(
    message: TopSkipRuntimeMessage,
    timeoutMs: number,
    timeoutErrorMessage: string,
): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const timeoutId = globalThis.setTimeout(() => {
            reject(new Error(timeoutErrorMessage));
        }, timeoutMs);
        let request: Promise<unknown>;
        try {
            request = browser.runtime.sendMessage(message);
        } catch (error) {
            globalThis.clearTimeout(timeoutId);
            reject(
                error instanceof Error
                    ? error
                    : new Error(getErrorMessage(error)),
            );
            return;
        }
        void request.then(
            (response: unknown) => {
                globalThis.clearTimeout(timeoutId);
                resolve(response);
            },
            (error: unknown) => {
                globalThis.clearTimeout(timeoutId);
                reject(
                    error instanceof Error
                        ? error
                        : new Error(getErrorMessage(error)),
                );
            },
        );
    });
}
