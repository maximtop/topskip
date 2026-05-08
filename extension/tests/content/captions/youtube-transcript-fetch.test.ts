import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/shared/constants', async (importOriginal) => {
    const mod = await importOriginal<typeof import('@/shared/constants')>();
    return {
        ...mod,
        CAPTION_TRANSCRIPT_ALLOW_INNERTUBE_FALLBACK: true,
    };
});

const { mockReadPage, mockSendMessage } = vi.hoisted(() => ({
    mockReadPage: vi.fn(),
    mockSendMessage: vi.fn(),
}));

vi.mock('@/content/captions/page-player-response', async (importOriginal) => {
    const mod =
        await importOriginal<
            typeof import('@/content/captions/page-player-response')
        >();
    return {
        ...mod,
        readYtInitialPlayerResponseFromPage: mockReadPage,
    };
});

vi.mock('@/shared/browser', () => ({
    default: {
        runtime: {
            sendMessage: mockSendMessage,
        },
    },
}));

import { fetchYoutubeTranscript } from '@/content/captions/youtube-transcript-fetch';
import { TOPSKIP_MESSAGE } from '@/shared/messages';

const PLAYER_JSON = {
    playabilityStatus: { status: 'OK' },
    captions: {
        playerCaptionsTracklistRenderer: {
            captionTracks: [
                {
                    languageCode: 'en',
                    baseUrl:
                        'https://www.youtube.com/api/timedtext?v=dQw4w9WgXcQ&fmt=srv3&lang=en',
                },
            ],
        },
    },
};

const WATCH_HTML = [
    '<!DOCTYPE html><html>',
    '<script>"INNERTUBE_API_KEY":"testApiKeyXyz"</script></html>',
].join('');

const TRANSCRIPT_XML = `
<transcript>
  <text start="0" dur="1">test cue</text>
</transcript>
`;

function urlString(input: RequestInfo | URL): string {
    return String(typeof input === 'string' ? input : (input as Request).url);
}

describe('fetchYoutubeTranscript', () => {
    beforeEach(() => {
        mockReadPage.mockResolvedValue(PLAYER_JSON);
        mockSendMessage.mockImplementation((msg: unknown) => {
            const m = msg as { type?: string };
            if (m.type === TOPSKIP_MESSAGE.FETCH_TIMEDTEXT_PAGE) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    body: TRANSCRIPT_XML,
                });
            }
            return Promise.resolve({ ok: false, error: 'unmocked message' });
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns segments when page player JSON + timedtext succeed', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(() =>
                Promise.resolve(new Response('not found', { status: 404 })),
            ),
        );

        const result = await fetchYoutubeTranscript('dQw4w9WgXcQ');
        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.segments).toHaveLength(1);
        expect(result.segments[0]?.text).toBe('test cue');
    });

    it('returns error when watch page fails (fallback path)', async () => {
        mockReadPage.mockResolvedValue(null);
        vi.stubGlobal(
            'fetch',
            vi.fn(() => Promise.resolve(new Response('err', { status: 404 }))),
        );
        const result = await fetchYoutubeTranscript('abc');
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }
        expect(result.error).toMatch(/Watch page HTTP/);
    });

    it('returns error when Innertube player has no captions', async () => {
        mockReadPage.mockResolvedValue(null);
        const noCaptions = { playabilityStatus: { status: 'OK' } };
        const fetchMock = vi.fn((input: RequestInfo | URL) => {
            const url = urlString(input);
            if (url.includes('watch?v=')) {
                return Promise.resolve(
                    new Response(WATCH_HTML, { status: 200 }),
                );
            }
            if (url.includes('/youtubei/v1/player')) {
                return Promise.resolve(
                    new Response(JSON.stringify(noCaptions), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    }),
                );
            }
            return Promise.resolve(new Response('not found', { status: 404 }));
        });
        vi.stubGlobal('fetch', fetchMock);

        const result = await fetchYoutubeTranscript('dQw4w9WgXcQ');
        expect(result.ok).toBe(false);
        if (result.ok) {
            return;
        }
        expect(result.error).toMatch(/No captions/);
    });
});
