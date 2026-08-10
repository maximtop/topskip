import { describe, expect, it } from 'vitest';

import {
    SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS,
    SERVER_ANALYSIS_SESSION_DEADLINE_MS,
    ServerAnalysisSession,
} from '@/content/server-analysis-session';

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

    it('retries one immutable submit operation with bounded backoff', () => {
        const session = ServerAnalysisSession.create(
            'dQw4w9WgXcQ',
            () => SESSION_ID,
        );
        session.acceptCaptions(CAPTIONS);

        const initial = session.getPendingOperation();
        expect(initial).toMatchObject({
            kind: 'submit',
            payload: {
                sessionId: SESSION_ID,
                videoId: 'dQw4w9WgXcQ',
            },
        });
        if (initial?.kind !== 'submit') {
            throw new Error('Expected a submit operation.');
        }
        initial.payload.segments[0].text = 'Mutated outside the session';

        const retries = SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS.map(() =>
            session.takeTransportRetry(),
        );
        expect(retries.map((retry) => retry?.retryAfterMs)).toEqual(
            SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS,
        );
        expect(
            retries.map((retry) => retry?.operation.operationId),
        ).toEqual(Array.from({ length: 4 }, () => initial.operationId));
        expect(
            session.getPendingOperation(),
        ).toMatchObject({
            kind: 'submit',
            payload: {
                segments: [{ text: 'Caption' }],
            },
        });
        expect(session.takeTransportRetry()).toBeNull();
    });

    it('keeps poll and exact resubmission retries separate', () => {
        const session = ServerAnalysisSession.create(
            'dQw4w9WgXcQ',
            () => SESSION_ID,
        );
        session.acceptCaptions(CAPTIONS);
        session.takeTransportRetry();
        const identity = {
            videoId: 'dQw4w9WgXcQ',
            languageCode: 'en',
            transcriptHash: TRANSCRIPT_HASH,
            algorithmVersion: 'server-v6',
        };

        session.pinProcessing('job-v5', identity);
        const poll = session.getPendingOperation();
        expect(poll).toMatchObject({
            kind: 'poll',
            payload: { jobId: 'job-v5', identity },
        });
        expect(session.takeTransportRetry()?.retryAfterMs).toBe(
            SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS[0],
        );

        expect(session.takeExactResubmission()).not.toBeNull();
        const exactResubmit = session.getPendingOperation();
        expect(exactResubmit).toMatchObject({
            kind: 'exact_resubmit',
            payload: { sessionId: SESSION_ID },
        });
        expect(exactResubmit?.operationId).not.toBe(poll?.operationId);
        expect(session.takeTransportRetry()?.retryAfterMs).toBe(
            SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS[0],
        );
        expect(session.takeExactResubmission()).toBeNull();
    });

    it('permits one final poll at the fixed session deadline', () => {
        const startedAtMs = 10_000;
        const session = ServerAnalysisSession.create(
            'dQw4w9WgXcQ',
            () => SESSION_ID,
            startedAtMs,
        );
        session.acceptCaptions(CAPTIONS);
        session.pinProcessing('job-v5', {
            videoId: 'dQw4w9WgXcQ',
            languageCode: 'en',
            transcriptHash: TRANSCRIPT_HASH,
            algorithmVersion: 'server-v6',
        });

        expect(session.getDeadlineAtMs()).toBe(
            startedAtMs + SERVER_ANALYSIS_SESSION_DEADLINE_MS,
        );
        expect(
            session.isDeadlineReached(
                startedAtMs + SERVER_ANALYSIS_SESSION_DEADLINE_MS - 1,
            ),
        ).toBe(false);
        expect(
            session.isDeadlineReached(
                startedAtMs + SERVER_ANALYSIS_SESSION_DEADLINE_MS,
            ),
        ).toBe(true);
        expect(session.takeFinalPoll()).toMatchObject({
            kind: 'poll',
            payload: { jobId: 'job-v5' },
        });
        expect(session.takeFinalPoll()).toBeNull();
    });

    it('dedupes terminal delivery before its ack completes the sentinel', () => {
        const session = ServerAnalysisSession.create(
            'dQw4w9WgXcQ',
            () => SESSION_ID,
        );
        session.acceptCaptions(CAPTIONS);

        expect(session.acceptTerminalDelivery()).toBe(true);
        expect(session.acceptTerminalDelivery()).toBe(false);
        expect(session.isTerminal()).toBe(false);
        expect(session.getPendingOperation()).not.toBeNull();
        expect(session.complete()).toBe(true);
        expect(session.complete()).toBe(false);
        expect(session.isTerminal()).toBe(true);
        expect(session.getPendingOperation()).toBeNull();
        expect(session.getRetainedRequest()).toBeNull();
    });

    it('retains a terminal event through bounded delivery recovery', () => {
        const session = ServerAnalysisSession.create(
            'dQw4w9WgXcQ',
            () => SESSION_ID,
        );

        expect(
            session.retainTerminalEvent({ event: 'captions_unavailable' }),
        ).toBe(true);
        expect(session.complete()).toBe(true);
        expect(session.getTerminalEventDeliverySignal().aborted).toBe(false);
        expect(session.getPendingTerminalEvent()).toEqual({
            event: 'captions_unavailable',
        });
        expect(
            SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS.map(() =>
                session.takeTerminalEventDeliveryRetry(),
            ).map((retry) => retry?.retryAfterMs),
        ).toEqual(SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS);
        expect(session.takeTerminalEventDeliveryRetry()).toBeNull();
        expect(session.restartTerminalEventDeliveryRetries()).toBe(true);
        expect(session.takeTerminalEventDeliveryRetry()?.retryAfterMs).toBe(
            SERVER_ANALYSIS_RUNTIME_RETRY_BACKOFF_MS[0],
        );
        expect(session.acknowledgeTerminalEventDelivery()).toBe(true);
        expect(session.acknowledgeTerminalEventDelivery()).toBe(false);
        expect(session.getPendingTerminalEvent()).toBeNull();
    });

    it('clears retained terminal delivery when the route is cancelled', () => {
        const session = ServerAnalysisSession.create(
            'dQw4w9WgXcQ',
            () => SESSION_ID,
        );
        session.retainTerminalEvent({
            event: 'analysis_interrupted',
            reason: 'runtime_unavailable',
        });
        session.complete();

        expect(session.cancel()).toBe(true);
        expect(session.getTerminalEventDeliverySignal().aborted).toBe(true);
        expect(session.getPendingTerminalEvent()).toBeNull();
    });
});
