import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ServerAnalysisClient } from '@/background/server-analysis-client';
import { MIME_APPLICATION_JSON } from '@/shared/constants';

const fetchMock =
    vi.fn<(...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>>();

describe('ServerAnalysisClient', () => {
    beforeEach(() => {
        fetchMock.mockReset();
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('posts video metadata to the configured local backend', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    status: 'processing',
                    videoId: 'dQw4w9WgXcQ',
                    algorithmVersion: 'server-v1',
                    jobId: 'local-dQw4w9WgXcQ-server-v1',
                    pollAfterSec: 3,
                }),
                {
                    status: 202,
                    headers: { 'content-type': MIME_APPLICATION_JSON },
                },
            ),
        );

        const response = await ServerAnalysisClient.requestAnalysis({
            videoId: 'dQw4w9WgXcQ',
            durationSec: 213,
            extensionVersion: '0.1.0',
        });

        expect(response.status).toBe('processing');
        expect(fetchMock).toHaveBeenCalledWith(
            'http://127.0.0.1:8787/v1/analysis',
            expect.objectContaining({
                method: 'POST',
                headers: {
                    accept: MIME_APPLICATION_JSON,
                    'content-type': MIME_APPLICATION_JSON,
                },
            }),
        );
        const init = fetchMock.mock.calls[0]?.[1];
        if (init === undefined) {
            throw new Error('Expected fetch init.');
        }
        if (typeof init.body !== 'string') {
            throw new Error('Expected JSON string request body.');
        }
        const body = JSON.parse(init.body) as unknown;
        expect(body).toEqual(
            expect.objectContaining({
                videoId: 'dQw4w9WgXcQ',
                durationSec: 213,
                extensionVersion: '0.1.0',
            }),
        );
        expect(body).not.toHaveProperty('captions');
        expect(body).not.toHaveProperty('transcript');
    });

    it('parses ready cache-hit responses from the local backend', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    status: 'ready',
                    videoId: 'e2eFixture1',
                    algorithmVersion: 'server-v1',
                    source: 'server_cache',
                    sourceResultId: 'result-e2eFixture1-server-v1',
                    freshness: { expiresAtMs: 4_102_444_800_000 },
                    promoBlocks: [
                        { startSec: 4, endSec: 24, confidence: 'high' },
                    ],
                }),
                {
                    status: 200,
                    headers: { 'content-type': MIME_APPLICATION_JSON },
                },
            ),
        );

        const response = await ServerAnalysisClient.requestAnalysis({
            videoId: 'e2eFixture1',
            durationSec: 120,
            extensionVersion: '0.1.0',
        });

        expect(response).toEqual({
            status: 'ready',
            videoId: 'e2eFixture1',
            algorithmVersion: 'server-v1',
            source: 'server_cache',
            sourceResultId: 'result-e2eFixture1-server-v1',
            freshness: { expiresAtMs: 4_102_444_800_000 },
            promoBlocks: [{ startSec: 4, endSec: 24, confidence: 'high' }],
        });
    });

    it('gets job status from the local backend', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    status: 'no_promo',
                    videoId: 'dQw4w9WgXcQ',
                    algorithmVersion: 'server-v1',
                    sourceResultId: 'result-dQw4w9WgXcQ-server-v1',
                    freshness: { expiresAtMs: 4_102_444_800_000 },
                }),
                {
                    status: 200,
                    headers: { 'content-type': MIME_APPLICATION_JSON },
                },
            ),
        );

        const response = await ServerAnalysisClient.requestJobStatus(
            'local-dQw4w9WgXcQ-server-v1',
        );

        expect(response.status).toBe('no_promo');
        expect(fetchMock).toHaveBeenCalledWith(
            'http://127.0.0.1:8787/v1/analysis/jobs/local-dQw4w9WgXcQ-server-v1',
            expect.objectContaining({ method: 'GET' }),
        );
    });

    it('parses valid rate-limit responses from the local backend', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    status: 'rate_limited',
                    retryAfterSec: 60,
                    error: {
                        code: 'rate_limited',
                        message:
                            'Local cold-analysis limit reached. Retry later.',
                    },
                }),
                {
                    status: 429,
                    headers: { 'content-type': MIME_APPLICATION_JSON },
                },
            ),
        );

        await expect(
            ServerAnalysisClient.requestAnalysis({
                videoId: 'dQw4w9WgXcQ',
                durationSec: 213,
                extensionVersion: '0.1.0',
            }),
        ).resolves.toEqual({
            status: 'rate_limited',
            retryAfterSec: 60,
            error: {
                code: 'rate_limited',
                message: 'Local cold-analysis limit reached. Retry later.',
            },
        });
    });

    it('rejects malformed rate-limit response bodies', async () => {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ status: 'invalid_request' }), {
                status: 429,
                headers: { 'content-type': MIME_APPLICATION_JSON },
            }),
        );

        await expect(
            ServerAnalysisClient.requestAnalysis({
                videoId: 'dQw4w9WgXcQ',
                durationSec: 213,
                extensionVersion: '0.1.0',
            }),
        ).rejects.toThrow();
    });

    it('rejects malformed successful response bodies', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    status: 'ready',
                    videoId: 'dQw4w9WgXcQ',
                    algorithmVersion: 'server-v1',
                    source: 'server_cache',
                    sourceResultId: 'result-dQw4w9WgXcQ-server-v1',
                    freshness: { expiresAtMs: 4_102_444_800_000 },
                    promoBlocks: [],
                }),
                {
                    status: 200,
                    headers: { 'content-type': MIME_APPLICATION_JSON },
                },
            ),
        );

        await expect(
            ServerAnalysisClient.requestAnalysis({
                videoId: 'dQw4w9WgXcQ',
                durationSec: 213,
                extensionVersion: '0.1.0',
            }),
        ).rejects.toThrow();
    });

    it('surfaces backend network failures', async () => {
        fetchMock.mockRejectedValueOnce(new Error('Failed to fetch'));

        await expect(
            ServerAnalysisClient.requestAnalysis({
                videoId: 'dQw4w9WgXcQ',
                durationSec: 213,
                extensionVersion: '0.1.0',
            }),
        ).rejects.toThrow('Failed to fetch');
    });

    it('aborts hung backend requests with a timeout error', async () => {
        vi.useFakeTimers();
        fetchMock.mockImplementation((_url, init) => {
            return new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    reject(new DOMException('Aborted', 'AbortError'));
                });
            });
        });

        const promise = ServerAnalysisClient.requestAnalysis({
            videoId: 'dQw4w9WgXcQ',
            durationSec: 213,
            extensionVersion: '0.1.0',
        });
        const assertion = expect(promise).rejects.toThrow(
            'Server analysis timed out.',
        );

        await vi.advanceTimersByTimeAsync(5_000);

        await assertion;
    });
});
