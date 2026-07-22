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
import { ServerTranscriptIdentity } from '@/background/server-transcript-identity';
import { MIME_APPLICATION_JSON } from '@/shared/constants';

const fetchMock =
    vi.fn<(...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>>();

/**
 * Extracts the request URL from any `fetch` input form.
 */
function requestUrl(input: RequestInfo | URL): string {
    if (typeof input === 'string') {
        return input;
    }
    return input instanceof URL ? input.href : input.url;
}

const TOKEN = 'a'.repeat(43);
const REPLACEMENT_TOKEN = 'b'.repeat(43);
const TOKEN_EXPIRY_MS = 4_102_444_800_000;
const CAPABILITIES_HEADER_VALUE = 'processing-status,typed-server-errors-v1';
const TRANSCRIPT_HASH =
    '1afb6e4ec112941d35fbb2f6b7009e3d5433c89a4546bada9834f392a20bead0';
const GOLDEN_CAPTIONS = {
    languageCode: ' EN-us ',
    segments: [
        { startSec: -0, durationSec: 1, text: ' e\u0301\r\n test ' },
        { startSec: 1.25, durationSec: -0, text: '-0 stays text' },
    ],
};
const IDENTITY = {
    videoId: 'dQw4w9WgXcQ',
    languageCode: 'en-us',
    transcriptHash: TRANSCRIPT_HASH,
    algorithmVersion: 'server-v6',
};
const ANALYSIS_INPUT = {
    videoId: IDENTITY.videoId,
    durationSec: 213,
    extensionVersion: '0.1.0',
    ...GOLDEN_CAPTIONS,
};
const PROCESSING_RESPONSE = {
    status: 'processing' as const,
    ...IDENTITY,
    jobId: 'job-server-v6',
    pollAfterSec: 3,
};

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
        vi.restoreAllMocks();
    });

    it('uploads canonical timed captions once per byte-equivalent token retry', async () => {
        fetchMock
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        status: 'error',
                        algorithmVersion: 'server-v6',
                        error: { code: 'token_expired' },
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
                        languageCode: 'en-us',
                        transcriptHash: TRANSCRIPT_HASH,
                        algorithmVersion: 'server-v6',
                        jobId: 'job-server-v6',
                        pollAfterSec: 3,
                    }),
                    { status: 202 },
                ),
            );

        await expect(
            ServerAnalysisClient.requestAnalysis({
                videoId: 'dQw4w9WgXcQ',
                durationSec: 213,
                extensionVersion: '0.1.0',
                ...GOLDEN_CAPTIONS,
            }),
        ).resolves.toMatchObject({
            status: 'processing',
            languageCode: 'en-us',
            transcriptHash: TRANSCRIPT_HASH,
        });

        const firstBody = fetchMock.mock.calls[0]?.[1]?.body;
        const retriedBody = fetchMock.mock.calls[2]?.[1]?.body;
        expect(typeof firstBody).toBe('string');
        expect(retriedBody).toBe(firstBody);
        if (typeof firstBody !== 'string') {
            throw new Error('Expected an analysis JSON body.');
        }
        expect(
            new TextEncoder().encode(firstBody).byteLength,
        ).toBeLessThanOrEqual(8 * 1024 * 1024);
        const body = JSON.parse(firstBody) as unknown;
        expect(body).toMatchObject({
            videoId: 'dQw4w9WgXcQ',
            durationSec: 213,
            extensionVersion: '0.1.0',
            languageCode: 'en-us',
            segments: [
                { startSec: 0, durationSec: 1, text: 'é\n test' },
                { startSec: 1.25, durationSec: 0, text: '-0 stays text' },
            ],
        });
        expect(body).not.toHaveProperty('algorithmVersion');
        expect(body).not.toHaveProperty('transcriptHash');
    });

    it('gets public config without loading or registering an installation', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    apiVersion: 1,
                    algorithmVersion: 'server-v6',
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
            algorithmVersion: 'server-v6',
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

    it('uses a stored bearer token for timed-caption analysis', async () => {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify(PROCESSING_RESPONSE), { status: 202 }),
        );

        const response =
            await ServerAnalysisClient.requestAnalysis(ANALYSIS_INPUT);

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
            languageCode: 'en-us',
            segments: [
                { startSec: 0, durationSec: 1, text: 'é\n test' },
                { startSec: 1.25, durationSec: 0, text: '-0 stays text' },
            ],
            client: {
                source: 'chrome-extension',
                capabilities: ['processing-status', 'typed-server-errors-v1'],
            },
        });
        expect(body).not.toHaveProperty('algorithmVersion');
        expect(body).not.toHaveProperty('transcriptHash');
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
                new Response(JSON.stringify(PROCESSING_RESPONSE), {
                    status: 202,
                }),
            );

        await ServerAnalysisClient.requestAnalysis(ANALYSIS_INPUT);

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
            ServerAnalysisClient.requestAnalysis(ANALYSIS_INPUT),
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
                    ...IDENTITY,
                    sourceResultId: 'result-server-v6',
                    freshness: { expiresAtMs: TOKEN_EXPIRY_MS },
                }),
                { status: 200 },
            ),
        );

        await ServerAnalysisClient.requestJobStatus({
            jobId: 'job-server-v6',
            identity: IDENTITY,
        });

        expect(fetchMock).toHaveBeenCalledWith(
            'http://127.0.0.1:8787/v1/analysis/jobs/job-server-v6',
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

    it('validates poll identity after service worker restart', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    ...PROCESSING_RESPONSE,
                    futureResponseField: 'ignored',
                }),
                { status: 202 },
            ),
        );
        const processing =
            await ServerAnalysisClient.requestAnalysis(ANALYSIS_INPUT);
        expect(processing).toEqual(PROCESSING_RESPONSE);

        vi.resetModules();
        const { ServerAnalysisClient: RestartedServerAnalysisClient } =
            await import('@/background/server-analysis-client');
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    status: 'ready',
                    ...IDENTITY,
                    source: 'server_cache',
                    sourceResultId: 'result-after-restart',
                    freshness: {
                        expiresAtMs: TOKEN_EXPIRY_MS,
                        futureFreshnessField: true,
                    },
                    promoBlocks: [
                        {
                            startSec: 10,
                            endSec: 20,
                            confidence: 'high',
                            futureBlockField: true,
                        },
                    ],
                    futureResponseField: true,
                }),
                { status: 200 },
            ),
        );

        const ready = await RestartedServerAnalysisClient.requestJobStatus({
            jobId: PROCESSING_RESPONSE.jobId,
            identity: IDENTITY,
        });
        expect(ready).toEqual({
            status: 'ready',
            ...IDENTITY,
            source: 'server_cache',
            sourceResultId: 'result-after-restart',
            freshness: { expiresAtMs: TOKEN_EXPIRY_MS },
            promoBlocks: [
                {
                    startSec: 10,
                    endSec: 20,
                    confidence: 'high',
                },
            ],
        });

        const mismatches = [
            { ...IDENTITY, videoId: 'abcdefghijk' },
            { ...IDENTITY, languageCode: 'ru' },
            { ...IDENTITY, transcriptHash: 'f'.repeat(64) },
            { ...IDENTITY, algorithmVersion: 'server-future' },
        ];
        for (const responseIdentity of mismatches) {
            fetchMock.mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        status: 'no_promo',
                        ...responseIdentity,
                        sourceResultId: 'mismatched-result',
                        freshness: { expiresAtMs: TOKEN_EXPIRY_MS },
                    }),
                    { status: 200 },
                ),
            );
            await expect(
                RestartedServerAnalysisClient.requestJobStatus({
                    jobId: PROCESSING_RESPONSE.jobId,
                    identity: IDENTITY,
                }),
            ).rejects.toMatchObject({
                failure: { code: 'invalid_server_response' },
            });
        }

        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    ...PROCESSING_RESPONSE,
                    pollAfterSec: 'soon',
                }),
                { status: 202 },
            ),
        );
        await expect(
            RestartedServerAnalysisClient.requestJobStatus({
                jobId: PROCESSING_RESPONSE.jobId,
                identity: IDENTITY,
            }),
        ).rejects.toMatchObject({
            failure: { code: 'invalid_server_response' },
        });
    });

    it('accepts a valid future server algorithm without equality gating', async () => {
        fetchMock.mockResolvedValueOnce(
            new Response(
                JSON.stringify({
                    ...PROCESSING_RESPONSE,
                    algorithmVersion: 'server-future',
                }),
                { status: 202 },
            ),
        );

        await expect(
            ServerAnalysisClient.requestAnalysis(ANALYSIS_INPUT),
        ).resolves.toMatchObject({
            status: 'processing',
            algorithmVersion: 'server-future',
            transcriptHash: TRANSCRIPT_HASH,
        });
    });

    it('rejects local transcript failures without HTTP', async () => {
        const invalidInputs = [
            { ...ANALYSIS_INPUT, segments: [] },
            {
                ...ANALYSIS_INPUT,
                segments: [{ startSec: 0, durationSec: 1, text: '   ' }],
            },
            {
                ...ANALYSIS_INPUT,
                segments: [
                    {
                        startSec: Number.NaN,
                        durationSec: 1,
                        text: 'caption',
                    },
                ],
            },
            {
                ...ANALYSIS_INPUT,
                segments: [
                    { startSec: 18_000, durationSec: 1, text: 'caption' },
                ],
            },
            {
                ...ANALYSIS_INPUT,
                segments: [
                    {
                        startSec: 0,
                        durationSec: 1,
                        text: 'x'.repeat(500_001),
                    },
                ],
            },
        ];

        for (const input of invalidInputs) {
            await expect(
                ServerAnalysisClient.requestAnalysis(input),
            ).rejects.toBeInstanceOf(ServerAnalysisClientError);
        }
        expect(fetchMock).not.toHaveBeenCalled();
        expect(installationMocks.loadFresh).not.toHaveBeenCalled();
    });

    it.each(['token_expired', 'token_invalid'] as const)(
        're-registers and retries exactly once after %s',
        async (tokenFailureCode) => {
            fetchMock
                .mockResolvedValueOnce(
                    new Response(
                        JSON.stringify({
                            status: 'error',
                            algorithmVersion: 'server-v6',
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
                    new Response(JSON.stringify(PROCESSING_RESPONSE), {
                        status: 202,
                    }),
                );

            await ServerAnalysisClient.requestAnalysis(ANALYSIS_INPUT);

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

    it('mints one replacement token when several tabs hit the same expired token', async () => {
        // Stateful storage emulation: both tabs start on the same stored
        // token; whichever replacement lands first must be reused by the rest.
        let storedToken: string | null = TOKEN;
        installationMocks.loadFresh.mockImplementation(() =>
            Promise.resolve(
                storedToken === null
                    ? null
                    : { token: storedToken, expiresAtMs: TOKEN_EXPIRY_MS },
            ),
        );
        installationMocks.save.mockImplementation(
            (record: { token: string }) => {
                storedToken = record.token;
                return Promise.resolve();
            },
        );
        installationMocks.clear.mockImplementation(() => {
            storedToken = null;
            return Promise.resolve();
        });
        fetchMock.mockImplementation((input, init) => {
            if (requestUrl(input).includes('/v1/installations/register')) {
                return Promise.resolve(
                    new Response(
                        JSON.stringify({
                            status: 'registered',
                            token: REPLACEMENT_TOKEN,
                            expiresAtMs: TOKEN_EXPIRY_MS,
                        }),
                        { status: 201 },
                    ),
                );
            }
            const headers = init?.headers as Record<string, string> | undefined;
            if (headers?.authorization === `Bearer ${TOKEN}`) {
                return Promise.resolve(
                    new Response(
                        JSON.stringify({
                            status: 'error',
                            algorithmVersion: 'server-v6',
                            error: { code: 'token_expired' },
                        }),
                        { status: 401 },
                    ),
                );
            }
            return Promise.resolve(
                new Response(JSON.stringify(PROCESSING_RESPONSE), {
                    status: 202,
                }),
            );
        });

        const [first, second] = await Promise.all([
            ServerAnalysisClient.requestAnalysis(ANALYSIS_INPUT),
            ServerAnalysisClient.requestAnalysis(ANALYSIS_INPUT),
        ]);

        expect(first.status).toBe('processing');
        expect(second.status).toBe('processing');
        const registerCalls = fetchMock.mock.calls.filter(([input]) =>
            requestUrl(input).includes('/v1/installations/register'),
        );
        expect(registerCalls).toHaveLength(1);
        expect(installationMocks.clear).toHaveBeenCalledOnce();
        expect(installationMocks.save).toHaveBeenCalledOnce();
        expect(installationMocks.save).toHaveBeenCalledWith({
            token: REPLACEMENT_TOKEN,
            expiresAtMs: TOKEN_EXPIRY_MS,
        });
    });

    it('reuses a replacement another tab already minted instead of clearing it', async () => {
        // Tab B is still holding the old token when it hits token_expired,
        // but storage already contains tab A's replacement: B must not clear
        // it or register again.
        installationMocks.loadFresh
            .mockResolvedValueOnce({
                token: TOKEN,
                expiresAtMs: TOKEN_EXPIRY_MS,
            })
            .mockResolvedValue({
                token: REPLACEMENT_TOKEN,
                expiresAtMs: TOKEN_EXPIRY_MS,
            });
        fetchMock
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({
                        status: 'error',
                        algorithmVersion: 'server-v6',
                        error: { code: 'token_expired' },
                    }),
                    { status: 401 },
                ),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify(PROCESSING_RESPONSE), {
                    status: 202,
                }),
            );

        const response =
            await ServerAnalysisClient.requestAnalysis(ANALYSIS_INPUT);

        expect(response.status).toBe('processing');
        expect(installationMocks.clear).not.toHaveBeenCalled();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({
            accept: MIME_APPLICATION_JSON,
            authorization: `Bearer ${REPLACEMENT_TOKEN}`,
            'X-TopSkip-Capabilities': CAPABILITIES_HEADER_VALUE,
            'content-type': MIME_APPLICATION_JSON,
        });
    });

    it('returns message-free typed throttling failures', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    status: 'rate_limited',
                    algorithmVersion: 'server-v6',
                    error: { code: 'rate_limited', retryAfterSec: 60 },
                }),
                { status: 429 },
            ),
        );

        await expect(
            ServerAnalysisClient.requestAnalysis(ANALYSIS_INPUT),
        ).resolves.toEqual({
            status: 'rate_limited',
            algorithmVersion: 'server-v6',
            error: { code: 'rate_limited', retryAfterSec: 60 },
        });
    });

    it('normalizes malformed response bodies without exposing raw text', async () => {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ secret: 'provider body' }), {
                status: 500,
            }),
        );

        const failure = ServerAnalysisClient.requestAnalysis(ANALYSIS_INPUT);

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
                    ...IDENTITY,
                    source: 'server_cache',
                    sourceResultId: 'result-server-v6',
                    promoBlocks: [{ startSec: 10, endSec: 20 }],
                    freshness: { expiresAtMs: TOKEN_EXPIRY_MS },
                }),
                { status: 500 },
            ),
        );

        await expect(
            ServerAnalysisClient.requestAnalysis(ANALYSIS_INPUT),
        ).rejects.toMatchObject({
            failure: { code: 'invalid_server_response' },
        });
        expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('retries one transport failure and then returns a valid response', async () => {
        fetchMock
            .mockRejectedValueOnce(new Error('temporary network failure'))
            .mockResolvedValueOnce(
                new Response(JSON.stringify(PROCESSING_RESPONSE), {
                    status: 202,
                }),
            );

        await expect(
            ServerAnalysisClient.requestAnalysis(ANALYSIS_INPUT),
        ).resolves.toMatchObject({ status: 'processing' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('normalizes network failures to a safe stable code', async () => {
        fetchMock.mockRejectedValue(new Error('signed URL and stderr'));

        await expect(
            ServerAnalysisClient.requestAnalysis(ANALYSIS_INPUT),
        ).rejects.toMatchObject({
            failure: { code: 'invalid_server_response' },
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('aborts hung requests with the same safe failure contract', async () => {
        vi.useFakeTimers();
        vi.spyOn(ServerTranscriptIdentity, 'sha256Hex').mockResolvedValue(
            TRANSCRIPT_HASH,
        );
        fetchMock.mockImplementation((_url, init) => {
            return new Promise((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => {
                    reject(new DOMException('Aborted', 'AbortError'));
                });
            });
        });

        const promise = ServerAnalysisClient.requestAnalysis(ANALYSIS_INPUT);
        const rejection = promise.catch((error: unknown) => error);

        await vi.advanceTimersByTimeAsync(15_000);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(15_000);
        await expect(rejection).resolves.toMatchObject({
            failure: { code: 'invalid_server_response' },
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries when the response body stalls until the request timeout', async () => {
        vi.useFakeTimers();
        vi.spyOn(ServerTranscriptIdentity, 'sha256Hex').mockResolvedValue(
            TRANSCRIPT_HASH,
        );
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
                new Response(JSON.stringify(PROCESSING_RESPONSE), {
                    status: 202,
                }),
            );

        const promise = ServerAnalysisClient.requestAnalysis(ANALYSIS_INPUT);
        await vi.advanceTimersByTimeAsync(15_000);

        await expect(promise).resolves.toMatchObject({ status: 'processing' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});
