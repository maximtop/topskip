import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
    CaptionTranscriptCanonicalizer,
    MAX_CAPTION_LANGUAGE_CODE_LENGTH,
    MAX_TRANSCRIPT_CHARACTER_COUNT,
    MAX_TRANSCRIPT_SEGMENT_COUNT,
    MAX_TRANSCRIPT_TIMELINE_SEC,
} from '@topskip/common/captions/canonical-transcript';

describe('CaptionTranscriptCanonicalizer', () => {
    it('produces the golden canonical transcript and SHA-256', () => {
        const result = CaptionTranscriptCanonicalizer.canonicalize({
            languageCode: ' EN-us ',
            segments: [
                {
                    startSec: -0,
                    durationSec: 1,
                    text: ' e\u0301\r\n test ',
                },
                {
                    startSec: 1.25,
                    durationSec: -0,
                    text: '-0 stays text',
                },
            ],
        });

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }

        expect(result.transcript).toMatchObject({
            languageCode: 'en-us',
            segments: [
                { startSec: 0, durationSec: 1, text: 'é\n test' },
                {
                    startSec: 1.25,
                    durationSec: 0,
                    text: '-0 stays text',
                },
            ],
            canonicalJson: '[[0,1,"é\\n test"],[1.25,0,"-0 stays text"]]',
            characterCount: 20,
            timelineEndSec: 1.25,
        });
        expect(
            createHash('sha256')
                .update(result.transcript.canonicalBytes)
                .digest('hex'),
        ).toBe(
            '1afb6e4ec112941d35fbb2f6b7009e3d5433c89a4546bada9834f392a20bead0',
        );
    });

    it('keeps equal starts and overlapping cues in input order', () => {
        const result = CaptionTranscriptCanonicalizer.canonicalize({
            languageCode: 'RU',
            segments: [
                { startSec: 1, durationSec: 5, text: 'first' },
                { startSec: 1, durationSec: 1, text: 'second' },
                { startSec: 2, durationSec: 1, text: 'third' },
            ],
        });

        expect(result).toMatchObject({
            ok: true,
            transcript: {
                languageCode: 'ru',
                canonicalJson: '[[1,5,"first"],[1,1,"second"],[2,1,"third"]]',
                timelineEndSec: 6,
            },
        });
    });

    it('preserves internal whitespace, controls, formats, and combining marks once text is meaningful', () => {
        const text = `a\u0000\u200d\u0301  b`;
        const result = CaptionTranscriptCanonicalizer.canonicalize({
            languageCode: 'en',
            segments: [{ startSec: 0, durationSec: 1, text: ` ${text} ` }],
        });

        expect(result).toMatchObject({
            ok: true,
            transcript: {
                segments: [{ text }],
                characterCount: 7,
            },
        });
    });

    it.each([
        ['', 'empty'],
        [' \n\t ', 'whitespace-only'],
        ['\u200b\u200d', 'format-only'],
        ['\u0000\u0001', 'control-only'],
        ['\u0301\u0302', 'combining-mark-only'],
        ['\ue000\ue001', 'private-use-only'],
        ['\ud800', 'lone high surrogate'],
        ['\udfff', 'lone low surrogate'],
    ])('rejects %s text (%s)', (text) => {
        expect(
            CaptionTranscriptCanonicalizer.canonicalize({
                languageCode: 'en',
                segments: [{ startSec: 0, durationSec: 1, text }],
            }),
        ).toEqual({ ok: false, code: 'invalid_request' });
    });

    it.each([
        ['', 'empty'],
        ['en_us', 'underscore'],
        ['en--us', 'empty tag'],
        ['é', 'non-ASCII'],
        [`${'a'.repeat(MAX_CAPTION_LANGUAGE_CODE_LENGTH)}-b`, 'too long'],
    ])('rejects invalid language %j (%s)', (languageCode) => {
        expect(
            CaptionTranscriptCanonicalizer.canonicalize({
                languageCode,
                segments: [{ startSec: 0, durationSec: 1, text: 'valid' }],
            }),
        ).toEqual({ ok: false, code: 'invalid_request' });
    });

    it.each([
        [Number.NaN, 1],
        [Number.POSITIVE_INFINITY, 1],
        [-1, 1],
        [0, Number.NaN],
        [0, Number.POSITIVE_INFINITY],
        [0, -1],
    ])(
        'rejects invalid timing start=%s duration=%s',
        (startSec, durationSec) => {
            expect(
                CaptionTranscriptCanonicalizer.canonicalize({
                    languageCode: 'en',
                    segments: [{ startSec, durationSec, text: 'valid' }],
                }),
            ).toEqual({ ok: false, code: 'invalid_request' });
        },
    );

    it('rejects decreasing starts without sorting', () => {
        expect(
            CaptionTranscriptCanonicalizer.canonicalize({
                languageCode: 'en',
                segments: [
                    { startSec: 2, durationSec: 1, text: 'two' },
                    { startSec: 1, durationSec: 1, text: 'one' },
                ],
            }),
        ).toEqual({ ok: false, code: 'invalid_request' });
    });

    it('accepts the exact segment, character, and timeline limits', () => {
        const segments = Array.from(
            { length: MAX_TRANSCRIPT_SEGMENT_COUNT },
            (_, index) => ({
                startSec: index,
                durationSec: 0,
                text: index === 0 ? 'a'.repeat(490_001) : 'a',
            }),
        );
        segments[segments.length - 1] = {
            startSec: MAX_TRANSCRIPT_TIMELINE_SEC,
            durationSec: 0,
            text: 'a',
        };

        const result = CaptionTranscriptCanonicalizer.canonicalize({
            languageCode: 'en',
            segments,
        });

        expect(result).toMatchObject({
            ok: true,
            transcript: {
                characterCount: MAX_TRANSCRIPT_CHARACTER_COUNT,
                timelineEndSec: MAX_TRANSCRIPT_TIMELINE_SEC,
            },
        });
    });

    it('rejects one segment above the count limit', () => {
        expect(
            CaptionTranscriptCanonicalizer.canonicalize({
                languageCode: 'en',
                segments: Array.from(
                    { length: MAX_TRANSCRIPT_SEGMENT_COUNT + 1 },
                    (_, index) => ({
                        startSec: index,
                        durationSec: 0,
                        text: 'a',
                    }),
                ),
            }),
        ).toEqual({ ok: false, code: 'too_many_caption_segments' });
    });

    it('rejects one scalar above the text limit', () => {
        expect(
            CaptionTranscriptCanonicalizer.canonicalize({
                languageCode: 'en',
                segments: [
                    {
                        startSec: 0,
                        durationSec: 1,
                        text: 'a'.repeat(MAX_TRANSCRIPT_CHARACTER_COUNT + 1),
                    },
                ],
            }),
        ).toEqual({ ok: false, code: 'transcript_too_large' });
    });

    it('counts astral code points as one scalar', () => {
        const result = CaptionTranscriptCanonicalizer.canonicalize({
            languageCode: 'en',
            segments: [{ startSec: 0, durationSec: 1, text: 'a😀' }],
        });

        expect(result).toMatchObject({
            ok: true,
            transcript: { characterCount: 2 },
        });
    });

    it('rejects a cue end above the timeline limit', () => {
        expect(
            CaptionTranscriptCanonicalizer.canonicalize({
                languageCode: 'en',
                segments: [
                    {
                        startSec: MAX_TRANSCRIPT_TIMELINE_SEC,
                        durationSec: 0.001,
                        text: 'valid',
                    },
                ],
            }),
        ).toEqual({ ok: false, code: 'video_too_long' });
    });
});
