import { describe, expect, it } from 'vitest';

import {
    DEV_E2E_FIXTURE_VIDEO_ID,
    DEV_E2E_ORIGIN,
    YOUTUBE_CONTENT_SCRIPT_MATCH,
    getWatchVideoIdFromUrl,
} from '@/shared/watch-route';

describe('watch route', () => {
    it('publishes the YouTube match and the compiled dev fixture origin', () => {
        expect(YOUTUBE_CONTENT_SCRIPT_MATCH).toBe(
            'https://www.youtube.com/*',
        );
        // vitest defines the fixture origin the way a dev bundle does.
        expect(DEV_E2E_ORIGIN).toBe('http://127.0.0.1:4173');
    });

    it('parses only exact YouTube watch routes with a non-empty video id', () => {
        expect(
            getWatchVideoIdFromUrl(
                'https://www.youtube.com/watch?v=video-123&list=queue',
            ),
        ).toBe('video-123');
        expect(
            getWatchVideoIdFromUrl('https://www.youtube.com/watch?v='),
        ).toBeNull();
        expect(
            getWatchVideoIdFromUrl('https://www.youtube.com/watch'),
        ).toBeNull();
        expect(
            getWatchVideoIdFromUrl(
                'https://www.youtube.com/shorts/video-123?v=other',
            ),
        ).toBeNull();
    });

    it('rejects YouTube lookalikes and non-HTTPS variants', () => {
        expect(
            getWatchVideoIdFromUrl(
                'https://www.youtube.com.example/watch?v=video-123',
            ),
        ).toBeNull();
        expect(
            getWatchVideoIdFromUrl(
                'https://youtube.com/watch?v=video-123',
            ),
        ).toBeNull();
        expect(
            getWatchVideoIdFromUrl(
                'http://www.youtube.com/watch?v=video-123',
            ),
        ).toBeNull();
    });

    it('maps only the exact development fixture origin to its stable id', () => {
        expect(
            getWatchVideoIdFromUrl('http://127.0.0.1:4173/video.html'),
        ).toBe(DEV_E2E_FIXTURE_VIDEO_ID);
        expect(
            getWatchVideoIdFromUrl('http://127.0.0.1:4174/video.html'),
        ).toBeNull();
        expect(
            getWatchVideoIdFromUrl('http://localhost:4173/video.html'),
        ).toBeNull();
    });

    it('returns null for malformed URL input', () => {
        expect(getWatchVideoIdFromUrl('not a URL')).toBeNull();
    });
});
