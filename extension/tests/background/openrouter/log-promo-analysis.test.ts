import { describe, expect, it } from 'vitest';

import {
  buildPromoAnalysisLogBundle,
  excerptTimedLinesAroundSec,
  listTimedLinesFromMergedTranscript,
} from '@/background/openrouter/log-promo-analysis';

describe('listTimedLinesFromMergedTranscript', () => {
  it('parses [sec] lines', () => {
    const rows = listTimedLinesFromMergedTranscript('[1] a\n[2.5] b');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ sec: 1, line: '[1] a' });
    expect(rows[1]).toEqual({ sec: 2.5, line: '[2.5] b' });
  });

  it('ignores non-matching lines', () => {
    expect(listTimedLinesFromMergedTranscript('note\n[0] x')).toHaveLength(1);
  });
});

describe('excerptTimedLinesAroundSec', () => {
  it('anchors at last line with sec <= target', () => {
    const timed = [
      { sec: 1, line: '[1] a' },
      { sec: 5, line: '[5] b' },
      { sec: 10, line: '[10] c' },
    ];
    const ex = excerptTimedLinesAroundSec(timed, 6, 0, 0);
    expect(ex).toBe('[5] b');
  });
});

describe('buildPromoAnalysisLogBundle', () => {
  it('includes metadata, merged body, and outcome lines', () => {
    const bundle = buildPromoAnalysisLogBundle({
      videoId: 'vid',
      languageCode: 'ru',
      segmentCount: 3,
      maxTranscriptChars: 100,
      mergedText: '[0] hello',
      mergedTruncated: false,
      providerId: 'openrouter',
      model: 'm/x',
      rawAssistant: '{"hasPromo":false}',
      outcome: { type: 'no_promo' },
    });
    expect(bundle).toContain('videoId: vid');
    expect(bundle).toContain('language: ru');
    expect(bundle).toContain('mergedTranscriptChars: 9 / 100');
    expect(bundle).toContain('mergedTruncated: no');
    expect(bundle).toContain('[0] hello');
    expect(bundle).toContain('hasPromo false');
    expect(bundle).toContain('{"hasPromo":false}');
  });

  it('includes promo marker section for blocks', () => {
    const bundle = buildPromoAnalysisLogBundle({
      videoId: 'v',
      languageCode: 'en',
      segmentCount: 1,
      maxTranscriptChars: 500,
      mergedText: ['[10] before', '[20] promo read', '[30] after'].join('\n'),
      mergedTruncated: false,
      providerId: 'openrouter',
      model: 'm',
      rawAssistant: '{}',
      outcome: {
        type: 'promo_blocks',
        blocks: [{ startSec: 20, endSec: 25, confidence: 'high' }],
      },
    });
    expect(bundle).toContain('>>> PROMO 1 START at 20s <<<');
    expect(bundle).toContain('>>> PROMO 1 END at 25s <<<');
    expect(bundle).toContain('[20] promo read');
  });

  it('states when raw assistant is unavailable', () => {
    const bundle = buildPromoAnalysisLogBundle({
      videoId: 'v',
      languageCode: 'en',
      segmentCount: 0,
      maxTranscriptChars: 10,
      mergedText: '',
      mergedTruncated: false,
      providerId: 'openrouter',
      model: 'm',
      rawAssistant: null,
      outcome: { type: 'openrouter_error', error: 'HTTP 500' },
    });
    expect(bundle).toContain('not available');
    expect(bundle).toContain('OpenRouter request failed');
  });
});
