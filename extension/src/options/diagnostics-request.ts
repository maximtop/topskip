import * as v from 'valibot';

import {
    OPTIONS_DIAGNOSTICS_BUNDLE_TIMEOUT_MS,
    OPTIONS_DIAGNOSTICS_REQUEST_TIMEOUT_MS,
} from '@/options/constants';
import { requestOptionsRuntimeMessage } from '@/options/options-runtime-request';
import { TOPSKIP_MESSAGE, type DebugLogStatusPayload } from '@/shared/messages';

const DEBUG_LOG_REPLY_INVALID_ERROR = 'Debug log reply was invalid.';

const nonNegativeIntegerSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const epochMsOrNullSchema = v.nullable(v.number());

/**
 * Options-side validation of the background's status payload. Intentionally
 * LOOSER than the wire schema `debugLogStatusPayloadSchema` in
 * `@/shared/messages` (a plain `object`, not `strictObject`): a newer worker
 * may add fields the page does not read yet, and the UI must keep rendering.
 */
export const optionsDebugLogStatusReplySchema = v.object({
    enabled: v.boolean(),
    hasLog: v.boolean(),
    enabledAtMs: epochMsOrNullSchema,
    disabledAtMs: epochMsOrNullSchema,
    eventCount: nonNegativeIntegerSchema,
    sizeBytes: nonNegativeIntegerSchema,
    capBytes: nonNegativeIntegerSchema,
    evictedCount: nonNegativeIntegerSchema,
    oldestRetainedMs: epochMsOrNullSchema,
    dropped: v.object({
        incognito: nonNegativeIntegerSchema,
        coalesced: nonNegativeIntegerSchema,
        ceiling: nonNegativeIntegerSchema,
        unreachable: nonNegativeIntegerSchema,
        lost: nonNegativeIntegerSchema,
    }),
    revision: nonNegativeIntegerSchema,
});

const okStatusReplySchema = v.object({
    ok: v.literal(true),
    status: optionsDebugLogStatusReplySchema,
});

const okPreviewReplySchema = v.object({
    ok: v.literal(true),
    text: v.string(),
    shownBytes: nonNegativeIntegerSchema,
    totalBytes: nonNegativeIntegerSchema,
    revision: nonNegativeIntegerSchema,
});

const okBundleReplySchema = v.object({
    ok: v.literal(true),
    text: v.string(),
    exportedAtMs: v.number(),
});

/**
 * Most recent part of the bundle plus the store revision it was read at.
 */
export type DebugLogPreviewResult = {
    text: string;
    shownBytes: number;
    totalBytes: number;
    revision: number;
};

/**
 * Full bundle snapshot; `exportedAtMs` is the instant written in its header
 * and used for the download file name.
 */
export type DebugLogBundleResult = {
    text: string;
    exportedAtMs: number;
};

/**
 * Narrows an `{ ok: true, … }` reply or throws, so refusal, malformed shape
 * and timeout all reach the caller the same way (one localized fallback,
 * never raw error text in the DOM).
 *
 * @param schema - Reply schema.
 * @param reply - Untyped worker reply.
 * @returns Parsed reply.
 */
function parseOkReply<TSchema extends v.GenericSchema>(
    schema: TSchema,
    reply: unknown,
): v.InferOutput<TSchema> {
    const parsed = v.safeParse(schema, reply);
    if (!parsed.success) {
        throw new Error(DEBUG_LOG_REPLY_INVALID_ERROR);
    }
    return parsed.output;
}

/**
 * Cheap status read used by the bounded Diagnostics cadence.
 *
 * @returns Validated status payload.
 */
export async function requestDebugLogStatus(): Promise<DebugLogStatusPayload> {
    const reply = await requestOptionsRuntimeMessage(
        { type: TOPSKIP_MESSAGE.GET_DEBUG_LOG_STATUS },
        OPTIONS_DIAGNOSTICS_REQUEST_TIMEOUT_MS,
    );
    return parseOkReply(okStatusReplySchema, reply).status;
}

/**
 * Preview tail; callers request it only when the store revision moved.
 *
 * @returns Validated preview tail.
 */
export async function requestDebugLogPreview(): Promise<DebugLogPreviewResult> {
    const reply = await requestOptionsRuntimeMessage(
        { type: TOPSKIP_MESSAGE.GET_DEBUG_LOG_PREVIEW },
        OPTIONS_DIAGNOSTICS_REQUEST_TIMEOUT_MS,
    );
    const parsed = parseOkReply(okPreviewReplySchema, reply);
    return {
        text: parsed.text,
        shownBytes: parsed.shownBytes,
        totalBytes: parsed.totalBytes,
        revision: parsed.revision,
    };
}

/**
 * Fresh full snapshot for Copy/Download, bounded by the shorter export
 * timeout so the clipboard write stays inside transient activation.
 *
 * @returns Validated bundle text and snapshot instant.
 */
export async function requestDebugLogBundle(): Promise<DebugLogBundleResult> {
    const reply = await requestOptionsRuntimeMessage(
        { type: TOPSKIP_MESSAGE.GET_DEBUG_LOG_BUNDLE },
        OPTIONS_DIAGNOSTICS_BUNDLE_TIMEOUT_MS,
    );
    const parsed = parseOkReply(okBundleReplySchema, reply);
    return { text: parsed.text, exportedAtMs: parsed.exportedAtMs };
}

/**
 * Turns the switch on or off; the background reply is authoritative.
 *
 * @param enabled - Requested switch state.
 * @returns Status after the change.
 */
export async function requestSetDebugLogging(
    enabled: boolean,
): Promise<DebugLogStatusPayload> {
    const reply = await requestOptionsRuntimeMessage(
        { type: TOPSKIP_MESSAGE.SET_DEBUG_LOGGING, enabled },
        OPTIONS_DIAGNOSTICS_REQUEST_TIMEOUT_MS,
    );
    return parseOkReply(okStatusReplySchema, reply).status;
}
