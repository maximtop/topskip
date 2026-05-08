import type { Runtime } from 'webextension-polyfill/namespaces/runtime';

import { logTranscriptForDeveloper } from '@/background/captions/log-transcript-dev';
import { PromoAnalysis } from '@/background/messaging/promo-analysis';
import {
    type CaptionsFromContentAck,
    type CaptionsFromContentPayload,
} from '@/shared/messages';
import { LOG_PREFIX_CAPTIONS } from '@/shared/constants';

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
    static handle(
        payload: CaptionsFromContentPayload,
        sender: Runtime.MessageSender,
    ): Promise<CaptionsFromContentAck> {
        if (!payload.ok) {
            console.error(LOG_PREFIX_CAPTIONS, payload.error);
            return Promise.resolve({ ok: true });
        }
        void logTranscriptForDeveloper(
            payload.videoId,
            payload.languageCode,
            payload.segments,
        );
        PromoAnalysis.onCaptionsReady(sender, payload);
        return Promise.resolve({ ok: true });
    }
}
