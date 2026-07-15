import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const installationMocks = vi.hoisted(() => ({
    loadFresh: vi.fn(),
    save: vi.fn(),
    clear: vi.fn(),
}));

vi.mock('@/background/storage/server-installation-storage', () => ({
    ServerInstallationStorage: installationMocks,
}));

import {
    ServerAnalysisClient,
    ServerAnalysisClientError,
} from '@/background/server-analysis-client';
import { MIME_APPLICATION_JSON } from '@/shared/constants';

const fetchMock =
    vi.fn<(...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>>();

const TOKEN = 'a'.repeat(43);
const REPLACEMENT_TOKEN = 'b'.repeat(43);
const TOKEN_EXPIRY_MS = 4_102_444_800_000;
const CAPABILITIES_HEADER_VALUE = 'processing-status,typed-server-errors-v1';

describe('ServerAnalysisClient', () => {
    beforeEach(() => {
        fetchMock.mockReset();
        installationMocks.loadFresh.mockReset();
        installationMocks.save.mockReset();
        installationMocks.clear.mockReset();
        installationMocks.loadFresh.mockResolvedValue({
            token: TOKEN,
            expiresAtMs: TOKEN_EXPIRY_MS,
        });
        installationMocks.save.mockResolvedValue(undefined);
        installationMocks.clear.mockResolvedValue(undefined);
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('gets public config without loading or registering an installation', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    apiVersion: 1,
                    algorithmVersion: 'server-v5',
                    supportedCapabilities: [
                        'processing-status',
                        'typed-server-errors-v1',
                    ],
                    supportIssueBaseUrl:
                        'https://github.com/maximtop/topskip/issues/new',
                }),
                { status: 200 },
            ),
        );

        await expect(ServerAnalysisClient.requestConfig()).resolves.toEqual({
            apiVersion: 1,
            algorithmVersion: 'server-v5',
            supportedCapabilities: [
                'processing-status',
                'typed-server-errors-v1',
            ],
            supportIssueBaseUrl:
                'https://github.com/maximtop/topskip/issues/new',
        });
        expect(fetchMock).toHaveBeenCalledWith(
            'http://127.0.0.1:8787/v1/config',
            expect.objectContaining({ method: 'GET' }),
        );
        expect(installationMocks.loadFresh).not.toHaveBeenCalled();
        expect(installationMocks.save).not.toHaveBeenCalled();
    });

    it('uses a stored bearer token for metadata-only analysis', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    status: 'processing',
                    videoId: 'dQw4w9WgXcQ',
                    algorithmVersion: 'server-v5',
                    jobId: 'job-server-v5',
                    pollAfterSec: 3,
                }),
                { status: 202 },
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
                    authorization: `Bearer ${TOKEN}`,
                    'X-TopSkip-Capabilities': CAPABILITIES_HEADER_VALUE,
                    'content-type': MIME_APPLICATION_JSON,
                },
            }),
        );
        const init = fetchMock.mock.calls[0]?.[1];
        if (typeof init?.body !== 'string') {
            throw new Error('Expected JSON request body.');
        }
        const body = JSON.parse(init.body) as unknown;
        expect(body).toEqual({
            videoId: 'dQw4w9WgXcQ',
            durationSec: 213,
            extensionVersion: '0.1.0',
            client: {
                source: 'chrome-extension',
                capabilities: ['processing-status', 'typed-server-errors-v1'],
            },
        });
        expect(body).not.toHaveProperty('algorithmVersion');
        expect(body).not.toHaveProperty('captions');
        expect(body).not.toHaveProperty('transcript');
    });

    it('registers lazily before the first authenticated request', async () => {
        installationMocks.loadFresh.mockResolvedValueOnce(null);
        fetchMock
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        status: 'registered',
                        token: TOKEN,
                        expiresAtMs: TOKEN_EXPIRY_MS,
                    }),
                    { status: 201 },
                ),
            )
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        status: 'processing',
                        videoId: 'dQw4w9WgXcQ',
                        algorithmVersion: 'server-v5',
                        jobId: 'job-server-v5',
                        pollAfterSec: 3,
                    }),
                    { status: 202 },
                ),
            );

        await ServerAnalysisClient.requestAnalysis({
            videoId: 'dQw4w9WgXcQ',
            extensionVersion: '0.1.0',
        });

        expect(fetchMock.mock.calls[0]?.[0]).toBe(
            'http://127.0.0.1:8787/v1/installations/register',
        );
        expect(fetchMock.mock.calls[0]?.[1]).toEqual(
            expect.objectContaining({
                method: 'POST',
                headers: {
                    accept: MIME_APPLICATION_JSON,
                    'X-TopSkip-Capabilities': CAPABILITIES_HEADER_VALUE,
                },
            }),
        );
        expect(installationMocks.save).toHaveBeenCalledWith({
            token: TOKEN,
            expiresAtMs: TOKEN_EXPIRY_MS,
        });
        expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({
            accept: MIME_APPLICATION_JSON,
            authorization: `Bearer ${TOKEN}`,
            'X-TopSkip-Capabilities': CAPABILITIES_HEADER_VALUE,
            'content-type': MIME_APPLICATION_JSON,
        });
    });

    it('does not retry a registration whose response may have been lost', async () => {
        installationMocks.loadFresh.mockResolvedValueOnce(null);
        fetchMock.mockRejectedValue(new Error('connection closed'));

        await expect(
            ServerAnalysisClient.requestAnalysis({
                videoId: 'dQw4w9WgXcQ',
                extensionVersion: '0.1.0',
            }),
        ).rejects.toMatchObject({
            failure: { code: 'invalid_server_response' },
        });
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(installationMocks.save).not.toHaveBeenCalled();
    });

    it('authenticates job polling with the background-owned token', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    status: 'no_promo',
                    videoId: 'dQw4w9WgXcQ',
                    algorithmVersion: 'server-v5',
                    sourceResultId: 'result-server-v5',
                    freshness: { expiresAtMs: TOKEN_EXPIRY_MS },
                }),
                { status: 200 },
            ),
        );

        await ServerAnalysisClient.requestJobStatus('job-server-v5');

        expect(fetchMock).toHaveBeenCalledWith(
            'http://127.0.0.1:8787/v1/analysis/jobs/job-server-v5',
            expect.objectContaining({
                method: 'GET',
                headers: {
                    accept: MIME_APPLICATION_JSON,
                    authorization: `Bearer ${TOKEN}`,
                    'X-TopSkip-Capabilities': CAPABILITIES_HEADER_VALUE,
                },
            }),
        );
    });

    it.each(['token_expired', 'token_invalid'] as const)(
        're-registers and retries exactly once after %s',
        async (tokenFailureCode) => {
            fetchMock
                .mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            status: 'error',
                            algorithmVersion: 'server-v5',
                            error: { code: tokenFailureCode },
                        }),
                        { status: 401 },
                    ),
                )
                .mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            status: 'registered',
                            token: REPLACEMENT_TOKEN,
                            expiresAtMs: TOKEN_EXPIRY_MS,
                        }),
                        { status: 201 },
                    ),
                )
                .mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            status: 'processing',
                            videoId: 'dQw4w9WgXcQ',
                            algorithmVersion: 'server-v5',
                            jobId: 'job-server-v5',
                            pollAfterSec: 3,
                        }),
                        { status: 202 },
                    ),
                );

            await ServerAnalysisClient.requestAnalysis({
                videoId: 'dQw4w9WgXcQ',
                extensionVersion: '0.1.0',
            });

            expect(installationMocks.clear).toHaveBeenCalledOnce();
            expect(installationMocks.save).toHaveBeenCalledWith({
                token: REPLACEMENT_TOKEN,
                expiresAtMs: TOKEN_EXPIRY_MS,
            });
            expect(fetchMock).toHaveBeenCalledTimes(3);
            expect(fetchMock.mock.calls[2]?.[1]?.headers).toEqual({
                accept: MIME_APPLICATION_JSON,
                authorization: `Bearer ${REPLACEMENT_TOKEN}`,
                'X-TopSkip-Capabilities': CAPABILITIES_HEADER_VALUE,
                'content-type': MIME_APPLICATION_JSON,
            });
        },
    );

    it('returns message-free typed throttling failures', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    status: 'rate_limited',
                    algorithmVersion: 'server-v5',
                    error: { code: 'rate_limited', retryAfterSec: 60 },
                }),
                { status: 429 },
            ),
        );

        await expect(
            ServerAnalysisClient.requestAnalysis({
                videoId: 'dQw4w9WgXcQ',
                extensionVersion: '0.1.0',
            }),
        ).resolves.toEqual({
            status: 'rate_limited',
            algorithmVersion: 'server-v5',
            error: { code: 'rate_limited', retryAfterSec: 60 },
        });
    });

    it('normalizes malformed response bodies without exposing raw text', async () => {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ secret: 'provider body' }), {
                status: 500,
            }),
        );

        const failure = ServerAnalysisClient.requestAnalysis({
            videoId: 'dQw4w9WgXcQ',
            extensionVersion: '0.1.0',
        });

        await expect(failure).rejects.toBeInstanceOf(ServerAnalysisClientError);
        await expect(failure).rejects.toMatchObject({
            failure: { code: 'invalid_server_response' },
        });
        await expect(failure).rejects.not.toThrow(/provider body/u);
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('rejects a success-shaped body returned with a non-success status', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    status: 'ready',
                    videoId: 'dQw4w9WgXcQ',
                    algorithmVersion: 'server-v5',
                    sourceResultId: 'result-server-v5',
                    promoBlocks: [],
                    freshness: { expiresAtMs: TOKEN_EXPIRY_MS },
                }),
                { status: 500 },
            ),
        );

        await expect(
            ServerAnalysisClient.requestAnalysis({
                videoId: 'dQw4w9WgXcQ',
                extensionVersion: '0.1.0',
            }),
        ).rejects.toMatchObject({
            failure: { code: 'invalid_server_response' },
        });
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('retries one transport failure and then returns a valid response', async () => {
        fetchMock
            .mockRejectedValueOnce(new Error('temporary network failure'))
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        status: 'processing',
                        videoId: 'dQw4w9WgXcQ',
                        algorithmVersion: 'server-v5',
                        jobId: 'job-server-v5',
                        pollAfterSec: 3,
                    }),
                    { status: 202 },
                ),
            );

        await expect(
            ServerAnalysisClient.requestAnalysis({
                videoId: 'dQw4w9WgXcQ',
                extensionVersion: '0.1.0',
            }),
        ).resolves.toMatchObject({ status: 'processing' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('normalizes network failures to a safe stable code', async () => {
        fetchMock.mockRejectedValue(new Error('signed URL and stderr'));

        await expect(
            ServerAnalysisClient.requestAnalysis({
                videoId: 'dQw4w9WgXcQ',
                extensionVersion: '0.1.0',
            }),
        ).rejects.toMatchObject({
            failure: { code: 'invalid_server_response' },
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('aborts hung requests with the same safe failure contract', async () => {
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
            extensionVersion: '0.1.0',
        });
        const assertion = expect(promise).rejects.toMatchObject({
            failure: { code: 'invalid_server_response' },
        });

        await vi.advanceTimersByTimeAsync(10_000);
        await assertion;
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries when the response body stalls until the request timeout', async () => {
        vi.useFakeTimers();
        fetchMock
            .mockImplementationOnce((_url, init) => {
                const body = new ReadableStream({
                    start(controller) {
                        init?.signal?.addEventListener('abort', () => {
                            controller.error(
                                new DOMException('Aborted', 'AbortError'),
                            );
                        });
                    },
                });
                return Promise.resolve(new Response(body, { status: 200 }));
            })
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        status: 'processing',
                        videoId: 'dQw4w9WgXcQ',
                        algorithmVersion: 'server-v5',
                        jobId: 'job-server-v5',
                        pollAfterSec: 3,
                    }),
                    { status: 202 },
                ),
            );

        const promise = ServerAnalysisClient.requestAnalysis({
            videoId: 'dQw4w9WgXcQ',
            extensionVersion: '0.1.0',
        });
        await vi.advanceTimersByTimeAsync(5_000);

        await expect(promise).resolves.toMatchObject({ status: 'processing' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
