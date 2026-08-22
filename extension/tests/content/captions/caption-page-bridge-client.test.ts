import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    CAPTION_PAGE_BRIDGE_COMMAND,
    CAPTION_PAGE_BRIDGE_COMMAND_TIMEOUT_MS,
    CAPTION_PAGE_BRIDGE_EVENT,
    CAPTION_PAGE_BRIDGE_PROTOCOL_VERSION,
    CAPTION_PAGE_BRIDGE_SOURCE,
    type CaptionPageBridgeCommandRequest,
    parseCaptionPageBridgeCommandRequest,
} from '@/content/captions/caption-page-bridge-contract';
import { CaptionPageBridgeClient } from '@/content/captions/caption-page-bridge-client';
import { CAPTION_CAPTURE_FAILURE_REASON } from '@/shared/messages';

const BRIDGE_UNAVAILABLE_RESULT = {
    ok: false,
    reason: CAPTION_CAPTURE_FAILURE_REASON.BridgeInstallFailed,
    error: 'Caption bridge is unavailable',
};

class TestCustomEvent<T = unknown> extends Event {
    readonly detail: T | undefined;

    constructor(type: string, init: { detail?: T } = {}) {
        super(type);
        this.detail = init.detail;
    }
}

function installDocumentHarness(): void {
    Object.defineProperty(globalThis, 'CustomEvent', {
        configurable: true,
        value: TestCustomEvent,
    });
    Object.defineProperty(globalThis, 'document', {
        configurable: true,
        value: new EventTarget(),
    });
}

function readCommand(event: Event): CaptionPageBridgeCommandRequest {
    if (!(event instanceof CustomEvent)) {
        throw new Error('Expected a CustomEvent command');
    }
    const command = parseCaptionPageBridgeCommandRequest(event.detail);
    if (command === null) {
        throw new Error('Expected a valid bridge command');
    }
    return command;
}

function dispatchResult(requestId: string, result: unknown): void {
    document.dispatchEvent(
        new CustomEvent(CAPTION_PAGE_BRIDGE_EVENT.CommandResult, {
            detail: JSON.stringify({
                source: CAPTION_PAGE_BRIDGE_SOURCE.Main,
                kind: 'command-result',
                protocolVersion: CAPTION_PAGE_BRIDGE_PROTOCOL_VERSION,
                requestId,
                result,
            }),
        }),
    );
}

