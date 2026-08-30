import type { Runtime } from 'webextension-polyfill/namespaces/runtime';
import * as v from 'valibot';

import { DebugLog } from '@/background/debug-log/debug-log';
import { DebugLogBroadcast } from '@/background/debug-log/debug-log-broadcast';
import {
    DebugLogExport,
    EnvironmentProbe,
} from '@/background/debug-log/debug-log-export';
import { DebugLogLifecycle } from '@/background/debug-log/debug-log-lifecycle';
import { DebugLogStore } from '@/background/debug-log/debug-log-store';
import { TabAttributionRegistry } from '@/background/debug-log/tab-attribution-registry';
import { RuntimeSenderTrust } from '@/background/messaging/runtime-sender-trust';
import { DEBUG_LOG_PREVIEW_TAIL_BYTES } from '@/shared/debug-log-constants';
import { getErrorMessage } from '@/shared/error';
import {
    DEV_SEED_DISABLED_ERROR,
    UNTRUSTED_SENDER_ERROR,
    devSeedDebugLogPayloadSchema,
    type DebugLogAppendPayload,
    type DebugLogAppendResponse,
    type DevSeedDebugLogPayload,
    type GetDebugLogBundleResponse,
    type GetDebugLogPreviewResponse,
    type GetDebugLogStatusResponse,
    type SetDebugLoggingResponse,
} from '@/shared/messages';

/**
 * Returned for a seed request whose payload fails validation.
 */
const INVALID_SEED_ERROR = 'Invalid debug log seed.';

/**
 * Ack shape of the dev-only seed command.
 */
type DevSeedDebugLogResponse = { ok: true } | { ok: false; error: string };

/**
 * Runtime handlers for the debug-log messages. Control and read commands are
 * accepted only from extension-origin pages; appends only from top-frame
 * declarative content documents. None of these reads is logged as an event.
 * Static API only.
 */
export class DebugLogRuntimeMessages {
    /**
     * Accepts a validated, bounded content batch for the sender's own tab.
     *
     * @param payload - Schema-validated append payload.
     * @param sender - Browser-provided sender metadata.
     * @returns Switch state for the content client, or a refusal.
     */
    static async handleAppend(
        payload: DebugLogAppendPayload,
        sender: Runtime.MessageSender,
    ): Promise<DebugLogAppendResponse> {
        const tabId = RuntimeSenderTrust.contentTabId(sender);
        if (tabId === null) {
            return { ok: false, error: UNTRUSTED_SENDER_ERROR };
        }
        try {
            await TabAttributionRegistry.ready();
            TabAttributionRegistry.noteSender(sender);
            await DebugLogStore.ready();
            const enabled = DebugLogStore.isEnabled();
            if (enabled) {
                DebugLog.appendFromContent(tabId, payload);
            }
            return { ok: true, enabled };
        } catch (e) {
            return { ok: false, error: getErrorMessage(e) };
        }
    }

    /**
     * Cheap status for the Options poll and the popup indicator.
     *
     * @param sender - Browser-provided sender metadata.
     * @returns Status, or a refusal for non-extension senders.
     */
    static async handleGetStatus(
        sender: Runtime.MessageSender,
    ): Promise<GetDebugLogStatusResponse> {
        if (!RuntimeSenderTrust.isExtensionPage(sender)) {
            return { ok: false, error: UNTRUSTED_SENDER_ERROR };
        }
        try {
            await DebugLogStore.ready();
            return { ok: true, status: DebugLogStore.getStatus() };
        } catch (e) {
            return { ok: false, error: getErrorMessage(e) };
        }
    }

    /**
     * Bounded tail for the Options preview.
     *
     * @param sender - Browser-provided sender metadata.
     * @returns Tail text and sizes, or a refusal.
     */
    static async handleGetPreview(
        sender: Runtime.MessageSender,
    ): Promise<GetDebugLogPreviewResponse> {
        if (!RuntimeSenderTrust.isExtensionPage(sender)) {
            return { ok: false, error: UNTRUSTED_SENDER_ERROR };
        }
        try {
            const preview = await DebugLogStore.readPreview(DEBUG_LOG_PREVIEW_TAIL_BYTES);
            return { ok: true, ...preview };
        } catch (e) {
            return { ok: false, error: getErrorMessage(e) };
        }
    }

    /**
     * Fresh export snapshot; the timestamp is taken after the read so no
     * event is stamped later than the snapshot.
     *
     * @param sender - Browser-provided sender metadata.
     * @returns Bundle text and its snapshot instant, or a refusal/error.
     */
    static async handleGetBundle(
        sender: Runtime.MessageSender,
    ): Promise<GetDebugLogBundleResponse> {
        if (!RuntimeSenderTrust.isExtensionPage(sender)) {
            return { ok: false, error: UNTRUSTED_SENDER_ERROR };
        }
        try {
            const snapshot = await DebugLogStore.readSnapshot();
            const env = await EnvironmentProbe.collect();
            const exportedAtMs = Date.now();
            return {
                ok: true,
                text: DebugLogExport.buildBundle(snapshot, env, exportedAtMs),
                exportedAtMs,
            };
        } catch (e) {
            return { ok: false, error: getErrorMessage(e) };
        }
    }

    /**
     * Turns the switch on (clearing a stored log) or off (keeping it); the
     * store serializes concurrent requests, so a second "on" never clears the
     * log the first one just started. Broadcasts only when the state changed.
     *
     * @param enabled - Requested switch state.
     * @param sender - Browser-provided sender metadata.
     * @returns Status after the change, or a refusal/error.
     */
    static async handleSetEnabled(
        enabled: boolean,
        sender: Runtime.MessageSender,
    ): Promise<SetDebugLoggingResponse> {
        if (!RuntimeSenderTrust.isExtensionPage(sender)) {
            return { ok: false, error: UNTRUSTED_SENDER_ERROR };
        }
        try {
            await DebugLogStore.ready();
            const wasEnabled = DebugLogStore.isEnabled();
            const nowMs = Date.now();
            const status = enabled
                ? await DebugLogLifecycle.enable(nowMs)
                : await DebugLogLifecycle.disable(nowMs);
            if (status.enabled !== wasEnabled) {
                await DebugLogBroadcast.notifyStateChanged(status.enabled);
            }
            return { ok: true, status };
        } catch (e) {
            return { ok: false, error: getErrorMessage(e) };
        }
    }

    /**
     * Dev-only: installs a log store with a chosen state or size for E2E;
     * compiled to a refusal in beta/release before any other check.
     *
     * @param payload - Requested state and approximate size.
     * @param sender - Browser-provided sender metadata.
     * @returns Ack, or a refusal/validation error.
     */
    static async handleDevSeed(
        payload: DevSeedDebugLogPayload,
        sender: Runtime.MessageSender,
    ): Promise<DevSeedDebugLogResponse> {
        if (!__TOPSKIP_INCLUDE_DEV_LOCAL__) {
            return { ok: false, error: DEV_SEED_DISABLED_ERROR };
        }
        if (!RuntimeSenderTrust.isExtensionPage(sender)) {
            return { ok: false, error: UNTRUSTED_SENDER_ERROR };
        }
        const parsed = v.safeParse(devSeedDebugLogPayloadSchema, payload);
        if (!parsed.success) {
            return { ok: false, error: INVALID_SEED_ERROR };
        }
        try {
            await DebugLogStore.seed(parsed.output, Date.now());
            await DebugLogBroadcast.notifyStateChanged(DebugLogStore.isEnabled());
            return { ok: true };
        } catch (e) {
            return { ok: false, error: getErrorMessage(e) };
        }
    }
}
