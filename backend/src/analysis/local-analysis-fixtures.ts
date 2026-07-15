import {
    BACKEND_ANALYSIS_PROVIDER_ID,
    type BackendLlmAnalysisAdapter,
} from '@topskip/backend/analysis/promo-analysis-types';
import { LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS } from '@topskip/backend/extraction/local-transcript-fixtures';

const PRIMARY_FIXTURE_RESPONSE =
    '{"hasPromo":true,"promoBlocks":[{"startSec":4,"endSec":24,"confidence":"high"},{"startSec":35,"endSec":45,"confidence":"medium"}]}';
const SECONDARY_FIXTURE_RESPONSE = '{"hasPromo":false,"confidence":"medium"}';
const SAFE_DEFAULT_FIXTURE_RESPONSE = '{"hasPromo":false}';

/**
 * Deterministic offline adapter for local backend development and tests.
 */
export const LocalPromoAnalysisFixtureAdapter: BackendLlmAnalysisAdapter = {
    providerId: BACKEND_ANALYSIS_PROVIDER_ID.LocalFixture,
    model: BACKEND_ANALYSIS_PROVIDER_ID.LocalFixture,
    promptVersion: 'fixture-v1',
    analyze: (input) => {
        let rawModelResponse: string;
        if (
            input.transcriptArtifact.videoId ===
            LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary
        ) {
            rawModelResponse = PRIMARY_FIXTURE_RESPONSE;
        } else if (
            input.transcriptArtifact.videoId ===
            LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Secondary
        ) {
            rawModelResponse = SECONDARY_FIXTURE_RESPONSE;
        } else {
            rawModelResponse = SAFE_DEFAULT_FIXTURE_RESPONSE;
        }
        return Promise.resolve({
            rawModelResponse,
            model: BACKEND_ANALYSIS_PROVIDER_ID.LocalFixture,
        });
    },
};
