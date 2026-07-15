import type { Runtime } from 'webextension-polyfill/namespaces/runtime';

import { logTranscriptForDeveloper } from '@/background/captions/log-transcript-dev';
import { PromoAnalysis } from '@/background/messaging/promo-analysis';
import { PrefsSyncStorage } from '@/background/storage/prefs-sync';
import {
    type CaptionsFromContentAck,
    type CaptionsFromContentPayload,
} from '@/shared/messages';
import { ANALYSIS_MODE, LOG_PREFIX_CAPTIONS } from '@/shared/constants';

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
            console.error(LOG_PREFIX_CAPTIONS, payload.error);
            return { ok: true };
        }

        await PrefsSyncStorage.ready();
        const prefs = await PrefsSyncStorage.load();
        if (!prefs.enabled || prefs.analysisMode !== ANALYSIS_MODE.Byok) {
            return { ok: true };
        }

        if (__TOPSKIP_INCLUDE_DEV_LOCAL__) {
            void logTranscriptForDeveloper(
                payload.videoId,
                payload.languageCode,
                payload.segments,
            );
        }
        PromoAnalysis.onCaptionsReady(sender, payload);
        return { ok: true };
    }
}
