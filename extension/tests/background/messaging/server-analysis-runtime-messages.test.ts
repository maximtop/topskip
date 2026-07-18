import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const prefsMocks = vi.hoisted(() => ({
    ready: vi.fn().mockResolvedValue(undefined),
    load: vi.fn(),
}));

vi.mock('@/background/storage/prefs-sync', () => ({
    PrefsSyncStorage: prefsMocks,
}));

const clientMocks = vi.hoisted(() => ({
    requestAnalysis: vi.fn(),
    requestJobStatus: vi.fn(),
}));

vi.mock('@/background/server-analysis-client', () => ({
    ServerAnalysisClient: clientMocks,
}));

const configurationMocks = vi.hoisted(() => ({
    loadActive: vi.fn(),
    loadCached: vi.fn(),
    noteAlgorithmVersion: vi.fn(),
}));

vi.mock('@/background/server-analysis-configuration', () => ({
    ServerAnalysisConfiguration: configurationMocks,
}));

const cacheMocks = vi.hoisted(() => ({
    loadExact: vi.fn(),
    saveTerminalResponse: vi.fn(),
}));

vi.mock('@/background/storage/server-result-cache', () => ({
    ServerResultCacheStorage: cacheMocks,
}));

const detectionMocks = vi.hoisted(() => ({
    set: vi.fn<(tabId: number, state: PromoDetectionStatePayload) => boolean>(),
    clear: vi.fn(),
}));

vi.mock('@/background/promo-detection-store', () => ({
    PromoDetectionStore: detectionMocks,
}));

const browserMocks = vi.hoisted(() => ({
    tabsSendMessage: vi.fn(),
    tabsGet: vi.fn(),
}));

vi.mock('@/shared/browser', () => ({
    default: {
        runtime: { getManifest: () => ({ version: '0.1.0' }) },
        tabs: {
            sendMessage: browserMocks.tabsSendMessage,
            get: browserMocks.tabsGet,
        },
    },
}));

import { ServerAnalysisRuntimeMessages } from '@/background/messaging/server-analysis-runtime-messages';
import {
    TOPSKIP_MESSAGE,
    type PromoDetectionStatePayload,
} from '@/shared/messages';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const VIDEO_ID = 'dQw4w9WgXcQ';
const LANGUAGE_CODE = 'en';
const SEGMENTS = [{ startSec: 0, durationSec: 1, text: 'Caption' }];
const TRANSCRIPT_HASH = createHash('sha256')
    .update('[[0,1,"Caption"]]')
    .digest('hex');
const IDENTITY = {
    videoId: VIDEO_ID,
    languageCode: LANGUAGE_CODE,
    transcriptHash: TRANSCRIPT_HASH,
    algorithmVersion: 'server-v5',
};
const REQUEST = {
    sessionId: SESSION_ID,
    videoId: VIDEO_ID,
    durationSec: 213,
    languageCode: LANGUAGE_CODE,
    segments: SEGMENTS,
};
const SENDER = { tab: { id: 42 } } as never;
const CONFIG = {
    apiVersion: 1 as const,
    algorithmVersion: 'server-v5',
    supportedCapabilities: ['processing-status', 'typed-server-errors-v1'],
    supportIssueBaseUrl: 'https://github.com/maximtop/topskip/issues/new',
};

