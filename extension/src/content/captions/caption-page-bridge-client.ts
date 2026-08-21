import {
    CAPTION_PAGE_BRIDGE_COMMAND,
    CAPTION_PAGE_BRIDGE_COMMAND_TIMEOUT_MS,
    CAPTION_PAGE_BRIDGE_EVENT,
    CAPTION_PAGE_BRIDGE_KIND,
    CAPTION_PAGE_BRIDGE_PROTOCOL_VERSION,
    CAPTION_PAGE_BRIDGE_SOURCE,
    type CaptionPageBridgeCommand,
    type CaptionPageBridgeCommandRequest,
    parseCaptionPageBridgeCommandResult,
} from '@/content/captions/caption-page-bridge-contract';
import { CAPTION_CAPTURE_FAILURE_REASON } from '@/shared/messages';

const REQUEST_ID_RADIX = 36;
const BRIDGE_UNAVAILABLE_ERROR = 'Caption bridge is unavailable';
const BRIDGE_UNAVAILABLE_RESULT = Object.freeze({
    ok: false,
    reason: CAPTION_CAPTURE_FAILURE_REASON.BridgeInstallFailed,
    error: BRIDGE_UNAVAILABLE_ERROR,
});

/**
 * Cleanup metadata keeps every pending command single-settlement and leak-free.
 */
type PendingCaptionPageBridgeCommand = {
    resolve: (result: unknown) => void;
    timeoutId: ReturnType<typeof globalThis.setTimeout>;
    signal: AbortSignal | undefined;
    abortListener: (() => void) | undefined;
};

/**
 * Correlates the isolated content bundle with the declarative MAIN bridge
 * without involving extension runtime messaging.
 *
 * Static API only.
 */
export class CaptionPageBridgeClient {
    /**
     * One map makes correlation and duplicate suppression the same operation.
     */
    private static readonly pendingCommands =
        new Map<string, PendingCaptionPageBridgeCommand>();

    /**
     * The listener remains installed between commands to avoid accumulating
     * per-request document observers.
     */
    private static resultListenerInstalled = false;

    /**
     * A process-lifetime sequence prevents a late result from matching a new
     * command after `dispose()` in the same document.
     */
    private static nextRequestSequence = 0;

    /**
     * Checks that the declarative MAIN bridge can answer the current protocol.
     *
     * @param signal Optional owner cancellation.
     * @returns Opaque bridge result or a bounded bridge-unavailable failure.
     */
    static probe(signal?: AbortSignal): Promise<unknown> {
        return CaptionPageBridgeClient.sendCommand(
            CAPTION_PAGE_BRIDGE_COMMAND.Probe,
            signal,
        );
    }

    /**
     * Starts one lease-bounded page capture generation.
     *
     * @param signal Optional owner cancellation.
     * @returns Opaque bridge result or a bounded bridge-unavailable failure.
     */
    static activate(signal?: AbortSignal): Promise<unknown> {
        return CaptionPageBridgeClient.sendCommand(
            CAPTION_PAGE_BRIDGE_COMMAND.Activate,
            signal,
        );
    }

    /**
     * Returns the MAIN bridge to dormant mode and restores caption state.
     *
     * @param signal Optional cleanup cancellation.
     * @returns Opaque bridge result or a bounded bridge-unavailable failure.
     */
    static deactivate(signal?: AbortSignal): Promise<unknown> {
        return CaptionPageBridgeClient.sendCommand(
            CAPTION_PAGE_BRIDGE_COMMAND.Deactivate,
            signal,
        );
    }

    /**
     * Retires the MAIN bridge entirely once this ISOLATED context has been
     * orphaned by an extension reload/update, so the page keeps no
     * `fetch`/XHR wrappers from a bundle that can no longer use them.
     *
     * @param signal Optional cleanup cancellation.
     * @returns Opaque bridge result or a bounded bridge-unavailable failure.
     */
    static teardown(signal?: AbortSignal): Promise<unknown> {
        return CaptionPageBridgeClient.sendCommand(
            CAPTION_PAGE_BRIDGE_COMMAND.Teardown,
            signal,
        );
    }

    /**
     * Releases the shared result listener and safely settles every orphaned
     * caller during route teardown.
     */
    static dispose(): void {
        if (
            CaptionPageBridgeClient.resultListenerInstalled &&
            typeof document !== 'undefined'
        ) {
            document.removeEventListener(
                CAPTION_PAGE_BRIDGE_EVENT.CommandResult,
                CaptionPageBridgeClient.onCommandResult,
            );
        }
        CaptionPageBridgeClient.resultListenerInstalled = false;
        const requestIds = Array.from(
            CaptionPageBridgeClient.pendingCommands.keys(),
        );
        for (const requestId of requestIds) {
            CaptionPageBridgeClient.settleCommand(
                requestId,
                BRIDGE_UNAVAILABLE_RESULT,
            );
        }
    }

