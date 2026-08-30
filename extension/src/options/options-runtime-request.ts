import browser from '@/shared/browser';
import { getErrorMessage } from '@/shared/error';
import type { TopSkipRuntimeMessage } from '@/shared/messages';

const OPTIONS_RUNTIME_REQUEST_TIMEOUT_ERROR =
    'Options runtime request timed out.';

/**
 * Bounds options-page requests to the worker so a lost MV3 reply cannot keep
 * the Diagnostics section pending, clearing the timer on every ordinary
 * completion path. Mirrors the popup helper on purpose: the two page bundles
 * do not import each other and `shared/` holds no timers.
 *
 * @param message - Typed runtime message sent to the background worker.
 * @param timeoutMs - Maximum time to wait for the worker reply.
 * @returns Opaque worker response before the bounded timeout.
 */
export function requestOptionsRuntimeMessage(
    message: TopSkipRuntimeMessage,
    timeoutMs: number,
): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const timeoutId = globalThis.setTimeout(() => {
            reject(new Error(OPTIONS_RUNTIME_REQUEST_TIMEOUT_ERROR));
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