describe('ServerAnalysisRuntimeMessages', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        prefsMocks.load.mockResolvedValue({
            enabled: true,
            providerId: 'openrouter',
            activeModelId: 'openrouter:test',
            analysisMode: 'server',
        });
        configurationMocks.loadActive.mockResolvedValue(CONFIG);
        configurationMocks.loadCached.mockResolvedValue(CONFIG);
        configurationMocks.noteAlgorithmVersion.mockResolvedValue(undefined);
        cacheMocks.loadExact.mockResolvedValue(null);
        cacheMocks.saveTerminalResponse.mockResolvedValue(undefined);
        browserMocks.tabsGet.mockResolvedValue({
            url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
        });
        browserMocks.tabsSendMessage.mockResolvedValue(undefined);
        clientMocks.requestAnalysis.mockResolvedValue({
            status: 'processing',
            ...IDENTITY,
            jobId: 'job-v5',
            pollAfterSec: 3,
        });
        clientMocks.requestJobStatus.mockResolvedValue({
            status: 'processing',
            ...IDENTITY,
            jobId: 'job-v5',
            pollAfterSec: 3,
        });
    });

    it('separates Server and Private BYOK without cache or HTTP traffic', async () => {
        prefsMocks.load.mockResolvedValueOnce({
            enabled: true,
            providerId: 'openrouter',
            activeModelId: 'openrouter:test',
            analysisMode: 'byok',
        });

        await expect(
            ServerAnalysisRuntimeMessages.handleRequest(REQUEST, SENDER),
        ).resolves.toEqual({ ok: true, status: 'inactive' });
        expect(configurationMocks.loadActive).not.toHaveBeenCalled();
        expect(cacheMocks.loadExact).not.toHaveBeenCalled();
        expect(clientMocks.requestAnalysis).not.toHaveBeenCalled();
        expect(clientMocks.requestJobStatus).not.toHaveBeenCalled();
    });

    it('reports local caption outcomes without TopSkip traffic', async () => {
        await ServerAnalysisRuntimeMessages.handleSessionEvent(
            {
                event: 'acquisition_started',
                sessionId: SESSION_ID,
                videoId: VIDEO_ID,
            },
            SENDER,
        );
        await ServerAnalysisRuntimeMessages.handleSessionEvent(
            {
                event: 'captions_unavailable',
                sessionId: SESSION_ID,
                videoId: VIDEO_ID,
            },
            SENDER,
        );

        const detectionCall = detectionMocks.set.mock.lastCall;
        expect(detectionCall).toBeDefined();
        if (detectionCall === undefined) {
            throw new Error('Expected a terminal detection state.');
        }
        const [tabId, state] = detectionCall;
        expect(tabId).toBe(42);
        expect(state.videoId).toBe(VIDEO_ID);
        expect(state.status).toBe('unavailable');
        expect(state.serverFailure).toMatchObject({
            code: 'captions_unavailable',
            apiVersion: 1,
            extensionVersion: '0.1.0',
        });
        expect(configurationMocks.loadActive).not.toHaveBeenCalled();
        expect(cacheMocks.loadExact).not.toHaveBeenCalled();
        expect(clientMocks.requestAnalysis).not.toHaveBeenCalled();
        expect(clientMocks.requestJobStatus).not.toHaveBeenCalled();
    });

    it('uses exact caption identity for cache and processing', async () => {
        await expect(
            ServerAnalysisRuntimeMessages.handleRequest(REQUEST, SENDER),
        ).resolves.toEqual({
            ok: true,
            status: 'processing',
            jobId: 'job-v5',
            pollAfterSec: 3,
            identity: IDENTITY,
        });
        expect(cacheMocks.loadExact).toHaveBeenCalledWith({
            ...IDENTITY,
        });
        expect(clientMocks.requestAnalysis).toHaveBeenCalledWith({
            videoId: VIDEO_ID,
            durationSec: 213,
            extensionVersion: '0.1.0',
            languageCode: LANGUAGE_CODE,
            segments: SEGMENTS,
        });
    });

    it('bypasses cache without config history and still submits captions', async () => {
        configurationMocks.loadActive.mockResolvedValueOnce(null);

        await ServerAnalysisRuntimeMessages.handleRequest(REQUEST, SENDER);

        expect(cacheMocks.loadExact).not.toHaveBeenCalled();
        expect(clientMocks.requestAnalysis).toHaveBeenCalledOnce();
    });

    it('delivers an exact ready cache hit with its session id', async () => {
        const promoBlocks = [{ startSec: 4, endSec: 24 }];
        cacheMocks.loadExact.mockResolvedValueOnce({
            status: 'ready',
            ...IDENTITY,
            sourceResultId: 'result-v5',
            freshness: { expiresAtMs: 4_102_444_800_000 },
            promoBlocks,
            storedAtMs: 1_900_000_000_000,
        });

        await expect(
            ServerAnalysisRuntimeMessages.handleRequest(REQUEST, SENDER),
        ).resolves.toEqual({ ok: true, status: 'ready' });
        expect(clientMocks.requestAnalysis).not.toHaveBeenCalled();
        expect(browserMocks.tabsSendMessage).toHaveBeenCalledWith(42, {
            type: TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED,
            source: 'local_cache',
            sessionId: SESSION_ID,
            videoId: VIDEO_ID,
            promoBlocks,
        });
    });

    it('rejects invalid captions before config, cache, or HTTP', async () => {
        await expect(
            ServerAnalysisRuntimeMessages.handleRequest(
                { ...REQUEST, segments: [] },
                SENDER,
            ),
        ).resolves.toEqual({ ok: true, status: 'unavailable' });
        expect(configurationMocks.loadActive).not.toHaveBeenCalled();
        expect(cacheMocks.loadExact).not.toHaveBeenCalled();
        expect(clientMocks.requestAnalysis).not.toHaveBeenCalled();
    });

    it('polls with explicit identity after a service-worker restart', async () => {
        await expect(
            ServerAnalysisRuntimeMessages.handleRefreshStatus(
                {
                    sessionId: SESSION_ID,
                    videoId: VIDEO_ID,
                    jobId: 'job-v5',
                    identity: IDENTITY,
                },
                SENDER,
            ),
        ).resolves.toMatchObject({
            ok: true,
            status: 'processing',
            identity: IDENTITY,
        });
        expect(clientMocks.requestJobStatus).toHaveBeenCalledWith({
            jobId: 'job-v5',
            identity: IDENTITY,
        });
    });

    it('requests one exact content resubmission when a deployed job disappears', async () => {
        clientMocks.requestJobStatus.mockResolvedValueOnce({
            status: 'error',
            algorithmVersion: 'server-v5',
            error: { code: 'job_not_found' },
        });

        await expect(
            ServerAnalysisRuntimeMessages.handleRefreshStatus(
                {
                    sessionId: SESSION_ID,
                    videoId: VIDEO_ID,
                    jobId: 'job-v5',
                    identity: IDENTITY,
                },
                SENDER,
            ),
        ).resolves.toEqual({ ok: true, status: 'resubmit_required' });
        expect(clientMocks.requestAnalysis).not.toHaveBeenCalled();
    });

    it('persists and delivers a terminal server result', async () => {
        const ready = {
            status: 'ready' as const,
            ...IDENTITY,
            source: 'server_cache' as const,
            sourceResultId: 'result-v5',
            freshness: { expiresAtMs: 4_102_444_800_000 },
            promoBlocks: [{ startSec: 4, endSec: 24 }],
        };
        clientMocks.requestAnalysis.mockResolvedValueOnce(ready);

        await expect(
            ServerAnalysisRuntimeMessages.handleRequest(REQUEST, SENDER),
        ).resolves.toEqual({ ok: true, status: 'ready' });
        expect(cacheMocks.saveTerminalResponse).toHaveBeenCalledWith(ready);
        expect(browserMocks.tabsSendMessage).toHaveBeenCalledWith(
            42,
            expect.objectContaining({
                sessionId: SESSION_ID,
                promoBlocks: ready.promoBlocks,
            }),
        );
    });
});
