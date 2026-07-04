import { PlayerCaptionCapture } from '@/content/captions/player-caption-capture';
import { E2E_HOST } from '@/content/page-guards';
import { CAPTION_TRANSCRIPT_DEV_ENABLED } from '@/shared/constants';

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
