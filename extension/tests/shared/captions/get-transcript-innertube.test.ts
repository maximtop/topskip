import { describe, expect, it } from 'vitest';

import {
  findGetTranscriptParams,
  findParamsOnCaptionTracks,
  segmentsFromGetTranscriptJson,
} from '@/shared/captions/get-transcript-innertube';

describe('findParamsOnCaptionTracks', () => {
  it('returns first non-empty params string', () => {
    expect(
      findParamsOnCaptionTracks([
        { languageCode: 'en', baseUrl: 'x' },
        { params: 'CgA=' },
      ]),
    ).toBe('CgA=');
  });

  it('finds nested params on a caption track', () => {
    expect(
      findParamsOnCaptionTracks([
        {
          languageCode: 'en',
          baseUrl: 'x',
          nested: { params: 'CgA=' },
        },
      ]),
    ).toBe('CgA=');
  });

  it('prefers the longest params string on a track', () => {
    expect(
      findParamsOnCaptionTracks([
        {
          short: { params: 'ab' },
          long: { params: 'x'.repeat(120) },
        },
      ]),
    ).toBe('x'.repeat(120));
  });
});

describe('findGetTranscriptParams', () => {
  it('finds nested getTranscriptEndpoint.params', () => {
    const data = {
      a: {
        getTranscriptEndpoint: { params: 'nestedParams' },
      },
    };
    expect(findGetTranscriptParams(data)).toBe('nestedParams');
  });
});

describe('segmentsFromGetTranscriptJson', () => {
  it('extracts transcriptSegmentRenderer cues', () => {
    const data = {
      actions: [
        {
          transcriptSegmentRenderer: {
            startMs: '0',
            endMs: '1000',
            snippet: { runs: [{ text: 'hi' }] },
          },
        },
      ],
    };
    const segs = segmentsFromGetTranscriptJson(data);
    expect(segs).not.toBeNull();
    expect(segs?.[0]?.text).toBe('hi');
    expect(segs?.[0]?.startSec).toBe(0);
  });
});