describe('CaptionPageBridgeClient', () => {
    beforeEach(() => {
        installDocumentHarness();
        vi.useFakeTimers();
    });

    afterEach(() => {
        CaptionPageBridgeClient.dispose();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it.each([
        ['probe', CAPTION_PAGE_BRIDGE_COMMAND.Probe],
        ['activate', CAPTION_PAGE_BRIDGE_COMMAND.Activate],
        ['deactivate', CAPTION_PAGE_BRIDGE_COMMAND.Deactivate],
        ['teardown', CAPTION_PAGE_BRIDGE_COMMAND.Teardown],
    ] as const)(
        'dispatches %s as JSON and accepts a synchronous result',
        async (method, expectedCommand) => {
            const reply = { ok: true, command: expectedCommand };
            document.addEventListener(
                CAPTION_PAGE_BRIDGE_EVENT.Command,
                (event) => {
                    const command = readCommand(event);
                    expect(command.command).toBe(expectedCommand);
                    dispatchResult(command.requestId, reply);
                },
                { once: true },
            );

            const result = await CaptionPageBridgeClient[method]();

            expect(result).toEqual(reply);
        },
    );

    it('installs one result listener for concurrent requests', async () => {
        const addListener = vi.spyOn(document, 'addEventListener');
        const requests: CaptionPageBridgeCommandRequest[] = [];
        document.addEventListener(
            CAPTION_PAGE_BRIDGE_EVENT.Command,
            (event) => {
                requests.push(readCommand(event));
            },
        );

        const first = CaptionPageBridgeClient.probe();
        const second = CaptionPageBridgeClient.activate();
        expect(requests).toHaveLength(2);
        const resultListenerCalls = addListener.mock.calls.filter(
            ([eventName]) =>
                eventName === CAPTION_PAGE_BRIDGE_EVENT.CommandResult,
        );
        expect(resultListenerCalls).toHaveLength(1);

        dispatchResult(requests[0].requestId, { sequence: 1 });
        dispatchResult(requests[1].requestId, { sequence: 2 });
        await expect(first).resolves.toEqual({ sequence: 1 });
        await expect(second).resolves.toEqual({ sequence: 2 });
    });

    it('resolves a bounded failure and removes the request on timeout', async () => {
        const requests: CaptionPageBridgeCommandRequest[] = [];
        document.addEventListener(
            CAPTION_PAGE_BRIDGE_EVENT.Command,
            (event) => {
                requests.push(readCommand(event));
            },
            { once: true },
        );
        const run = CaptionPageBridgeClient.probe();

        await vi.advanceTimersByTimeAsync(
            CAPTION_PAGE_BRIDGE_COMMAND_TIMEOUT_MS,
        );

        await expect(run).resolves.toEqual(BRIDGE_UNAVAILABLE_RESULT);
        expect(requests).toHaveLength(1);
        const request = requests[0];
        if (request !== undefined) {
            dispatchResult(request.requestId, { ok: true });
        }
    });

    it('resolves a bounded failure and removes the request on abort', async () => {
        const controller = new AbortController();
        const removeAbortListener = vi.spyOn(
            controller.signal,
            'removeEventListener',
        );
        const run = CaptionPageBridgeClient.activate(controller.signal);

        controller.abort('private abort reason');

        await expect(run).resolves.toEqual(BRIDGE_UNAVAILABLE_RESULT);
        expect(removeAbortListener).toHaveBeenCalledWith(
            'abort',
            expect.any(Function),
        );
    });

    it('does not dispatch an already-aborted command', async () => {
        const commandListener = vi.fn();
        document.addEventListener(
            CAPTION_PAGE_BRIDGE_EVENT.Command,
            commandListener,
        );
        const controller = new AbortController();
        controller.abort();

        await expect(
            CaptionPageBridgeClient.deactivate(controller.signal),
        ).resolves.toEqual(BRIDGE_UNAVAILABLE_RESULT);
        expect(commandListener).not.toHaveBeenCalled();
    });

    it.each([
        [
            'wrong source',
            (requestId: string) => ({
                source: CAPTION_PAGE_BRIDGE_SOURCE.Isolated,
                kind: 'command-result',
                protocolVersion: CAPTION_PAGE_BRIDGE_PROTOCOL_VERSION,
                requestId,
                result: { ok: true },
            }),
        ],
        [
            'wrong protocol',
            (requestId: string) => ({
                source: CAPTION_PAGE_BRIDGE_SOURCE.Main,
                kind: 'command-result',
                protocolVersion: 2,
                requestId,
                result: { ok: true },
            }),
        ],
        [
            'wrong request id',
            () => ({
                source: CAPTION_PAGE_BRIDGE_SOURCE.Main,
                kind: 'command-result',
                protocolVersion: CAPTION_PAGE_BRIDGE_PROTOCOL_VERSION,
                requestId: 'another-request',
                result: { ok: true },
            }),
        ],
    ] as const)(
        'ignores a synchronous result with %s',
        async (_name, createResult) => {
            document.addEventListener(
                CAPTION_PAGE_BRIDGE_EVENT.Command,
                (event) => {
                    const command = readCommand(event);
                    document.dispatchEvent(
                        new CustomEvent(
                            CAPTION_PAGE_BRIDGE_EVENT.CommandResult,
                            { detail: JSON.stringify(createResult(command.requestId)) },
                        ),
                    );
                },
                { once: true },
            );

            const run = CaptionPageBridgeClient.probe();
            await vi.advanceTimersByTimeAsync(
                CAPTION_PAGE_BRIDGE_COMMAND_TIMEOUT_MS,
            );

            await expect(run).resolves.toEqual(BRIDGE_UNAVAILABLE_RESULT);
        },
    );

    it('ignores malformed and non-string result details', async () => {
        document.addEventListener(
            CAPTION_PAGE_BRIDGE_EVENT.Command,
            () => {
                document.dispatchEvent(
                    new CustomEvent(CAPTION_PAGE_BRIDGE_EVENT.CommandResult, {
                        detail: '{',
                    }),
                );
                document.dispatchEvent(
                    new CustomEvent(CAPTION_PAGE_BRIDGE_EVENT.CommandResult, {
                        detail: { ok: true },
                    }),
                );
            },
            { once: true },
        );

        const run = CaptionPageBridgeClient.probe();
        await vi.advanceTimersByTimeAsync(
            CAPTION_PAGE_BRIDGE_COMMAND_TIMEOUT_MS,
        );

        await expect(run).resolves.toEqual(BRIDGE_UNAVAILABLE_RESULT);
    });

    it('accepts only the first correlated result', async () => {
        document.addEventListener(
            CAPTION_PAGE_BRIDGE_EVENT.Command,
            (event) => {
                const command = readCommand(event);
                dispatchResult(command.requestId, { sequence: 1 });
                dispatchResult(command.requestId, { sequence: 2 });
            },
            { once: true },
        );

        await expect(CaptionPageBridgeClient.activate()).resolves.toEqual({
            sequence: 1,
        });
    });

    it('ignores a late result while resolving the next request', async () => {
        const requests: CaptionPageBridgeCommandRequest[] = [];
        document.addEventListener(
            CAPTION_PAGE_BRIDGE_EVENT.Command,
            (event) => {
                requests.push(readCommand(event));
                if (requests.length !== 2) {
                    return;
                }
                dispatchResult(requests[0].requestId, { stale: true });
                dispatchResult(requests[1].requestId, { ok: true });
            },
        );

        const first = CaptionPageBridgeClient.probe();
        await vi.advanceTimersByTimeAsync(
            CAPTION_PAGE_BRIDGE_COMMAND_TIMEOUT_MS,
        );
        await expect(first).resolves.toEqual(BRIDGE_UNAVAILABLE_RESULT);

        await expect(CaptionPageBridgeClient.probe()).resolves.toEqual({
            ok: true,
        });
    });

    it('settles every pending command and removes its listener on dispose', async () => {
        const removeListener = vi.spyOn(document, 'removeEventListener');
        const first = CaptionPageBridgeClient.probe();
        const second = CaptionPageBridgeClient.activate();

        CaptionPageBridgeClient.dispose();

        await expect(first).resolves.toEqual(BRIDGE_UNAVAILABLE_RESULT);
        await expect(second).resolves.toEqual(BRIDGE_UNAVAILABLE_RESULT);
        expect(removeListener).toHaveBeenCalledWith(
            CAPTION_PAGE_BRIDGE_EVENT.CommandResult,
            expect.any(Function),
        );
    });
});
