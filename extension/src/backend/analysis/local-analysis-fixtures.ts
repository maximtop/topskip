import {
    BACKEND_ANALYSIS_PROVIDER_ID,
    type BackendLlmAnalysisAdapter,
} from '@/backend/analysis/promo-analysis-types';
import { LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS } from '@/backend/extraction/local-transcript-fixtures';

const PRIMARY_FIXTURE_RESPONSE =
    '{"hasPromo":true,"promoBlocks":[{"startSec":4,"endSec":24,"confidence":"high"},{"startSec":35,"endSec":45,"confidence":"medium"}]}';
const SECONDARY_FIXTURE_RESPONSE = '{"hasPromo":false,"confidence":"medium"}';
const SAFE_DEFAULT_FIXTURE_RESPONSE = '{"hasPromo":false}';

/**
 * Deterministic offline adapter for local backend development and tests.
 */
export const LocalPromoAnalysisFixtureAdapter: BackendLlmAnalysisAdapter = {
    providerId: BACKEND_ANALYSIS_PROVIDER_ID.LocalFixture,
    analyze: (input) => {
        if (
            input.transcriptArtifact.videoId ===
            LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Primary
        ) {
            return PRIMARY_FIXTURE_RESPONSE;
        }

        if (
            input.transcriptArtifact.videoId ===
            LOCAL_TRANSCRIPT_FIXTURE_VIDEO_IDS.Secondary
        ) {
            return SECONDARY_FIXTURE_RESPONSE;
        }

        return SAFE_DEFAULT_FIXTURE_RESPONSE;
    },
};
