import * as v from 'valibot';

import {
    SERVER_ANALYSIS_ALGORITHM_VERSION,
    readyResponseSchema,
    type ReadyResponse,
} from '@topskip/common/server-analysis-contract';

/**
 * Valid YouTube-shaped id used by the Playwright watch fixture.
 */
export const SEEDED_SERVER_CACHE_VIDEO_ID = 'e2eFixture1';

const SEEDED_READY_RESPONSE_EXPIRES_AT_MS = 4_102_444_800_000;
const SEEDED_READY_SOURCE_RESULT_ID = 'result-e2eFixture1-server-v4';

const SEEDED_READY_RESPONSE = v.parse(readyResponseSchema, {
    status: 'ready',
    videoId: SEEDED_SERVER_CACHE_VIDEO_ID,
    algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
    source: 'server_cache',
    sourceResultId: SEEDED_READY_SOURCE_RESULT_ID,
    freshness: { expiresAtMs: SEEDED_READY_RESPONSE_EXPIRES_AT_MS },
    promoBlocks: [{ startSec: 4, endSec: 24, confidence: 'high' }],
});

/**
 * In-memory server cache fixture for the local tracer bullet; static API only.
 */
export class BackendCacheFixtures {
    /**
     * Returns a ready cache response when the fixture key matches exactly.
     *
     * @param input - Validated request cache key.
     * @returns Ready response for the seeded video, otherwise `null`.
     */
    static findReady(input: {
        videoId: string;
        algorithmVersion: string;
    }): ReadyResponse | null {
        if (process.env.NODE_ENV !== 'test') {
            return null;
        }
        if (
            input.videoId !== SEEDED_SERVER_CACHE_VIDEO_ID ||
            input.algorithmVersion !== SERVER_ANALYSIS_ALGORITHM_VERSION
        ) {
            return null;
        }
        return SEEDED_READY_RESPONSE;
    }
}
