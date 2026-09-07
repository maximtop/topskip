import { describe, expect, it } from 'vitest';

import {
    CAPTION_TRACK_SELECTION_SOURCE,
    selectPreferredCaptionTrack,
} from '@/content/captions/caption-track-selection';

const MANUAL_ENGLISH = {
    languageCode: 'en',
    kind: '',
    vss_id: '.en',
    is_default: false,
};

const AUTO_RUSSIAN = {
    languageCode: 'ru',
    kind: 'asr',
    vss_id: 'a.ru',
    is_default: false,
};

const TRACKLIST = [MANUAL_ENGLISH, AUTO_RUSSIAN];

function playerResponse(
    defaultCaptionTrackIndex: unknown,
    captionTracks: unknown[] = [
        { languageCode: 'en', vssId: '.en' },
        { languageCode: 'ru', kind: 'asr', vssId: 'a.ru' },
    ],
): unknown {
    return {
        captions: {
            playerCaptionsTracklistRenderer: {
                captionTracks,
                defaultCaptionTrackIndex,
            },
        },
    };
}

describe('selectPreferredCaptionTrack', () => {
    it.each([
        ['undefined', undefined],
        ['null', null],
        ['an empty array', []],
        ['a non-array', { length: 1 }],
    ])('returns null for %s', (_label, tracks) => {
        expect(selectPreferredCaptionTrack(tracks, null)).toBeNull();
    });

    it('prefers the tracklist entry YouTube flags as default', () => {
        const flagged = { ...AUTO_RUSSIAN, is_default: true };
        expect(
            selectPreferredCaptionTrack(
                [MANUAL_ENGLISH, flagged],
                playerResponse(0),
            ),
        ).toEqual({
            track: flagged,
            source: CAPTION_TRACK_SELECTION_SOURCE.DefaultFlag,
        });
    });

    it('resolves the player response default by vssId', () => {
        expect(
            selectPreferredCaptionTrack(TRACKLIST, playerResponse(1)),
        ).toEqual({
            track: AUTO_RUSSIAN,
            source: CAPTION_TRACK_SELECTION_SOURCE.PlayerResponse,
        });
    });

    it('resolves the player response default by language and kind', () => {
        expect(
            selectPreferredCaptionTrack(
                TRACKLIST,
                playerResponse(1, [
                    { languageCode: 'en' },
                    { languageCode: 'ru', kind: 'asr' },
                ]),
            ),
        ).toEqual({
            track: AUTO_RUSSIAN,
            source: CAPTION_TRACK_SELECTION_SOURCE.PlayerResponse,
        });
    });

    it('does not confuse a manual track with an auto track of one language', () => {
        const manualRussian = {
            languageCode: 'ru',
            kind: '',
            vss_id: '.ru',
        };
        expect(
            selectPreferredCaptionTrack(
                [manualRussian, AUTO_RUSSIAN],
                playerResponse(1, [
                    { languageCode: 'ru' },
                    { languageCode: 'ru', kind: 'asr' },
                ]),
            ),
        ).toEqual({
            track: AUTO_RUSSIAN,
            source: CAPTION_TRACK_SELECTION_SOURCE.PlayerResponse,
        });
    });

    it.each([
        ['the player response is missing', null],
        ['the default index is out of range', playerResponse(5)],
        ['the default index is not an integer', playerResponse('1')],
        [
            'the default track matches nothing',
            playerResponse(0, [{ languageCode: 'de', vssId: '.de' }]),
        ],
        ['the renderer is absent', { captions: {} }],
    ])('falls back to the first track when %s', (_label, response) => {
        expect(selectPreferredCaptionTrack(TRACKLIST, response)).toEqual({
            track: MANUAL_ENGLISH,
            source: CAPTION_TRACK_SELECTION_SOURCE.First,
        });
    });

    it('keeps primitive tracklist entries from throwing', () => {
        expect(
            selectPreferredCaptionTrack(['en', 42, null], playerResponse(1)),
        ).toEqual({
            track: 'en',
            source: CAPTION_TRACK_SELECTION_SOURCE.First,
        });
    });
});