    /**
     * Stores all cleanup state before dispatch because MAIN may respond during
     * the same JavaScript stack.
     *
     * @param command Lifecycle command accepted by the bridge.
     * @param signal Optional owner cancellation.
     * @returns Opaque bridge result or a bounded bridge-unavailable failure.
     */
    private static sendCommand(
        command: CaptionPageBridgeCommand,
        signal?: AbortSignal,
    ): Promise<unknown> {
        if (
            signal?.aborted === true ||
            typeof document === 'undefined' ||
            typeof CustomEvent === 'undefined' ||
            !CaptionPageBridgeClient.ensureResultListener()
        ) {
            return Promise.resolve(BRIDGE_UNAVAILABLE_RESULT);
        }

        const requestId = CaptionPageBridgeClient.createRequestId();
        const request: CaptionPageBridgeCommandRequest = {
            source: CAPTION_PAGE_BRIDGE_SOURCE.Isolated,
            kind: CAPTION_PAGE_BRIDGE_KIND.Command,
            protocolVersion: CAPTION_PAGE_BRIDGE_PROTOCOL_VERSION,
            requestId,
            command,
        };
        const detail = JSON.stringify(request);

        return new Promise((resolve) => {
            let abortListener: (() => void) | undefined;
            if (signal !== undefined) {
                abortListener = (): void => {
                    CaptionPageBridgeClient.settleCommand(
                        requestId,
                        BRIDGE_UNAVAILABLE_RESULT,
                    );
                };
            }
            const timeoutId = globalThis.setTimeout(() => {
                CaptionPageBridgeClient.settleCommand(
                    requestId,
                    BRIDGE_UNAVAILABLE_RESULT,
                );
            }, CAPTION_PAGE_BRIDGE_COMMAND_TIMEOUT_MS);
            CaptionPageBridgeClient.pendingCommands.set(requestId, {
                resolve,
                timeoutId,
                signal,
                abortListener,
            });
            if (abortListener !== undefined) {
                signal?.addEventListener('abort', abortListener, {
                    once: true,
                });
            }
            if (signal?.aborted === true) {
                abortListener?.();
                return;
            }
            try {
                document.dispatchEvent(
                    new CustomEvent(CAPTION_PAGE_BRIDGE_EVENT.Command, {
                        detail,
                    }),
                );
            } catch {
                CaptionPageBridgeClient.settleCommand(
                    requestId,
                    BRIDGE_UNAVAILABLE_RESULT,
                );
            }
        });
    }

    /**
     * Installs the sole shared result observer before any command is emitted.
     *
     * @returns Whether the local document channel is available.
     */
    private static ensureResultListener(): boolean {
        if (CaptionPageBridgeClient.resultListenerInstalled) {
            return true;
        }
        try {
            document.addEventListener(
                CAPTION_PAGE_BRIDGE_EVENT.CommandResult,
                CaptionPageBridgeClient.onCommandResult,
            );
            CaptionPageBridgeClient.resultListenerInstalled = true;
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Validates observable event detail before looking up a pending caller.
     *
     * @param event Untrusted document event.
     */
    private static readonly onCommandResult = (event: Event): void => {
        if (!(event instanceof CustomEvent)) {
            return;
        }
        const response = parseCaptionPageBridgeCommandResult(event.detail);
        if (response === null) {
            return;
        }
        CaptionPageBridgeClient.settleCommand(
            response.requestId,
            response.result,
        );
    };

    /**
     * Deletes correlation state before resolving so duplicates and reentrant
     * delivery cannot observe a live request.
     *
     * @param requestId Correlation identity to settle.
     * @param result Opaque result returned to the owner.
     * @returns Whether a live command consumed the result.
     */
    private static settleCommand(
        requestId: string,
        result: unknown,
    ): boolean {
        const pending = CaptionPageBridgeClient.pendingCommands.get(requestId);
        if (pending === undefined) {
            return false;
        }
        CaptionPageBridgeClient.pendingCommands.delete(requestId);
        globalThis.clearTimeout(pending.timeoutId);
        if (pending.abortListener !== undefined) {
            pending.signal?.removeEventListener(
                'abort',
                pending.abortListener,
            );
        }
        pending.resolve(result);
        return true;
    }

    /**
     * Combines document time with a monotonic sequence for bounded local
     * correlation without exposing an extension secret.
     *
     * @returns Request identity within the parser's configured bound.
     */
    private static createRequestId(): string {
        CaptionPageBridgeClient.nextRequestSequence += 1;
        const timestamp = Date.now().toString(REQUEST_ID_RADIX);
        const sequence = CaptionPageBridgeClient.nextRequestSequence.toString(
            REQUEST_ID_RADIX,
        );
        return `${timestamp}:${sequence}`;
    }
}
