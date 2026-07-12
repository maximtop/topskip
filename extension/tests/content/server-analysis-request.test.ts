import { describe, expect, it } from 'vitest';

import {
    buildRefreshServerAnalysisStatusMessage,
    buildRequestServerAnalysisMessage,
    shouldUseServerAnalysis,
} from '@/content/server-analysis-request';
import { ANALYSIS_MODE } from '@/shared/constants';
import { TOPSKIP_MESSAGE } from '@/shared/messages';

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
            }),
        ).toEqual({
            type: TOPSKIP_MESSAGE.REFRESH_SERVER_ANALYSIS_STATUS,
            payload: {
                videoId: 'dQw4w9WgXcQ',
                jobId: 'local-dQw4w9WgXcQ-server-v1',
            },
        });
    });
});
