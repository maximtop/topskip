import { PlayerCaptionCapture } from '@/content/captions/player-caption-capture';
import type {
    CaptionCaptureInput,
    CaptionCaptureResult,
} from '@/content/captions/caption-capture-types';
import { E2E_HOST } from '@/content/page-guards';
import { CAPTION_TRANSCRIPT_DEV_ENABLED } from '@/shared/constants';

const E2E_CAPTION_LANGUAGE = 'en';
const E2E_CAPTION_TEXT = 'TopSkip deterministic caption fixture';

/**
 * Route-neutral capture input with an injectable hostname for deterministic tests.
 */
export type WatchCaptionCaptureInput = CaptionCaptureInput & {
    hostname?: string;
};

/**
 * Debounces ownership to the capture orchestrator while preserving watch gates.
 */
export class WatchCaptions {
    /**
     * Installs passive page hooks before player caption requests begin.
     */
    static installPageBridge(): void {
        if (!CAPTION_TRANSCRIPT_DEV_ENABLED || location.hostname === E2E_HOST) {
            return;
        }
        PlayerCaptionCapture.installBridgeForPage();
    }

    /**
     * Returns timed captions without choosing Server or Private BYOK routing.
     *
     * @param input Session-bound capture identity and cancellation signal.
     * @returns Player captions or a bounded terminal capture outcome.
     */
    static capture(
        input: WatchCaptionCaptureInput,
    ): Promise<CaptionCaptureResult> {
        if (input.signal.aborted) {
            return Promise.resolve({ status: 'cancelled' });
        }
        const hostname = input.hostname ?? location.hostname;
        if (hostname === E2E_HOST) {
            return Promise.resolve({
                status: 'ready',
                payload: {
                    ok: true,
                    videoId: input.videoId,
                    languageCode: E2E_CAPTION_LANGUAGE,
                    segments: [
                        {
                            startSec: 0,
                            durationSec: 1,
                            text: E2E_CAPTION_TEXT,
                        },
                    ],
                },
            });
        }
        return PlayerCaptionCapture.capture(input);
    }

    /**
     * Schedules caption capture after navigation to a supported watch video.
     *
     * @param videoId Current watch `v` id, or `null` when leaving watch.
     * @param source What triggered the schedule request.
     */
    static scheduleForVideoId(
        videoId: string | null,
        source = 'unknown',
    ): void {
        if (!CAPTION_TRANSCRIPT_DEV_ENABLED) {
            return;
        }
        if (videoId === null || location.hostname === E2E_HOST) {
            PlayerCaptionCapture.scheduleForVideoId(null, source);
            return;
        }
        PlayerCaptionCapture.scheduleForVideoId(videoId, source);
    }
}
