import { describe, expect, it } from 'vitest';

import {
    buildRefreshServerAnalysisStatusMessage,
    buildRequestServerAnalysisMessage,
    decideServerAnalysisDuration,
    shouldUseServerAnalysis,
} from '@/content/server-analysis-request';
import { ANALYSIS_MODE } from '@/shared/constants';
import { TOPSKIP_MESSAGE } from '@/shared/messages';

describe('server analysis content request helper', () => {
    it('waits for finite duration and preserves the original wait clock', () => {
        expect(
            decideServerAnalysisDuration({
                durationSec: Number.NaN,
                waitStartedAtMs: null,
                nowMs: 1_000,
                maxWaitMs: 5_000,
            }),
        ).toEqual({ status: 'waiting', waitStartedAtMs: 1_000 });

        expect(
            decideServerAnalysisDuration({
                durationSec: Number.POSITIVE_INFINITY,
                waitStartedAtMs: 1_000,
                nowMs: 3_000,
                maxWaitMs: 5_000,
            }),
        ).toEqual({ status: 'waiting', waitStartedAtMs: 1_000 });
    });

    it('uses duration as soon as metadata becomes finite', () => {
        expect(
            decideServerAnalysisDuration({
                durationSec: 213,
                waitStartedAtMs: 1_000,
                nowMs: 1_500,
                maxWaitMs: 5_000,
            }),
        ).toEqual({ status: 'ready', durationSec: 213 });
    });

    it('times out the duration wait so live metadata cannot block forever', () => {
        expect(
            decideServerAnalysisDuration({
                durationSec: Number.NaN,
                waitStartedAtMs: 1_000,
                nowMs: 6_000,
                maxWaitMs: 5_000,
            }),
        ).toEqual({ status: 'timed_out' });
    });

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

    it('builds a server analysis message with known finite duration', () => {
        expect(
            buildRequestServerAnalysisMessage({
                videoId: 'dQw4w9WgXcQ',
                durationSec: 213,
            }),
        ).toEqual({
            type: TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS,
            payload: {
                videoId: 'dQw4w9WgXcQ',
                durationSec: 213,
            },
        });
    });

    it('builds a server analysis status refresh message', () => {
        expect(
            buildRefreshServerAnalysisStatusMessage({
                videoId: 'dQw4w9WgXcQ',
                jobId: 'local-dQw4w9WgXcQ-server-v1',
                durationSec: 213,
            }),
        ).toEqual({
            type: TOPSKIP_MESSAGE.REFRESH_SERVER_ANALYSIS_STATUS,
            payload: {
                videoId: 'dQw4w9WgXcQ',
                jobId: 'local-dQw4w9WgXcQ-server-v1',
                durationSec: 213,
            },
        });
    });

    it.each([undefined, Number.NaN, Number.POSITIVE_INFINITY, 0, -1])(
        'omits unsafe duration %s from initial and polling messages',
        (durationSec) => {
            expect(
                buildRequestServerAnalysisMessage({
                    videoId: 'dQw4w9WgXcQ',
                    durationSec,
                }),
            ).toEqual({
                type: TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS,
                payload: { videoId: 'dQw4w9WgXcQ' },
            });
            expect(
                buildRefreshServerAnalysisStatusMessage({
                    videoId: 'dQw4w9WgXcQ',
                    jobId: 'local-dQw4w9WgXcQ-server-v1',
                    durationSec,
                }),
            ).toEqual({
                type: TOPSKIP_MESSAGE.REFRESH_SERVER_ANALYSIS_STATUS,
                payload: {
                    videoId: 'dQw4w9WgXcQ',
                    jobId: 'local-dQw4w9WgXcQ-server-v1',
                },
            });
        },
    );
});
