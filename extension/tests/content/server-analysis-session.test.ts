import { describe, expect, it } from 'vitest';

import { ServerAnalysisSession } from '@/content/server-analysis-session';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const TRANSCRIPT_HASH = 'a'.repeat(64);
const CAPTIONS = {
    ok: true as const,
    videoId: 'dQw4w9WgXcQ',
    languageCode: 'en',
    segments: [{ startSec: 0, durationSec: 1, text: 'Caption' }],
};

describe('ServerAnalysisSession', () => {
    it('retains no request before captions are ready', () => {
        const session = ServerAnalysisSession.create(
            'dQw4w9WgXcQ',
            () => SESSION_ID,
        );

        expect(session.sessionId).toBe(SESSION_ID);
        expect(session.getRetainedRequest()).toBeNull();
        expect(session.signal.aborted).toBe(false);

        expect(session.acceptCaptions(CAPTIONS, 213)).toEqual({
            sessionId: SESSION_ID,
            videoId: 'dQw4w9WgXcQ',
            durationSec: 213,
            languageCode: 'en',
            segments: CAPTIONS.segments,
        });
        expect(session.getRetainedRequest()).toEqual({
            sessionId: SESSION_ID,
            videoId: 'dQw4w9WgXcQ',
            durationSec: 213,
            languageCode: 'en',
            segments: CAPTIONS.segments,
        });
    });

    it('pins poll identity and permits one exact resubmission', () => {
        const session = ServerAnalysisSession.create(
            'dQw4w9WgXcQ',
            () => SESSION_ID,
        );
        session.acceptCaptions(CAPTIONS);
        const identity = {
            videoId: 'dQw4w9WgXcQ',
            languageCode: 'en',
            transcriptHash: TRANSCRIPT_HASH,
            algorithmVersion: 'server-v6',
        };

        expect(session.pinProcessing('job-v5', identity)).toEqual({
            sessionId: SESSION_ID,
            videoId: 'dQw4w9WgXcQ',
            jobId: 'job-v5',
            identity,
        });
        expect(session.getPollPayload()).toEqual({
            sessionId: SESSION_ID,
            videoId: 'dQw4w9WgXcQ',
            jobId: 'job-v5',
            identity,
        });
        expect(session.takeExactResubmission()).toMatchObject({
            sessionId: SESSION_ID,
            videoId: 'dQw4w9WgXcQ',
            languageCode: 'en',
        });
        expect(session.takeExactResubmission()).toBeNull();
    });

    it('retains the canonical caption identity used by the server', () => {
        const session = ServerAnalysisSession.create(
            'dQw4w9WgXcQ',
            () => SESSION_ID,
        );

        expect(
            session.acceptCaptions({
                ...CAPTIONS,
                languageCode: ' EN ',
                segments: [
                    {
                        startSec: -0,
                        durationSec: 1,
                        text: ' Cafe\u0301\r\n',
                    },
                ],
            }),
        ).toMatchObject({
            languageCode: 'en',
            segments: [{ startSec: 0, durationSec: 1, text: 'Café' }],
        });
        expect(
            session.pinProcessing('job-v5', {
                videoId: 'dQw4w9WgXcQ',
                languageCode: 'en',
                transcriptHash: TRANSCRIPT_HASH,
                algorithmVersion: 'server-v6',
            }),
        ).not.toBeNull();
    });

    it('rejects stale capture and processing identities and aborts on cancel', () => {
        const session = ServerAnalysisSession.create(
            'dQw4w9WgXcQ',
            () => SESSION_ID,
        );

        expect(
            session.acceptCaptions({ ...CAPTIONS, videoId: 'e2eFixture1' }),
        ).toBeNull();
        session.acceptCaptions(CAPTIONS);
        expect(
            session.pinProcessing('job-v5', {
                videoId: 'dQw4w9WgXcQ',
                languageCode: 'ru',
                transcriptHash: TRANSCRIPT_HASH,
                algorithmVersion: 'server-v6',
            }),
        ).toBeNull();

        session.cancel();
        expect(session.signal.aborted).toBe(true);
        expect(session.getRetainedRequest()).toBeNull();
        expect(session.getPollPayload()).toBeNull();
    });
});
