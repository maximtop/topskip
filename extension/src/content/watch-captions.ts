import { E2E_HOST } from '@/content/page-guards';
import { fetchYoutubeTranscript } from '@/content/captions/youtube-transcript-fetch';
import browser from '@/shared/browser';
import {
    CAPTION_TRANSCRIPT_DEV_ENABLED,
    LOG_PREFIX_CAPTIONS,
} from '@/shared/constants';
import { TOPSKIP_MESSAGE } from '@/shared/messages';

const DEBOUNCE_MS = 450;

let debounceTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Debounced caption fetch on the watch page; forwards results to the
 * background for service worker logging.
 */
export class WatchCaptions {
    /**
     * Schedules a debounced transcript fetch after navigation to a watch video.
     * Skips the local e2e fixture host (no YouTube API).
     *
     * @param videoId Current watch `v` id, or `null` when leaving watch.
     */
    static scheduleForVideoId(videoId: string | null): void {
        if (!CAPTION_TRANSCRIPT_DEV_ENABLED) {
            return;
        }
        if (videoId === null || location.hostname === E2E_HOST) {
            return;
        }
        if (debounceTimer !== undefined) {
            clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(() => {
            debounceTimer = undefined;
            void WatchCaptions.fetchAndSend(videoId);
        }, DEBOUNCE_MS);
    }

    /**
     * Fetches captions in the content script and sends them to the background.
     *
     * @param videoId YouTube watch video id.
     * @returns Resolves when the message has been sent (or send failed quietly).
     */
    private static async fetchAndSend(videoId: string): Promise<void> {
        console.info(
            LOG_PREFIX_CAPTIONS,
            'Fetch started for videoId=',
            videoId,
        );
        const result = await fetchYoutubeTranscript(videoId);
        const payload = result.ok
            ? {
                  ok: true as const,
                  videoId,
                  languageCode: result.languageCode ?? 'unknown',
                  segments: result.segments,
              }
            : { ok: false as const, videoId, error: result.error };

        try {
            await browser.runtime.sendMessage({
                type: TOPSKIP_MESSAGE.CAPTIONS_FROM_CONTENT,
                payload,
            });
        } catch {
            // extension context invalid
        }
    }
}
