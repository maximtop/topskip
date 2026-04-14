import { describe, expect, it } from 'vitest';

import { parseTranscriptJson3 } from '@/shared/captions/transcript-json3';

describe('parseTranscriptJson3', () => {
  it('returns segments from Innertube-style events', () => {
    const raw = JSON.stringify({
      events: [
        {
          tStartMs: 0,
          dDurationMs: 1000,
          segs: [{ utf8: 'hello ' }, { utf8: 'world' }],
        },
      ],
    });
    const r = parseTranscriptJson3(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]?.text).toBe('hello world');
    expect(r.segments[0]?.startSec).toBe(0);
    expect(r.segments[0]?.durationSec).toBe(1);
  });

  it('returns error when events missing', () => {
    const r = parseTranscriptJson3('{}');
    expect(r.ok).toBe(false);
    if (r.ok) {
      return;
    }
    expect(r.error).toMatch(/events/i);
  });
});
