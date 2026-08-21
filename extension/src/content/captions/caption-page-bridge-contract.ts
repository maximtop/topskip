import * as v from 'valibot';

/**
 * Versioning prevents an updated isolated bundle from trusting stale page code.
 */
export const CAPTION_PAGE_BRIDGE_PROTOCOL_VERSION = 1;

/**
 * Explicit world identities let each parser reject traffic in the wrong
 * direction.
 */
export const CAPTION_PAGE_BRIDGE_SOURCE = {
    Isolated: 'TOPSKIP_CAPTION_CAPTURE_CONTENT',
    Main: 'TOPSKIP_CAPTION_CAPTURE_PAGE',
} as const;

/**
 * The page bridge exposes only lifecycle commands and never accepts payloads.
 *
 * `Teardown` retires the whole bridge (restores `fetch`/XHR and drops the
 * command listener) and is only sent by an ISOLATED context whose extension
 * runtime was invalidated. It grants the page nothing new: the MAIN teardown
 * hook is already reachable from page code through the bridge's global flag.
 */
export const CAPTION_PAGE_BRIDGE_COMMAND = {
    Probe: 'probe',
    Activate: 'activate-captions',
    Deactivate: 'deactivate-captions',
    Teardown: 'teardown',
} as const;

/**
 * Message kinds make request and result parsing direction-specific.
 */
export const CAPTION_PAGE_BRIDGE_KIND = {
    Command: 'command',
    CommandResult: 'command-result',
} as const;

/**
 * A short timeout keeps a missing declarative MAIN bundle from blocking
 * caption acquisition.
 */
export const CAPTION_PAGE_BRIDGE_COMMAND_TIMEOUT_MS = 500;

/**
 * The correlation bound limits hostile document-event allocations.
 */
export const MAX_CAPTION_PAGE_BRIDGE_REQUEST_ID_LENGTH = 128;

/**
 * A lease returns an orphaned active MAIN bridge to dormant pass-through mode.
 */
export const CAPTION_PAGE_BRIDGE_ACTIVE_LEASE_MS = 20_000;

/**
 * Separate events prevent page diagnostics from being mistaken for command
 * acknowledgements.
 */
export const CAPTION_PAGE_BRIDGE_EVENT = {
    Command: 'topskip:caption-capture-command',
    CommandResult: 'topskip:caption-capture-command-result',
    PageMessage: 'topskip:caption-capture-page',
} as const;

/**
 * Commands accepted by the declaratively installed MAIN bridge.
 */
export type CaptionPageBridgeCommand =
    (typeof CAPTION_PAGE_BRIDGE_COMMAND)[keyof typeof CAPTION_PAGE_BRIDGE_COMMAND];

/**
 * Strict local request transported from ISOLATED to MAIN as JSON event detail.
 */
export type CaptionPageBridgeCommandRequest = {
    source: typeof CAPTION_PAGE_BRIDGE_SOURCE.Isolated;
    kind: typeof CAPTION_PAGE_BRIDGE_KIND.Command;
    protocolVersion: typeof CAPTION_PAGE_BRIDGE_PROTOCOL_VERSION;
    requestId: string;
    command: CaptionPageBridgeCommand;
};

/**
 * Correlated local result transported from MAIN to ISOLATED as JSON event
 * detail.
 */
export type CaptionPageBridgeCommandResult = {
    source: typeof CAPTION_PAGE_BRIDGE_SOURCE.Main;
    kind: typeof CAPTION_PAGE_BRIDGE_KIND.CommandResult;
    protocolVersion: typeof CAPTION_PAGE_BRIDGE_PROTOCOL_VERSION;
    requestId: string;
    result: unknown;
};

const requestIdSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(MAX_CAPTION_PAGE_BRIDGE_REQUEST_ID_LENGTH),
);

const commandSchema = v.picklist([
    CAPTION_PAGE_BRIDGE_COMMAND.Probe,
    CAPTION_PAGE_BRIDGE_COMMAND.Activate,
    CAPTION_PAGE_BRIDGE_COMMAND.Deactivate,
    CAPTION_PAGE_BRIDGE_COMMAND.Teardown,
] as const);

const commandRequestSchema = v.strictObject({
    source: v.literal(CAPTION_PAGE_BRIDGE_SOURCE.Isolated),
    kind: v.literal(CAPTION_PAGE_BRIDGE_KIND.Command),
    protocolVersion: v.literal(CAPTION_PAGE_BRIDGE_PROTOCOL_VERSION),
    requestId: requestIdSchema,
    command: commandSchema,
});

const commandResultSchema = v.strictObject({
    source: v.literal(CAPTION_PAGE_BRIDGE_SOURCE.Main),
    kind: v.literal(CAPTION_PAGE_BRIDGE_KIND.CommandResult),
    protocolVersion: v.literal(CAPTION_PAGE_BRIDGE_PROTOCOL_VERSION),
    requestId: requestIdSchema,
    result: v.unknown(),
});

/**
 * Converts observable DOM detail to untrusted data without accepting direct
 * object references across worlds.
 *
 * @param value Candidate CustomEvent detail.
 * @returns Parsed JSON value, or `null` when detail is not valid JSON text.
 */
function parseJsonEventDetail(value: unknown): unknown {
    if (typeof value !== 'string') {
        return null;
    }
    try {
        return JSON.parse(value) as unknown;
    } catch {
        return null;
    }
}

/**
 * Accepts only the complete bounded ISOLATED command envelope.
 *
 * @param value Untrusted command-event detail.
 * @returns Validated command request, or `null` for malformed traffic.
 */
export function parseCaptionPageBridgeCommandRequest(
    value: unknown,
): CaptionPageBridgeCommandRequest | null {
    const parsed = v.safeParse(
        commandRequestSchema,
        parseJsonEventDetail(value),
    );
    return parsed.success ? parsed.output : null;
}

/**
 * Accepts only the complete bounded MAIN result envelope while leaving its
 * command-specific result opaque to the transport.
 *
 * @param value Untrusted result-event detail.
 * @returns Validated command result, or `null` for malformed traffic.
 */
export function parseCaptionPageBridgeCommandResult(
    value: unknown,
): CaptionPageBridgeCommandResult | null {
    const parsed = v.safeParse(
        commandResultSchema,
        parseJsonEventDetail(value),
    );
    return parsed.success ? parsed.output : null;
}
