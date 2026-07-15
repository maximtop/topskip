import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';

import { BackendApiProtection } from '@topskip/backend/api-protection';
import { AnalysisArtifactStore } from '@topskip/backend/analysis-artifact-store';
import { BackendAnalysisJobs } from '@topskip/backend/analysis-jobs';
import { BackendHttpServer } from '@topskip/backend/server';
import { BackendPublicState } from '@topskip/backend/public-state';
import type { SubtitleExtractionStrategyResult } from '@topskip/backend/extraction/subtitle-extraction-types';
import { MIME_APPLICATION_JSON } from '@topskip/common/constants';
import {
    SERVER_ANALYSIS_ALGORITHM_VERSION,
    SERVER_ANALYSIS_UNAVAILABLE_REASON,
    TOPSKIP_CAPABILITIES_HEADER_NAME,
    noPromoResponseSchema,
    processingResponseSchema,
    rateLimitedResponseSchema,
    readyResponseSchema,
    unavailableResponseSchema,
} from '@topskip/common/server-analysis-contract';

const ORIGINAL_ALLOWED_EXTENSION_ORIGINS =
    process.env.TOPSKIP_ALLOWED_EXTENSION_ORIGINS;

async function listenOnEphemeralPort(
    server: ReturnType<typeof BackendHttpServer.create>,
): Promise<void> {
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve());
    });
}

function localServerUrl(
    server: ReturnType<typeof BackendHttpServer.create>,
): string {
    const address = server.address();
    if (address === null || typeof address === 'string') {
        throw new Error('Expected an ephemeral TCP port.');
    }
    return `http://127.0.0.1:${address.port}`;
}

async function postJson(
    url: string,
    body: unknown,
    headers: Record<string, string> = {},
): Promise<Response> {
    return fetch(url, {
        method: 'POST',
        headers: { 'content-type': MIME_APPLICATION_JSON, ...headers },
        body: JSON.stringify(body),
    });
}

