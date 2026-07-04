import { describe, expect, it } from 'vitest';
import * as v from 'valibot';

import { captionSegmentSchema } from '@/shared/caption-types';
import {
    captionsFromContentIncomingMessageSchema,
    captionsFromContentPayloadSchema,
    captionsFromContentRuntimeMessageSchema,
    TOPSKIP_MESSAGE,
} from '@/shared/messages';

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
