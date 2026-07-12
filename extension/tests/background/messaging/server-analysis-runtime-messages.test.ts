import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefsMocks = vi.hoisted(() => ({
    ready: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue({
        enabled: true,
        providerId: 'openrouter',
        activeModelId: 'openrouter:google/gemini-3.1-pro-preview',
        analysisMode: 'server',
    }),
}));

vi.mock('@/background/storage/prefs-sync', () => ({
    PrefsSyncStorage: prefsMocks,
}));

const clientMocks = vi.hoisted(() => ({
    requestAnalysis: vi.fn().mockResolvedValue({
        status: 'processing',
        videoId: 'dQw4w9WgXcQ',
        algorithmVersion: 'server-v1',
        jobId: 'local-dQw4w9WgXcQ-server-v1',
        pollAfterSec: 3,
    }),
    requestJobStatus: vi.fn().mockResolvedValue({
        status: 'processing',
        videoId: 'dQw4w9WgXcQ',
        algorithmVersion: 'server-v1',
        jobId: 'local-dQw4w9WgXcQ-server-v1',
        pollAfterSec: 3,
    }),
}));

vi.mock('@/background/server-analysis-client', () => ({
    ServerAnalysisClient: clientMocks,
}));

const cacheMocks = vi.hoisted(() => ({
    loadFresh: vi.fn().mockResolvedValue(null),
    saveReadyResponse: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/background/storage/server-result-cache', () => ({
    ServerResultCacheStorage: cacheMocks,
}));

const detectionMocks = vi.hoisted(() => ({
    set: vi.fn(),
}));

const browserMocks = vi.hoisted(() => ({
    tabsSendMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/background/promo-detection-store', () => ({
    PromoDetectionStore: detectionMocks,
}));

vi.mock('@/shared/browser', () => ({
    default: {
        runtime: {
            getManifest: () => ({ version: '0.1.0' }),
        },
        tabs: {
            sendMessage: browserMocks.tabsSendMessage,
        },
    },
}));

import { ServerAnalysisRuntimeMessages } from '@/background/messaging/server-analysis-runtime-messages';
import { TOPSKIP_MESSAGE } from '@/shared/messages';
import type { PromoBlock } from '@/shared/promo-types';

