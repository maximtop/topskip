import { describe, expect, it } from 'vitest';
import * as v from 'valibot';

import { captionSegmentSchema } from '@topskip/common/caption-types';
import {
    captionsFromContentIncomingMessageSchema,
    captionsFromContentPayloadSchema,
    captionsFromContentRuntimeMessageSchema,
    promoBlocksDetectedMessageSchema,
    refreshServerAnalysisStatusRuntimeMessageSchema,
    requestServerAnalysisResponseSchema,
    requestServerAnalysisRuntimeMessageSchema,
    serverAnalysisSessionEventRuntimeMessageSchema,
    TOPSKIP_MESSAGE,
} from '@/shared/messages';

const SESSION_ID = '123e4567-e89b-42d3-a456-426614174000';
const VIDEO_ID = 'dQw4w9WgXcQ';
const IDENTITY = {
    videoId: VIDEO_ID,
    languageCode: 'en',
    transcriptHash:
        '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    algorithmVersion: 'server-v6',
};

describe('captionSegmentSchema', () => {
    it('accepts a valid segment', () => {
        const r = v.safeParse(captionSegmentSchema, {
            startSec: 0,
            durationSec: 2,
            text: 'hi',
        });
        expect(r.success).toBe(true);
    });

    it('rejects a segment with wrong field types', () => {
        const r = v.safeParse(captionSegmentSchema, {
            startSec: '0',
            durationSec: 2,
            text: 'hi',
        });
        expect(r.success).toBe(false);
    });
});

describe('captionsFromContentPayloadSchema', () => {
    it('accepts ok:true payload', () => {
        const r = v.safeParse(captionsFromContentPayloadSchema, {
            ok: true,
            videoId: 'abc',
            languageCode: 'en',
            segments: [{ startSec: 0, durationSec: 1, text: 'x' }],
        });
        expect(r.success).toBe(true);
    });

    it('accepts ok:false payload', () => {
        const r = v.safeParse(captionsFromContentPayloadSchema, {
            ok: false,
            videoId: 'abc',
            error: 'nope',
        });
        expect(r.success).toBe(true);
    });

    it('accepts an error payload with a structured capture reason', () => {
        const r = v.safeParse(captionsFromContentPayloadSchema, {
            ok: false,
            videoId: 'abc',
            error: 'Caption capture timed out',
            reason: 'capture-timeout',
            diagnostics: {
                stage: 'waiting-capture',
                bodyLength: 120,
                languageCode: 'en',
                urlShape: {
                    pathname: '/api/timedtext',
                    paramNames: ['fmt', 'lang', 'v'],
                    fmt: 'json3',
                    hasPot: false,
                },
            },
        });
        expect(r.success).toBe(true);
    });

    it('rejects raw URL values in diagnostics', () => {
        const r = v.safeParse(captionsFromContentPayloadSchema, {
            ok: false,
            videoId: 'abc',
            error: 'bad',
            reason: 'parse-failed',
            diagnostics: {
                stage: 'parsing',
                rawUrl: 'https://www.youtube.com/api/timedtext?pot=secret',
            },
        });
        expect(r.success).toBe(false);
    });

    it('rejects an unknown structured capture reason', () => {
        const r = v.safeParse(captionsFromContentPayloadSchema, {
            ok: false,
            videoId: 'abc',
            error: 'bad',
            reason: 'raw-youtube-token-missing',
        });
        expect(r.success).toBe(false);
    });

    it('rejects empty videoId on success branch', () => {
        const r = v.safeParse(captionsFromContentPayloadSchema, {
            ok: true,
            videoId: '',
            languageCode: 'en',
            segments: [],
        });
        expect(r.success).toBe(false);
    });

    it('rejects invalid segment in array', () => {
        const r = v.safeParse(captionsFromContentPayloadSchema, {
            ok: true,
            videoId: 'v',
            languageCode: 'en',
            segments: [{ startSec: 0 }],
        });
        expect(r.success).toBe(false);
    });
});

describe('TOPSKIP_MESSAGE', () => {
    it('has a runtime message for installing caption capture', () => {
        expect(TOPSKIP_MESSAGE.INSTALL_CAPTION_CAPTURE).toBe(
            'TOPSKIP_INSTALL_CAPTION_CAPTURE',
        );
    });
});

describe('captionsFromContentRuntimeMessageSchema', () => {
    it('accepts a full runtime message', () => {
        const r = v.safeParse(captionsFromContentRuntimeMessageSchema, {
            type: TOPSKIP_MESSAGE.CAPTIONS_FROM_CONTENT,
            payload: {
                ok: true,
                videoId: 'vid',
                languageCode: 'en',
                segments: [{ startSec: 0, durationSec: 1, text: 'hi' }],
            },
        });
        expect(r.success).toBe(true);
    });

    it('rejects wrong message type literal', () => {
        const r = v.safeParse(captionsFromContentRuntimeMessageSchema, {
            type: TOPSKIP_MESSAGE.GET_PREFS,
            payload: {
                ok: true,
                videoId: 'vid',
                languageCode: 'en',
                segments: [],
            },
        });
        expect(r.success).toBe(false);
    });
});

