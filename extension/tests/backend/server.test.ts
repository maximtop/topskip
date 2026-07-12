import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as v from 'valibot';

import { BackendApiProtection } from '@/backend/api-protection';
import { AnalysisArtifactStore } from '@/backend/analysis-artifact-store';
import { BackendAnalysisJobs } from '@/backend/analysis-jobs';
import { BackendHttpServer } from '@/backend/server';
import { MIME_APPLICATION_JSON } from '@/shared/constants';
import {
    SERVER_ANALYSIS_ALGORITHM_VERSION,
    SERVER_ANALYSIS_UNAVAILABLE_REASON,
    processingResponseSchema,
    rateLimitedResponseSchema,
} from '@/shared/server-analysis-contract';

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

async function postJson(url: string, body: unknown): Promise<Response> {
    return fetch(url, {
        method: 'POST',
        headers: { 'content-type': MIME_APPLICATION_JSON },
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
            status: 'invalid_request',
            error: {
                code: 'invalid_request',
                message: 'Malformed JSON request body.',
            },
        });
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
            status: 'invalid_request',
            error: {
                code: 'request_body_too_large',
                message: 'Request body exceeds the local API limit.',
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
            sourceResultId: 'result-e2eFixture1-server-v1',
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
        await expect(statusBefore.json()).resolves.toEqual({
            status: 'ready',
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            source: 'server_cache',
            sourceResultId: 'result-dQw4w9WgXcQ-server-v1',
            freshness: { expiresAtMs: 4_102_444_800_000 },
            promoBlocks: [
                { startSec: 4, endSec: 24, confidence: 'high' },
                { startSec: 35, endSec: 45, confidence: 'medium' },
            ],
        });

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
        await expect(status.json()).resolves.toEqual({
            status: 'no_promo',
            videoId: 'M7lc1UVf-VE',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            sourceResultId: 'result-M7lc1UVf-VE-server-v1',
            freshness: { expiresAtMs: 4_102_444_800_000 },
        });
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
        await expect(response.json()).resolves.toEqual({
            status: 'unavailable',
            videoId: 'unknownVid1',
            algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            reason: SERVER_ANALYSIS_UNAVAILABLE_REASON.CaptionExtractionFailed,
            message: 'Caption extraction failed for this video.',
        });
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
        expect(body.retryAfterSec).toBeGreaterThan(0);
        expect(body.error).toEqual({
            code: 'rate_limited',
            message: 'Local cold-analysis limit reached. Retry later.',
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
            status: 'invalid_request',
            error: {
                code: 'job_not_found',
                message: 'Analysis job was not found.',
            },
        });

        const completionResponse = await postJson(
            `${baseUrl}/v1/analysis/jobs/missing-job/fixture-result`,
            { status: 'ready' },
        );
        expect(completionResponse.status).toBe(404);
        await expect(completionResponse.json()).resolves.toEqual({
            status: 'invalid_request',
            error: {
                code: 'job_not_found',
                message: 'Analysis job was not found.',
            },
        });
    });
});