describe('ServerAnalysisRuntimeMessages', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        cacheMocks.loadFresh.mockResolvedValue(null);
        cacheMocks.saveReadyResponse.mockResolvedValue(undefined);
    });

    it('does not read cache or call backend for an initial BYOK request', async () => {
        prefsMocks.load.mockResolvedValueOnce({
            enabled: true,
            providerId: 'openrouter',
            activeModelId: 'openrouter:test',
            analysisMode: 'byok',
        });

        const result = await ServerAnalysisRuntimeMessages.handleRequest(
            { videoId: 'dQw4w9WgXcQ', durationSec: 213 },
            { tab: { id: 42 } } as never,
        );

        expect(result).toEqual({ ok: true, status: 'inactive' });
        expect(cacheMocks.loadFresh).not.toHaveBeenCalled();
        expect(cacheMocks.saveReadyResponse).not.toHaveBeenCalled();
        expect(clientMocks.requestAnalysis).not.toHaveBeenCalled();
        expect(clientMocks.requestJobStatus).not.toHaveBeenCalled();
        expect(browserMocks.tabsSendMessage).not.toHaveBeenCalled();
        expect(detectionMocks.set).not.toHaveBeenCalled();
    });

    it('maps processing response into server pending detection state', async () => {
        const result = await ServerAnalysisRuntimeMessages.handleRequest(
            { videoId: 'dQw4w9WgXcQ', durationSec: 213 },
            { tab: { id: 42 } } as never,
        );

        expect(result).toEqual({
            ok: true,
            status: 'processing',
            jobId: 'local-dQw4w9WgXcQ-server-v1',
            pollAfterSec: 3,
        });
        expect(clientMocks.requestAnalysis).toHaveBeenCalledWith({
            videoId: 'dQw4w9WgXcQ',
            durationSec: 213,
            extensionVersion: '0.1.0',
        });
        expect(cacheMocks.loadFresh).toHaveBeenCalledWith({
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: 'server-v1',
        });
        expect(detectionMocks.set).toHaveBeenCalledWith(42, {
            videoId: 'dQw4w9WgXcQ',
            status: 'analyzing',
            source: 'server',
        });
    });

    it('delivers a fresh local cache hit without calling the backend', async () => {
        const blocks: PromoBlock[] = [
            { startSec: 4, endSec: 24, confidence: 'high' },
        ];
        cacheMocks.loadFresh.mockResolvedValueOnce({
            videoId: 'e2eFixture1',
            algorithmVersion: 'server-v1',
            sourceResultId: 'result-e2eFixture1-server-v1',
            freshness: { expiresAtMs: 4_102_444_800_000 },
            promoBlocks: blocks,
            storedAtMs: 1_900_000_000_000,
        });

        const result = await ServerAnalysisRuntimeMessages.handleRequest(
            { videoId: 'e2eFixture1', durationSec: 120 },
            { tab: { id: 42 } } as never,
        );

        expect(result).toEqual({ ok: true, status: 'ready' });
        expect(clientMocks.requestAnalysis).not.toHaveBeenCalled();
        expect(browserMocks.tabsSendMessage).toHaveBeenCalledWith(42, {
            type: TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED,
            videoId: 'e2eFixture1',
            promoBlocks: blocks,
        });
        expect(detectionMocks.set).toHaveBeenCalledWith(42, {
            videoId: 'e2eFixture1',
            status: 'detected',
            source: 'local_cache',
            promoBlocks: blocks,
        });
    });

    it('maps client failures into server error detection state', async () => {
        clientMocks.requestAnalysis.mockRejectedValueOnce(
            new Error('Server analysis timed out.'),
        );

        const result = await ServerAnalysisRuntimeMessages.handleRequest(
            { videoId: 'dQw4w9WgXcQ', durationSec: 213 },
            { tab: { id: 42 } } as never,
        );

        expect(result).toEqual({
            ok: false,
            error: 'Server analysis timed out.',
        });
        expect(detectionMocks.set).toHaveBeenCalledWith(42, {
            videoId: 'dQw4w9WgXcQ',
            status: 'error',
            source: 'server',
            error: 'Server analysis timed out.',
        });
    });

    it('sends ready server cache blocks to content and popup state', async () => {
        const blocks: PromoBlock[] = [
            { startSec: 4, endSec: 24, confidence: 'high' },
        ];
        clientMocks.requestAnalysis.mockResolvedValueOnce({
            status: 'ready',
            videoId: 'e2eFixture1',
            algorithmVersion: 'server-v1',
            source: 'server_cache',
            sourceResultId: 'result-e2eFixture1-server-v1',
            freshness: { expiresAtMs: 4_102_444_800_000 },
            promoBlocks: blocks,
        });

        const result = await ServerAnalysisRuntimeMessages.handleRequest(
            { videoId: 'e2eFixture1', durationSec: 120 },
            { tab: { id: 42 } } as never,
        );

        expect(result).toEqual({ ok: true, status: 'ready' });
        expect(cacheMocks.saveReadyResponse).toHaveBeenCalledWith({
            status: 'ready',
            videoId: 'e2eFixture1',
            algorithmVersion: 'server-v1',
            source: 'server_cache',
            sourceResultId: 'result-e2eFixture1-server-v1',
            freshness: { expiresAtMs: 4_102_444_800_000 },
            promoBlocks: blocks,
        });
        expect(browserMocks.tabsSendMessage).toHaveBeenCalledWith(42, {
            type: TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED,
            videoId: 'e2eFixture1',
            promoBlocks: blocks,
        });
        expect(detectionMocks.set).toHaveBeenCalledWith(42, {
            videoId: 'e2eFixture1',
            status: 'detected',
            source: 'server_cache',
            promoBlocks: blocks,
        });
    });

    it('does not deliver ready blocks when the backend video id differs', async () => {
        clientMocks.requestAnalysis.mockResolvedValueOnce({
            status: 'ready',
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: 'server-v1',
            source: 'server_cache',
            sourceResultId: 'result-dQw4w9WgXcQ-server-v1',
            freshness: { expiresAtMs: 4_102_444_800_000 },
            promoBlocks: [{ startSec: 4, endSec: 24 }],
        });

        const result = await ServerAnalysisRuntimeMessages.handleRequest(
            { videoId: 'e2eFixture1', durationSec: 120 },
            { tab: { id: 42 } } as never,
        );

        expect(result).toEqual({
            ok: false,
            error: 'Server returned analysis for a different video.',
        });
        expect(browserMocks.tabsSendMessage).not.toHaveBeenCalled();
        expect(detectionMocks.set).toHaveBeenCalledWith(42, {
            videoId: 'e2eFixture1',
            status: 'error',
            source: 'server',
            error: 'Server returned analysis for a different video.',
        });
    });

    it('rejects ready backend results for a different algorithm version', async () => {
        clientMocks.requestAnalysis.mockResolvedValueOnce({
            status: 'ready',
            videoId: 'e2eFixture1',
            algorithmVersion: 'server-v0',
            source: 'server_cache',
            sourceResultId: 'result-e2eFixture1-server-v0',
            freshness: { expiresAtMs: 4_102_444_800_000 },
            promoBlocks: [{ startSec: 4, endSec: 24 }],
        });

        const result = await ServerAnalysisRuntimeMessages.handleRequest(
            { videoId: 'e2eFixture1', durationSec: 120 },
            { tab: { id: 42 } } as never,
        );

        expect(result).toEqual({
            ok: false,
            error: 'Server returned analysis for an unsupported algorithm version.',
        });
        expect(cacheMocks.saveReadyResponse).not.toHaveBeenCalled();
        expect(browserMocks.tabsSendMessage).not.toHaveBeenCalled();
        expect(detectionMocks.set).toHaveBeenCalledWith(42, {
            videoId: 'e2eFixture1',
            status: 'error',
            source: 'server',
            error: 'Server returned analysis for an unsupported algorithm version.',
        });
    });

    it('delivers ready backend blocks when saving the local cache fails', async () => {
        const blocks: PromoBlock[] = [{ startSec: 4, endSec: 24 }];
        cacheMocks.saveReadyResponse.mockRejectedValueOnce(
            new Error('storage write failed'),
        );
        clientMocks.requestAnalysis.mockResolvedValueOnce({
            status: 'ready',
            videoId: 'e2eFixture1',
            algorithmVersion: 'server-v1',
            source: 'server_cache',
            sourceResultId: 'result-e2eFixture1-server-v1',
            freshness: { expiresAtMs: 4_102_444_800_000 },
            promoBlocks: blocks,
        });

        const result = await ServerAnalysisRuntimeMessages.handleRequest(
            { videoId: 'e2eFixture1', durationSec: 120 },
            { tab: { id: 42 } } as never,
        );

        expect(result).toEqual({ ok: true, status: 'ready' });
        expect(cacheMocks.saveReadyResponse).toHaveBeenCalled();
        expect(browserMocks.tabsSendMessage).toHaveBeenCalledWith(42, {
            type: TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED,
            videoId: 'e2eFixture1',
            promoBlocks: blocks,
        });
        expect(detectionMocks.set).toHaveBeenCalledWith(42, {
            videoId: 'e2eFixture1',
            status: 'detected',
            source: 'server_cache',
            promoBlocks: blocks,
        });
    });

    it('refreshes a processing job and delivers ready blocks', async () => {
        const blocks: PromoBlock[] = [
            { startSec: 4, endSec: 24, confidence: 'high' },
            { startSec: 35, endSec: 45, confidence: 'medium' },
        ];
        clientMocks.requestJobStatus.mockResolvedValueOnce({
            status: 'ready',
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: 'server-v1',
            source: 'server_cache',
            sourceResultId: 'result-dQw4w9WgXcQ-server-v1',
            freshness: { expiresAtMs: 4_102_444_800_000 },
            promoBlocks: blocks,
        });

        const result = await ServerAnalysisRuntimeMessages.handleRefreshStatus(
            {
                videoId: 'dQw4w9WgXcQ',
                jobId: 'local-dQw4w9WgXcQ-server-v1',
            },
            { tab: { id: 42 } } as never,
        );

        expect(result).toEqual({ ok: true, status: 'ready' });
        expect(browserMocks.tabsSendMessage).toHaveBeenCalledWith(42, {
            type: TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED,
            videoId: 'dQw4w9WgXcQ',
            promoBlocks: blocks,
        });
    });

    it('does not fetch job status when current prefs leave server mode', async () => {
        prefsMocks.load.mockResolvedValueOnce({
            enabled: true,
            providerId: 'openrouter',
            activeModelId: 'openrouter:google/gemini-3.1-pro-preview',
            analysisMode: 'byok',
        });

        const result = await ServerAnalysisRuntimeMessages.handleRefreshStatus(
            {
                videoId: 'dQw4w9WgXcQ',
                jobId: 'local-dQw4w9WgXcQ-server-v1',
            },
            { tab: { id: 42 } } as never,
        );

        expect(result).toEqual({ ok: true, status: 'inactive' });
        expect(clientMocks.requestJobStatus).not.toHaveBeenCalled();
        expect(browserMocks.tabsSendMessage).not.toHaveBeenCalled();
    });

    it.each([
        {
            response: {
                status: 'no_promo',
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: 'server-v1',
                sourceResultId: 'result-dQw4w9WgXcQ-server-v1',
                freshness: { expiresAtMs: 4_102_444_800_000 },
            },
            expectedState: {
                videoId: 'dQw4w9WgXcQ',
                status: 'no_promo',
                source: 'server',
            },
            expectedStatus: 'no_promo',
        },
        {
            response: {
                status: 'unavailable',
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: 'server-v1',
                reason: 'fixture_unavailable',
                message: 'Fixture analysis is unavailable.',
            },
            expectedState: {
                videoId: 'dQw4w9WgXcQ',
                status: 'unavailable',
                source: 'server',
                error: 'Fixture analysis is unavailable.',
            },
            expectedStatus: 'unavailable',
        },
        {
            response: {
                status: 'error',
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: 'server-v1',
                error: {
                    code: 'fixture_error',
                    message: 'Fixture job failed.',
                },
            },
            expectedState: {
                videoId: 'dQw4w9WgXcQ',
                status: 'error',
                source: 'server',
                error: 'Fixture job failed.',
            },
            expectedStatus: 'error',
        },
        {
            response: {
                status: 'rate_limited',
                retryAfterSec: 60,
                error: {
                    code: 'rate_limited',
                    message: 'Local cold-analysis limit reached. Retry later.',
                },
            },
            expectedState: {
                videoId: 'dQw4w9WgXcQ',
                status: 'unavailable',
                source: 'server',
                error: 'Local cold-analysis limit reached. Retry later.',
            },
            expectedStatus: 'rate_limited',
        },
    ])(
        'maps $expectedStatus refresh responses without delivering blocks',
        async ({ response, expectedState, expectedStatus }) => {
            clientMocks.requestJobStatus.mockResolvedValueOnce(response);

            const result =
                await ServerAnalysisRuntimeMessages.handleRefreshStatus(
                    {
                        videoId: 'dQw4w9WgXcQ',
                        jobId: 'local-dQw4w9WgXcQ-server-v1',
                    },
                    { tab: { id: 42 } } as never,
                );

            expect(result).toEqual({ ok: true, status: expectedStatus });
            expect(browserMocks.tabsSendMessage).not.toHaveBeenCalled();
            expect(detectionMocks.set).toHaveBeenCalledWith(42, expectedState);
        },
    );

    it.each([
        {
            response: {
                status: 'no_promo',
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: 'server-v1',
                sourceResultId: 'result-dQw4w9WgXcQ-server-v1',
                freshness: { expiresAtMs: 4_102_444_800_000 },
            },
            expectedState: {
                videoId: 'dQw4w9WgXcQ',
                status: 'no_promo',
                source: 'server',
            },
            expectedStatus: 'no_promo',
        },
        {
            response: {
                status: 'unavailable',
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: 'server-v1',
                reason: 'fixture_unavailable',
                message: 'Fixture analysis is unavailable.',
            },
            expectedState: {
                videoId: 'dQw4w9WgXcQ',
                status: 'unavailable',
                source: 'server',
                error: 'Fixture analysis is unavailable.',
            },
            expectedStatus: 'unavailable',
        },
        {
            response: {
                status: 'error',
                videoId: 'dQw4w9WgXcQ',
                algorithmVersion: 'server-v1',
                error: {
                    code: 'fixture_error',
                    message: 'Fixture job failed.',
                },
            },
            expectedState: {
                videoId: 'dQw4w9WgXcQ',
                status: 'error',
                source: 'server',
                error: 'Fixture job failed.',
            },
            expectedStatus: 'error',
        },
        {
            response: {
                status: 'rate_limited',
                retryAfterSec: 60,
                error: {
                    code: 'rate_limited',
                    message: 'Local cold-analysis limit reached. Retry later.',
                },
            },
            expectedState: {
                videoId: 'dQw4w9WgXcQ',
                status: 'unavailable',
                source: 'server',
                error: 'Local cold-analysis limit reached. Retry later.',
            },
            expectedStatus: 'rate_limited',
        },
    ])(
        'maps $expectedStatus request responses without delivering blocks',
        async ({ response, expectedState, expectedStatus }) => {
            clientMocks.requestAnalysis.mockResolvedValueOnce(response);

            const result = await ServerAnalysisRuntimeMessages.handleRequest(
                { videoId: 'dQw4w9WgXcQ', durationSec: 213 },
                { tab: { id: 42 } } as never,
            );

            expect(result).toEqual({ ok: true, status: expectedStatus });
            expect(browserMocks.tabsSendMessage).not.toHaveBeenCalled();
            expect(cacheMocks.saveReadyResponse).not.toHaveBeenCalled();
            expect(detectionMocks.set).toHaveBeenCalledWith(42, expectedState);
        },
    );

    it.each([
        new Error('Failed to fetch'),
        new Error('Invalid type: Expected Object but received null'),
    ])(
        'maps %s request failures to server errors without delivering blocks',
        async (error) => {
            clientMocks.requestAnalysis.mockRejectedValueOnce(error);

            const result = await ServerAnalysisRuntimeMessages.handleRequest(
                { videoId: 'dQw4w9WgXcQ', durationSec: 213 },
                { tab: { id: 42 } } as never,
            );

            expect(result).toEqual({ ok: false, error: error.message });
            expect(browserMocks.tabsSendMessage).not.toHaveBeenCalled();
            expect(cacheMocks.saveReadyResponse).not.toHaveBeenCalled();
            expect(detectionMocks.set).toHaveBeenCalledWith(42, {
                videoId: 'dQw4w9WgXcQ',
                status: 'error',
                source: 'server',
                error: error.message,
            });
        },
    );

    it('maps worker model errors from status refresh without delivering blocks', async () => {
        clientMocks.requestJobStatus.mockResolvedValueOnce({
            status: 'error',
            videoId: 'dQw4w9WgXcQ',
            algorithmVersion: 'server-v1',
            error: {
                code: 'unsafe_model_blocks',
                message: 'Model returned unsafe promo blocks.',
            },
        });

        const result = await ServerAnalysisRuntimeMessages.handleRefreshStatus(
            {
                videoId: 'dQw4w9WgXcQ',
                jobId: 'local-dQw4w9WgXcQ-server-v1',
            },
            { tab: { id: 42 } } as never,
        );

        expect(result).toEqual({ ok: true, status: 'error' });
        expect(browserMocks.tabsSendMessage).not.toHaveBeenCalled();
        expect(detectionMocks.set).toHaveBeenCalledWith(42, {
            videoId: 'dQw4w9WgXcQ',
            status: 'error',
            source: 'server',
            error: 'Model returned unsafe promo blocks.',
        });
    });
});
