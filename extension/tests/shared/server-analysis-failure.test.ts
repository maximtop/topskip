import { describe, expect, it } from 'vitest';

import {
    SERVER_FAILURE_CATEGORY,
    SERVER_FAILURE_REPORT_ACTION,
    classifyServerFailure,
    getServerFailureReportAction,
} from '@/shared/server-analysis-failure';

describe('server analysis failure mapping', () => {
    it.each([
        'video_unavailable',
        'captions_unavailable',
        'video_too_long',
        'too_many_caption_segments',
        'transcript_too_large',
        'subtitle_response_too_large',
    ] as const)('classifies %s as a video limitation', (code) => {
        expect(classifyServerFailure(code)).toBe(
            SERVER_FAILURE_CATEGORY.VideoLimitation,
        );
        expect(getServerFailureReportAction(code)).toBe(
            SERVER_FAILURE_REPORT_ACTION.Secondary,
        );
    });

    it.each(['rate_limited', 'capacity_limited', 'budget_exhausted'] as const)(
        'classifies %s as temporary capacity without issue reporting',
        (code) => {
            expect(classifyServerFailure(code)).toBe(
                SERVER_FAILURE_CATEGORY.TemporaryCapacity,
            );
            expect(getServerFailureReportAction(code)).toBe(
                SERVER_FAILURE_REPORT_ACTION.None,
            );
        },
    );

    it('classifies client_upgrade_required separately', () => {
        expect(classifyServerFailure('client_upgrade_required')).toBe(
            SERVER_FAILURE_CATEGORY.UpgradeRequired,
        );
        expect(getServerFailureReportAction('client_upgrade_required')).toBe(
            SERVER_FAILURE_REPORT_ACTION.None,
        );
    });

    it.each([
        'invalid_request',
        'caption_extraction_failed',
        'model_provider_error',
        'invalid_model_response',
        'unsafe_model_blocks',
        'internal_error',
        'invalid_server_response',
    ] as const)('classifies %s as a reportable server failure', (code) => {
        expect(classifyServerFailure(code)).toBe(
            SERVER_FAILURE_CATEGORY.ServerFailure,
        );
        expect(getServerFailureReportAction(code)).toBe(
            SERVER_FAILURE_REPORT_ACTION.Primary,
        );
    });
});