describe('captionsFromContentIncomingMessageSchema', () => {
    it('fails when input is not an object', () => {
        const r = v.safeParse(captionsFromContentIncomingMessageSchema, null);
        expect(r.success).toBe(false);
    });

    it('returns ignore when type is missing or not captions', () => {
        let r = v.safeParse(captionsFromContentIncomingMessageSchema, {});
        expect(r.success && r.typed && r.output.kind === 'ignore').toBe(true);

        r = v.safeParse(captionsFromContentIncomingMessageSchema, {
            type: TOPSKIP_MESSAGE.GET_PREFS,
            payload: {},
        });
        expect(r.success && r.typed && r.output.kind === 'ignore').toBe(true);
    });

    it('returns invalid_captions when type matches but payload invalid', () => {
        const r = v.safeParse(captionsFromContentIncomingMessageSchema, {
            type: TOPSKIP_MESSAGE.CAPTIONS_FROM_CONTENT,
            payload: { ok: true },
        });
        expect(
            r.success && r.typed && r.output.kind === 'invalid_captions',
        ).toBe(true);
    });

    it('returns ok when type and payload match', () => {
        const r = v.safeParse(captionsFromContentIncomingMessageSchema, {
            type: TOPSKIP_MESSAGE.CAPTIONS_FROM_CONTENT,
            payload: {
                ok: true,
                videoId: 'v',
                languageCode: 'en',
                segments: [],
            },
        });
        expect(r.success && r.typed && r.output.kind === 'ok').toBe(true);
    });
});

describe('Server analysis session messages', () => {
    it('accepts only bounded UUID session events', () => {
        expect(
            v.safeParse(serverAnalysisSessionEventRuntimeMessageSchema, {
                type: TOPSKIP_MESSAGE.SERVER_ANALYSIS_SESSION_EVENT,
                payload: {
                    event: 'acquisition_started',
                    sessionId: SESSION_ID,
                    videoId: VIDEO_ID,
                },
            }).success,
        ).toBe(true);
        expect(
            v.safeParse(serverAnalysisSessionEventRuntimeMessageSchema, {
                type: TOPSKIP_MESSAGE.SERVER_ANALYSIS_SESSION_EVENT,
                payload: {
                    event: 'cancelled',
                    sessionId: 'not-a-uuid',
                    videoId: VIDEO_ID,
                },
            }).success,
        ).toBe(false);
        expect(
            v.safeParse(serverAnalysisSessionEventRuntimeMessageSchema, {
                type: TOPSKIP_MESSAGE.SERVER_ANALYSIS_SESSION_EVENT,
                payload: {
                    event: 'caption_extraction_failed',
                    sessionId: SESSION_ID,
                    videoId: VIDEO_ID,
                    rawError: 'must not cross the boundary',
                },
            }).success,
        ).toBe(false);
    });

    it('requires timed captions in the initial Server request', () => {
        const request = {
            type: TOPSKIP_MESSAGE.REQUEST_SERVER_ANALYSIS,
            payload: {
                sessionId: SESSION_ID,
                videoId: VIDEO_ID,
                durationSec: 213,
                languageCode: 'en',
                segments: [{ startSec: 0, durationSec: 1, text: 'caption' }],
            },
        };
        expect(
            v.safeParse(requestServerAnalysisRuntimeMessageSchema, request)
                .success,
        ).toBe(true);
        expect(
            v.safeParse(requestServerAnalysisRuntimeMessageSchema, {
                ...request,
                payload: { sessionId: SESSION_ID, videoId: VIDEO_ID },
            }).success,
        ).toBe(false);
        expect(
            v.safeParse(requestServerAnalysisRuntimeMessageSchema, {
                ...request,
                payload: { ...request.payload, transcriptHash: 'client-owned' },
            }).success,
        ).toBe(false);
    });

    it('binds processing acknowledgements and polling to one identity', () => {
        expect(
            v.safeParse(requestServerAnalysisResponseSchema, {
                ok: true,
                status: 'processing',
                jobId: 'opaque-job',
                pollAfterSec: 2,
                identity: IDENTITY,
            }).success,
        ).toBe(true);
        expect(
            v.safeParse(refreshServerAnalysisStatusRuntimeMessageSchema, {
                type: TOPSKIP_MESSAGE.REFRESH_SERVER_ANALYSIS_STATUS,
                payload: {
                    sessionId: SESSION_ID,
                    videoId: VIDEO_ID,
                    jobId: 'opaque-job',
                    identity: IDENTITY,
                },
            }).success,
        ).toBe(true);
        expect(
            v.safeParse(refreshServerAnalysisStatusRuntimeMessageSchema, {
                type: TOPSKIP_MESSAGE.REFRESH_SERVER_ANALYSIS_STATUS,
                payload: {
                    sessionId: SESSION_ID,
                    videoId: VIDEO_ID,
                    jobId: 'opaque-job',
                },
            }).success,
        ).toBe(false);
        expect(
            v.safeParse(requestServerAnalysisResponseSchema, {
                ok: true,
                status: 'resubmit_required',
            }).success,
        ).toBe(true);
    });

    it('discriminates session-bound Server blocks from Private BYOK blocks', () => {
        const blocks = [{ startSec: 10, endSec: 20 }];
        expect(
            v.safeParse(promoBlocksDetectedMessageSchema, {
                type: TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED,
                source: 'server',
                sessionId: SESSION_ID,
                videoId: VIDEO_ID,
                promoBlocks: blocks,
            }).success,
        ).toBe(true);
        expect(
            v.safeParse(promoBlocksDetectedMessageSchema, {
                type: TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED,
                source: 'server_cache',
                videoId: VIDEO_ID,
                promoBlocks: blocks,
            }).success,
        ).toBe(false);
        expect(
            v.safeParse(promoBlocksDetectedMessageSchema, {
                type: TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED,
                source: 'local_provider',
                videoId: VIDEO_ID,
                promoBlocks: blocks,
            }).success,
        ).toBe(true);
        expect(
            v.safeParse(promoBlocksDetectedMessageSchema, {
                type: TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED,
                source: 'local_provider',
                sessionId: SESSION_ID,
                videoId: VIDEO_ID,
                promoBlocks: blocks,
            }).success,
        ).toBe(false);
    });
});
