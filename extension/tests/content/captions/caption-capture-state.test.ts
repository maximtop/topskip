import { describe, expect, it } from 'vitest';

import {
    shouldIgnoreCapturedTimedtext,
    shouldRestoreCaptionsOff,
    createCaptureSession,
} from '@/content/captions/caption-capture-state';

describe('caption capture state helpers', () => {
    it('ignores stale captured timedtext for another video', () => {
        const session = createCaptureSession('video-a', 1000);
        expect(session.wasOn).toBeNull();
        expect(session.userIntervened).toBe(false);
        expect(
            shouldIgnoreCapturedTimedtext(session, {
                videoId: 'video-b',
                languageCode: 'en',
                body: '{}',
                contentType: 'application/json',
                bodyLength: 2,
                urlShape: {
                    pathname: '/api/timedtext',
                    paramNames: ['fmt', 'lang', 'v'],
                    fmt: 'json3',
                    hasPot: false,
                },
            }),
        ).toBe(true);
    });

    it('restores captions off only when TopSkip turned them on', () => {
        expect(
            shouldRestoreCaptionsOff({ wasOn: false, userIntervened: false }),
        ).toBe(true);
        expect(
            shouldRestoreCaptionsOff({ wasOn: true, userIntervened: false }),
        ).toBe(false);
        expect(
            shouldRestoreCaptionsOff({ wasOn: false, userIntervened: true }),
        ).toBe(false);
    });

    it('creates unique activation ids', () => {
        const a = createCaptureSession('video-a', 1000);
        const b = createCaptureSession('video-a', 1000);
        expect(a.activationId).not.toBe(b.activationId);
    });
});
