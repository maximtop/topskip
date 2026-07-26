import type { Runtime } from 'webextension-polyfill/namespaces/runtime';

import { logTranscriptForDeveloper } from '@/background/captions/log-transcript-dev';
import { PromoAnalysis } from '@/background/messaging/promo-analysis';
import { PrefsSyncStorage } from '@/background/storage/prefs-sync';
import {
    CAPTION_CAPTURE_FAILURE_REASON,
    type CaptionCaptureFailureReason,
    type CaptionsFromContentAck,
    type CaptionsFromContentPayload,
} from '@/shared/messages';
import { ANALYSIS_MODE, LOG_PREFIX_CAPTIONS } from '@/shared/constants';

const EXPECTED_CAPTION_FAILURE_REASONS: ReadonlySet<CaptionCaptureFailureReason> =
    new Set([
        CAPTION_CAPTURE_FAILURE_REASON.PlayerNotReady,
        CAPTION_CAPTURE_FAILURE_REASON.CaptureTimeout,
        CAPTION_CAPTURE_FAILURE_REASON.CaptionsUnavailable,
    ]);

/**
 * Caption payloads from the watch content script → promo pipeline; static API
 * only.
 */
export class CaptionRuntimeMessages {
    /**
     * Handles a captions payload from the watch content script, forwarding it
     * to the promo analysis pipeline when the transcript is valid.
     *
     * @param payload - Typed captions payload narrowed by the router.
     * @param sender - Message sender (tab id required for promo analysis).
     * @returns Ack promise.
     */
    static async handle(
        payload: CaptionsFromContentPayload,
        sender: Runtime.MessageSender,
    ): Promise<CaptionsFromContentAck> {
        if (!payload.ok) {
            const expectedFailure =
                payload.reason !== undefined &&
                EXPECTED_CAPTION_FAILURE_REASONS.has(payload.reason);
            const log = expectedFailure ? console.warn : console.error;
            log(LOG_PREFIX_CAPTIONS, payload.error);
            return { ok: true };
        }

        await PrefsSyncStorage.ready();
        const prefs = await PrefsSyncStorage.load();
        if (!prefs.enabled || prefs.analysisMode !== ANALYSIS_MODE.Byok) {
            return { ok: true };
        }

        if (__TOPSKIP_INCLUDE_DEV_LOCAL__) {
            logTranscriptForDeveloper(
                payload.videoId,
                payload.languageCode,
                payload.segments,
            );
        }
        PromoAnalysis.onCaptionsReady(sender, payload);
        return { ok: true };
    }
}
