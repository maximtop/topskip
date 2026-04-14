import { describe, expect, it } from 'vitest';

import { videoIdFromYoutubeWatchUrl } from '@/background/captions/watch-url';

describe('videoIdFromYoutubeWatchUrl', () => {
  it('returns v from www.youtube.com/watch', () => {
    expect(
      videoIdFromYoutubeWatchUrl(
        'https://www.youtube.com/watch?v=abc123def45&feature=share',
      ),
    ).toBe('abc123def45');
  });

  it('accepts m.youtube.com', () => {
    expect(
      videoIdFromYoutubeWatchUrl('https://m.youtube.com/watch?v=xyz'),
    ).toBe('xyz');
  });

  it('returns null for Shorts path', () => {
    expect(
      videoIdFromYoutubeWatchUrl('https://www.youtube.com/shorts/abc'),
    ).toBeNull();
  });

  it('returns null for non-youtube host', () => {
    expect(
      videoIdFromYoutubeWatchUrl('https://example.com/watch?v=abc'),
    ).toBeNull();
  });

  it('returns null when v is missing', () => {
    expect(
      videoIdFromYoutubeWatchUrl('https://www.youtube.com/watch'),
    ).toBeNull();
  });
});
