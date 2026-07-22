import { describe, expect, it } from 'vitest';

import {
    buildRefreshServerAnalysisStatusMessage,
    buildRequestServerAnalysisMessage,
    shouldUseServerAnalysis,
} from '@/content/server-analysis-request';
import { ANALYSIS_MODE } from '@/shared/constants';
import { TOPSKIP_MESSAGE } from '@/shared/messages';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const TRANSCRIPT_HASH = 'a'.repeat(64);
const SEGMENTS = [
    { startSec: 0, durationSec: 1, text: 'Caption one' },
    { startSec: 1, durationSec: 2, text: 'Caption two' },
];
const IDENTITY = {
    videoId: 'dQw4w9WgXcQ',
    languageCode: 'en',
    transcriptHash: TRANSCRIPT_HASH,
    algorithmVersion: 'server-v6',
};

describe('server analysis content request helper', () => {
    it('uses server analysis only when enabled and in server mode', () => {
        expect(
            shouldUseServerAnalysis({
                enabled: true,
                providerId: 'openrouter',
                activeModelId: 'openrouter:test',
                analysisMode: ANALYSIS_MODE.Server,
            }),
        ).toBe(true);

        expect(
            shouldUseServerAnalysis({
                enabled: true,
                providerId: 'openrouter',
                activeModelId: 'openrouter:test',
                analysisMode: ANALYSIS_MODE.Byok,
            }),
        ).toBe(false);
    });

    it('builds one session-bound transcript submission', () => {
        expect(
            buildRequestServerAnalysisMessage({
                sessionId: SESSION_ID,
                videoId: 'dQw4w9WgXcQ',
                durationSec: 213,
                languageCode: 'en',
                segments: SEGMENTS,
            }),
        ).toEqual({
            type: TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS,
            payload: {
                sessionId: SESSION_ID,
                videoId: 'dQw4w9WgXcQ',
                durationSec: 213,
                languageCode: 'en',
                segments: SEGMENTS,
            },
        });
    });

    it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, 18_001])(
        'omits unsafe duration %s without dropping captions',
        (durationSec) => {
            expect(
                buildRequestServerAnalysisMessage({
                    sessionId: SESSION_ID,
                    videoId: 'dQw4w9WgXcQ',
                    durationSec,
                    languageCode: 'en',
                    segments: SEGMENTS,
                }),
            ).toEqual({
                type: TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS,
                payload: {
                    sessionId: SESSION_ID,
                    videoId: 'dQw4w9WgXcQ',
                    languageCode: 'en',
                    segments: SEGMENTS,
                },
            });
        },
    );

    it('builds an identity-bearing poll that survives worker restart', () => {
        expect(
            buildRefreshServerAnalysisStatusMessage({
                sessionId: SESSION_ID,
                videoId: 'dQw4w9WgXcQ',
                jobId: 'job-server-v6',
                identity: IDENTITY,
            }),
        ).toEqual({
            type: TOPSKIP_MESSAGE.REFRESH_SERVER_ANALYSIS_STATUS,
            payload: {
                sessionId: SESSION_ID,
                videoId: 'dQw4w9WgXcQ',
                jobId: 'job-server-v6',
                identity: IDENTITY,
            },
        });
    });
});