describe('BackendHttpServer request body guard', () => {
    const servers: Array<ReturnType<typeof BackendHttpServer.create>> = [];

    beforeEach(() => {
        BackendAnalysisJobs.resetForTests();
        AnalysisArtifactStore.resetForTests();
        BackendApiProtection.resetForTests();
    });

    afterEach(async () => {
        await Promise.all(
            servers.map(
                (server) =>
                    new Promise<void>((resolve) => {
                        server.close(() => resolve());
                    }),
            ),
        );
        servers.length = 0;
        vi.restoreAllMocks();
        if (ORIGINAL_ALLOWED_EXTENSION_ORIGINS === undefined) {
            delete process.env.TOPSKIP_ALLOWED_EXTENSION_ORIGINS;
        } else {
            process.env.TOPSKIP_ALLOWED_EXTENSION_ORIGINS =
                ORIGINAL_ALLOWED_EXTENSION_ORIGINS;
        }
    });

    it('returns a typed 400 response for malformed JSON', async () => {
        const server = BackendHttpServer.create();
        servers.push(server);
        await new Promise<void>((resolve) => {
            server.listen(0, '127.0.0.1', () => resolve());
        });
        const address = server.address();
        if (address === null || typeof address === 'string') {
            throw new Error('Expected an ephemeral TCP port.');
        }

        const response = await fetch(
            `http://127.0.0.1:${address.port}/v1/analysis`,
            {
                method: 'POST',
                headers: { 'content-type': MIME_APPLICATION_JSON },
                body: '{not-json',
            },
        );

        expect(response.status).toBe(400);
        await expect(response.json()).resolves.toEqual({
            status: 'error',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            error: {
                code: 'invalid_request',
            },
        });
    });

    it('registers public installations, requires bearer auth, and enforces job ownership', async () => {
        BackendPublicState.configureForTests();
        const server = BackendHttpServer.create({
            requireAuth: true,
            now: () => 1_900_000_000_000,
        });
        servers.push(server);
        await listenOnEphemeralPort(server);
        const baseUrl = localServerUrl(server);
        try {
            const config = await fetch(`${baseUrl}/v1/config`);
            await expect(config.json()).resolves.toMatchObject({
                apiVersion: 1,
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                supportedCapabilities: [
                    'processing-status',
                    'typed-server-errors-v1',
                ],
            });

            const register = async (): Promise<string> => {
                const response = await fetch(
                    `${baseUrl}/v1/installations/register`,
                    { method: 'POST' },
                );
                expect(response.status).toBe(201);
                const body: unknown = await response.json();
                if (
                    body === null ||
                    typeof body !== 'object' ||
                    !('token' in body) ||
                    typeof body.token !== 'string'
                ) {
                    throw new Error('Expected registration token.');
                }
                return body.token;
            };
            const ownerToken = await register();
            const otherToken = await register();
            const legacyFailure = await fetch(`${baseUrl}/v1/analysis`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${ownerToken}`,
                    'content-type': MIME_APPLICATION_JSON,
                },
                body: JSON.stringify({
                    videoId: 'dQw4w9WgXcQ',
                    durationSec: 18_001,
                    extensionVersion: '0.1.0',
                    client: {
                        source: 'chrome-extension',
                        capabilities: ['processing-status'],
                    },
                }),
            });
            await expect(legacyFailure.json()).resolves.toMatchObject({
                status: 'unavailable',
                reason: 'caption_extraction_failed',
                message: 'Caption extraction failed for this video.',
            });
            const unauthenticated = await postJson(
                `${baseUrl}/v1/analysis`,
                {
                    videoId: 'dQw4w9WgXcQ',
                    extensionVersion: '0.1.0',
                    client: {
                        source: 'chrome-extension',
                        capabilities: ['typed-server-errors-v1'],
                    },
                },
                {
                    [TOPSKIP_CAPABILITIES_HEADER_NAME]:
                        'typed-server-errors-v1',
                },
            );
            expect(unauthenticated.status).toBe(401);
            await expect(unauthenticated.json()).resolves.toEqual({
                status: 'error',
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                error: { code: 'token_missing' },
            });

            const initial = await fetch(`${baseUrl}/v1/analysis`, {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${ownerToken}`,
                    'content-type': MIME_APPLICATION_JSON,
                },
                body: JSON.stringify({
                    videoId: 'unknownVid1',
                    extensionVersion: '0.1.0',
                    client: {
                        source: 'chrome-extension',
                        capabilities: ['typed-server-errors-v1'],
                    },
                }),
            });
            const processing = v.parse(
                processingResponseSchema,
                (await initial.json()) as unknown,
            );
            const forbiddenPoll = await fetch(
                `${baseUrl}/v1/analysis/jobs/${processing.jobId}`,
                {
                    headers: { authorization: `Bearer ${otherToken}` },
                },
            );
            expect(forbiddenPoll.status).toBe(404);
        } finally {
            BackendPublicState.resetForTests();
        }
    });

    it('returns a typed 413 response for oversized bodies', async () => {
        const server = BackendHttpServer.create();
        servers.push(server);
        await new Promise<void>((resolve) => {
            server.listen(0, '127.0.0.1', () => resolve());
        });
        const address = server.address();
        if (address === null || typeof address === 'string') {
            throw new Error('Expected an ephemeral TCP port.');
        }

        const response = await fetch(
            `http://127.0.0.1:${address.port}/v1/analysis`,
            {
                method: 'POST',
                headers: { 'content-type': MIME_APPLICATION_JSON },
                body: 'x'.repeat(32_769),
            },
        );

        expect(response.status).toBe(413);
        await expect(response.json()).resolves.toEqual({
            status: 'error',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            error: {
                code: 'request_body_too_large',
            },
        });
    });

    it('responds with HTTP 200 for a seeded ready cache hit', async () => {
        const server = BackendHttpServer.create();
        servers.push(server);
        await new Promise<void>((resolve) => {
            server.listen(0, '127.0.0.1', () => resolve());
        });
        const address = server.address();
        if (address === null || typeof address === 'string') {
            throw new Error('Expected an ephemeral TCP port.');
        }

        const response = await fetch(
            `http://127.0.0.1:${address.port}/v1/analysis`,
            {
                method: 'POST',
                headers: { 'content-type': MIME_APPLICATION_JSON },
                body: JSON.stringify({
                    videoId: 'e2eFixture1',
                    extensionVersion: '0.1.0',
                    algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
                    client: {
                        source: 'chrome-extension',
                        capabilities: ['processing-status'],
                    },
                }),
            },
        );

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            status: 'ready',
            videoId: 'e2eFixture1',
            source: 'server_cache',
            sourceResultId: 'result-e2eFixture1-server-v4',
            freshness: { expiresAtMs: 4_102_444_800_000 },
            promoBlocks: [{ startSec: 4, endSec: 24, confidence: 'high' }],
        });
    });

    it('polls a worker-backed ready local analysis job over HTTP', async () => {
        const server = BackendHttpServer.create();
        servers.push(server);
        await listenOnEphemeralPort(server);
        const baseUrl = localServerUrl(server);

        const initial = await postJson(`${baseUrl}/v1/analysis`, {
            videoId: 'dQw4w9WgXcQ',
            durationSec: 120,
            extensionVersion: '0.1.0',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            client: {
                source: 'chrome-extension',
                capabilities: ['processing-status'],
            },
        });

        expect(initial.status).toBe(202);
        const processing = v.parse(
            processingResponseSchema,
            (await initial.json()) as unknown,
        );

        const statusBefore = await fetch(
            `${baseUrl}/v1/analysis/jobs/${processing.jobId}`,
        );
        expect(statusBefore.status).toBe(200);
        const ready = v.parse(
            readyResponseSchema,
            (await statusBefore.json()) as unknown,
        );
        expect(ready).toEqual({
            status: 'ready',
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            source: 'server_cache',
            sourceResultId: 'result-dQw4w9WgXcQ-server-v4',
            freshness: ready.freshness,
            promoBlocks: [
                { startSec: 4, endSec: 24, confidence: 'high' },
                { startSec: 35, endSec: 45, confidence: 'medium' },
            ],
        });
        expect(ready.freshness.expiresAtMs).toBeGreaterThan(Date.now());

        const completed = await postJson(
            `${baseUrl}/v1/analysis/jobs/${processing.jobId}/fixture-result`,
            { status: 'ready' },
        );
        expect(completed.status).toBe(200);

        const statusAfter = await fetch(
            `${baseUrl}/v1/analysis/jobs/${processing.jobId}`,
        );
        expect(statusAfter.status).toBe(200);
        await expect(statusAfter.json()).resolves.toMatchObject({
            status: 'ready',
            videoId: 'dQw4w9WgXcQ',
        });
    });

    it('serves a completed worker-backed ready artifact over HTTP', async () => {
        const server = BackendHttpServer.create();
        servers.push(server);
        await listenOnEphemeralPort(server);
        const baseUrl = localServerUrl(server);
        const request = {
            videoId: 'dQw4w9WgXcQ',
            durationSec: 120,
            extensionVersion: '0.1.0',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            client: {
                source: 'chrome-extension',
                capabilities: ['processing-status'],
            },
        };

        const initial = await postJson(`${baseUrl}/v1/analysis`, request);
        expect(initial.status).toBe(202);
        const processing = v.parse(
            processingResponseSchema,
            (await initial.json()) as unknown,
        );
        const completed = await fetch(
            `${baseUrl}/v1/analysis/jobs/${processing.jobId}`,
        );
        expect(completed.status).toBe(200);
        BackendAnalysisJobs.resetForTests();

        const cached = await postJson(`${baseUrl}/v1/analysis`, request);

        expect(cached.status).toBe(200);
        await expect(cached.json()).resolves.toMatchObject({
            status: 'ready',
            videoId: 'dQw4w9WgXcQ',
            source: 'server_cache',
        });
        expect(BackendAnalysisJobs.snapshotForTests().jobCount).toBe(0);
    });

    it('polls a worker-backed no-promo local analysis job over HTTP', async () => {
        const server = BackendHttpServer.create();
        servers.push(server);
        await listenOnEphemeralPort(server);
        const baseUrl = localServerUrl(server);

        const initial = await postJson(`${baseUrl}/v1/analysis`, {
            videoId: 'M7lc1UVf-VE',
            durationSec: 120,
            extensionVersion: '0.1.0',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            client: {
                source: 'chrome-extension',
                capabilities: ['processing-status'],
            },
        });

        expect(initial.status).toBe(202);
        const processing = v.parse(
            processingResponseSchema,
            (await initial.json()) as unknown,
        );

        const status = await fetch(
            `${baseUrl}/v1/analysis/jobs/${processing.jobId}`,
        );

        expect(status.status).toBe(200);
        const noPromo = v.parse(
            noPromoResponseSchema,
            (await status.json()) as unknown,
        );
        expect(noPromo).toEqual({
            status: 'no_promo',
            videoId: 'M7lc1UVf-VE',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            sourceResultId: 'result-M7lc1UVf-VE-server-v4',
            freshness: noPromo.freshness,
        });
        expect(noPromo.freshness.expiresAtMs).toBeGreaterThan(Date.now());
    });

    it('returns unavailable over HTTP when local extraction has no transcript', async () => {
        const server = BackendHttpServer.create();
        servers.push(server);
        await listenOnEphemeralPort(server);
        const baseUrl = localServerUrl(server);

        const initial = await postJson(`${baseUrl}/v1/analysis`, {
            videoId: 'unknownVid1',
            extensionVersion: '0.1.0',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            client: {
                source: 'chrome-extension',
                capabilities: ['processing-status'],
            },
        });

        expect(initial.status).toBe(202);
        const processing = v.parse(
            processingResponseSchema,
            (await initial.json()) as unknown,
        );
        await BackendAnalysisJobs.waitForExtractionForTests(processing.jobId);
        const response = await fetch(
            `${baseUrl}/v1/analysis/jobs/${processing.jobId}`,
        );

        expect(response.status).toBe(200);
        const unavailable = v.parse(
            unavailableResponseSchema,
            (await response.json()) as unknown,
        );
        expect(unavailable).toMatchObject({
            status: 'unavailable',
            videoId: 'unknownVid1',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
        });
        expect(unavailable.error.code).toBe(
            SERVER_ANALYSIS_UNAVAILABLE_REASON.CaptionExtractionFailed,
        );
        expect(unavailable.error.supportId).toMatch(/^support-/u);
    });

    it('returns HTTP 429 for rate-limited cold starts without creating a third job', async () => {
        const server = BackendHttpServer.create();
        servers.push(server);
        await listenOnEphemeralPort(server);
        const baseUrl = localServerUrl(server);

        const requestFor = (videoId: string) => ({
            videoId,
            extensionVersion: '0.1.0',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            client: {
                source: 'chrome-extension',
                capabilities: ['processing-status'],
            },
        });

        expect(
            (
                await postJson(
                    `${baseUrl}/v1/analysis`,
                    requestFor('dQw4w9WgXcQ'),
                )
            ).status,
        ).toBe(202);
        expect(
            (
                await postJson(
                    `${baseUrl}/v1/analysis`,
                    requestFor('M7lc1UVf-VE'),
                )
            ).status,
        ).toBe(202);

        const limited = await postJson(
            `${baseUrl}/v1/analysis`,
            requestFor('aqz-KE-bpKQ'),
        );

        expect(limited.status).toBe(429);
        const body = v.parse(
            rateLimitedResponseSchema,
            (await limited.json()) as unknown,
        );
        expect(body.status).toBe('rate_limited');
        expect(body.error.retryAfterSec).toBeGreaterThan(0);
        expect(limited.headers.get('retry-after')).toBe(
            String(body.error.retryAfterSec),
        );
        expect(body.error).toMatchObject({
            code: 'rate_limited',
        });
        expect(BackendAnalysisJobs.snapshotForTests().jobCount).toBe(2);
    });

    it('returns job_not_found for unknown job routes', async () => {
        const server = BackendHttpServer.create();
        servers.push(server);
        await listenOnEphemeralPort(server);
        const baseUrl = localServerUrl(server);

        const statusResponse = await fetch(
            `${baseUrl}/v1/analysis/jobs/missing-job`,
        );
        expect(statusResponse.status).toBe(404);
        await expect(statusResponse.json()).resolves.toEqual({
            status: 'error',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            error: {
                code: 'job_not_found',
            },
        });

        const completionResponse = await postJson(
            `${baseUrl}/v1/analysis/jobs/missing-job/fixture-result`,
            { status: 'ready' },
        );
        expect(completionResponse.status).toBe(404);
        await expect(completionResponse.json()).resolves.toEqual({
            status: 'error',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            error: {
                code: 'job_not_found',
            },
        });
    });

    it('keeps undeclared v2 routes outside the v1 compatibility boundary', async () => {
        const server = BackendHttpServer.create();
        servers.push(server);
        await listenOnEphemeralPort(server);

        const response = await fetch(`${localServerUrl(server)}/v2/config`);
        const body: unknown = await response.json();

        expect(response.status).toBe(404);
        expect(body).toEqual({
            status: 'error',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            error: { code: 'invalid_request' },
        });
        expect(body).not.toHaveProperty('apiVersion');
    });

    it('negotiates typed failures independently on every public request', async () => {
        BackendPublicState.configureForTests();
        const server = BackendHttpServer.create({
            requireAuth: true,
            now: () => 1_900_000_000_000,
        });
        servers.push(server);
        await listenOnEphemeralPort(server);
        const baseUrl = localServerUrl(server);
        try {
            const registration = await fetch(
                `${baseUrl}/v1/installations/register`,
                { method: 'POST' },
            );
            const registrationBody: unknown = await registration.json();
            if (
                registrationBody === null ||
                typeof registrationBody !== 'object' ||
                !('token' in registrationBody) ||
                typeof registrationBody.token !== 'string'
            ) {
                throw new Error('Expected registration token.');
            }
            const authorization = `Bearer ${registrationBody.token}`;

            const typedMalformed = await fetch(`${baseUrl}/v1/analysis`, {
                method: 'POST',
                headers: {
                    authorization,
                    'content-type': MIME_APPLICATION_JSON,
                    [TOPSKIP_CAPABILITIES_HEADER_NAME]:
                        'typed-server-errors-v1',
                },
                body: '{not-json',
            });
            await expect(typedMalformed.json()).resolves.toMatchObject({
                status: 'error',
                error: { code: 'invalid_request' },
            });

            const legacyMalformed = await fetch(`${baseUrl}/v1/analysis`, {
                method: 'POST',
                headers: {
                    authorization,
                    'content-type': MIME_APPLICATION_JSON,
                },
                body: '{not-json',
            });
            await expect(legacyMalformed.json()).resolves.toMatchObject({
                status: 'invalid_request',
                error: { code: 'invalid_request' },
            });

            const bodyNegotiated = await fetch(`${baseUrl}/v1/analysis`, {
                method: 'POST',
                headers: {
                    authorization,
                    'content-type': MIME_APPLICATION_JSON,
                },
                body: JSON.stringify({
                    videoId: 'unknownVid1',
                    durationSec: 18_001,
                    extensionVersion: '0.1.0',
                    client: {
                        source: 'chrome-extension',
                        capabilities: ['typed-server-errors-v1'],
                    },
                }),
            });
            await expect(bodyNegotiated.json()).resolves.toMatchObject({
                status: 'unavailable',
                error: { code: 'video_too_long' },
            });

            const legacyPoll = await fetch(
                `${baseUrl}/v1/analysis/jobs/missing-job`,
                { headers: { authorization } },
            );
            await expect(legacyPoll.json()).resolves.toMatchObject({
                status: 'invalid_request',
                error: { code: 'job_not_found' },
            });

            const typedPoll = await fetch(
                `${baseUrl}/v1/analysis/jobs/missing-job`,
                {
                    headers: {
                        authorization,
                        [TOPSKIP_CAPABILITIES_HEADER_NAME]:
                            'typed-server-errors-v1',
                    },
                },
            );
            await expect(typedPoll.json()).resolves.toMatchObject({
                status: 'error',
                error: { code: 'job_not_found' },
            });
        } finally {
            BackendPublicState.resetForTests();
        }
    });

    it('returns HTTP 202 consistently while a polled job is active', async () => {
        let release:
            | ((result: SubtitleExtractionStrategyResult) => void)
            | undefined;
        const processing = BackendAnalysisJobs.start({
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            nowMs: 1_900_000_000_000,
            extractionStrategies: [
                {
                    name: 'pending_extraction',
                    extract: () =>
                        new Promise((resolve) => {
                            release = resolve;
                        }),
                },
            ],
        });
        if (processing.status !== 'processing') {
            throw new Error('Expected processing response.');
        }
        const server = BackendHttpServer.create();
        servers.push(server);
        await listenOnEphemeralPort(server);

        const response = await fetch(
            `${localServerUrl(server)}/v1/analysis/jobs/${processing.jobId}`,
        );

        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toEqual(processing);
        release?.({
            status: 'failed',
            failureReason: 'strategy_error',
            diagnostics: { code: 'video_unavailable' },
        });
        await BackendAnalysisJobs.waitForExtractionForTests(processing.jobId);
    });

    it('applies exact production CORS and denies originless mutations', async () => {
        const allowedOrigin = `chrome-extension://${'a'.repeat(32)}`;
        process.env.TOPSKIP_ALLOWED_EXTENSION_ORIGINS = allowedOrigin;
        const server = BackendHttpServer.create({
            requireAuth: false,
            production: true,
        });
        servers.push(server);
        await listenOnEphemeralPort(server);
        const baseUrl = localServerUrl(server);

        const preflight = await fetch(`${baseUrl}/v1/analysis`, {
            method: 'OPTIONS',
            headers: {
                origin: allowedOrigin,
                'access-control-request-method': 'POST',
            },
        });
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get('access-control-allow-origin')).toBe(
            allowedOrigin,
        );
        expect(preflight.headers.get('access-control-allow-headers')).toContain(
            TOPSKIP_CAPABILITIES_HEADER_NAME,
        );

        const originless = await postJson(`${baseUrl}/v1/analysis`, {
            videoId: 'dQw4w9WgXcQ',
            extensionVersion: '0.1.0',
            client: {
                source: 'chrome-extension',
                capabilities: ['typed-server-errors-v1'],
            },
        });
        expect(originless.status).toBe(404);

        const allowed = await postJson(
            `${baseUrl}/v1/analysis`,
            {
                videoId: 'dQw4w9WgXcQ',
                extensionVersion: '0.1.0',
                client: {
                    source: 'chrome-extension',
                    capabilities: ['typed-server-errors-v1'],
                },
            },
            { origin: allowedOrigin },
        );
        expect(allowed.status).toBe(202);
        expect(allowed.headers.get('access-control-allow-origin')).toBe(
            allowedOrigin,
        );

        const denied = await fetch(`${baseUrl}/v1/analysis`, {
            method: 'OPTIONS',
            headers: {
                origin: `chrome-extension://${'b'.repeat(32)}`,
                'access-control-request-method': 'POST',
            },
        });
        expect(denied.status).toBe(404);
        expect(denied.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('maps unexpected request faults to recorded internal_error', async () => {
        BackendPublicState.configureForTests();
        const authenticate = vi
            .spyOn(BackendPublicState, 'authenticateInstallation')
            .mockImplementation(() => {
                throw new Error('sqlite unavailable');
            });
        const server = BackendHttpServer.create({ requireAuth: true });
        servers.push(server);
        await listenOnEphemeralPort(server);
        try {
            const response = await postJson(
                `${localServerUrl(server)}/v1/analysis`,
                {
                    videoId: 'dQw4w9WgXcQ',
                    extensionVersion: '0.1.0',
                    client: {
                        source: 'chrome-extension',
                        capabilities: ['typed-server-errors-v1'],
                    },
                },
                {
                    authorization: 'Bearer unusable-token',
                    [TOPSKIP_CAPABILITIES_HEADER_NAME]:
                        'typed-server-errors-v1',
                },
            );
            const body: unknown = await response.json();

            expect(response.status).toBe(500);
            expect(body).toMatchObject({
                status: 'error',
                error: {
                    code: 'internal_error',
                },
            });
            const error: unknown =
                body !== null && typeof body === 'object'
                    ? Reflect.get(body, 'error')
                    : null;
            const supportId: unknown =
                error !== null && typeof error === 'object'
                    ? Reflect.get(error, 'supportId')
                    : null;
            expect(supportId).toMatch(/^support-/u);
        } finally {
            authenticate.mockRestore();
            BackendPublicState.resetForTests();
        }
    });
});
