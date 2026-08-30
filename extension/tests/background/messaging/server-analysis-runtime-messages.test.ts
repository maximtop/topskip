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
    set: vi.fn(
        (
            _tabId: number,
            _state: PromoDetectionStatePayload,
        ): Promise<void> => Promise.resolve(),
    ),
    clear: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/background/promo-detection-store', () => ({
    PromoDetectionStore: detectionMocks,
}));

const browserMocks = vi.hoisted(() => ({
    runtimeId: 'topskip-test-extension',
    tabsSendMessage: vi.fn(),
}));

vi.mock('@/shared/browser', () => ({
    default: {
        runtime: {
            id: browserMocks.runtimeId,
            getManifest: () => ({ version: '0.1.0' }),
        },
        tabs: {
            sendMessage: browserMocks.tabsSendMessage,
        },
    },
}));

import { ServerAnalysisRuntimeMessages } from '@/background/messaging/server-analysis-runtime-messages';
import {
    CONTENT_SCRIPT_PROTOCOL_VERSION,
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
    algorithmVersion: 'server-v6',
};
const REQUEST = {
    sessionId: SESSION_ID,
    videoId: VIDEO_ID,
    durationSec: 213,
    languageCode: LANGUAGE_CODE,
    segments: SEGMENTS,
};
const SENDER = {
    id: browserMocks.runtimeId,
    tab: { id: 42 },
    frameId: 0,
    url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
} as never;
const CONFIG = {
    apiVersion: 1 as const,
    algorithmVersion: 'server-v6',
    supportedCapabilities: ['processing-status', 'typed-server-errors-v1'],
    supportIssueBaseUrl: 'https://github.com/maximtop/topskip/issues/new',
};

/**
 * Returns the live content proof expected for the default request fixture.
 *
 * @returns Current versioned Server route response.
 */
function currentRouteStatus(): Record<string, unknown> {
    return {
        ok: true,
        protocolVersion: CONTENT_SCRIPT_PROTOCOL_VERSION,
        extensionVersion: '0.1.0',
        videoId: VIDEO_ID,
        enabled: true,
        analysisMode: 'server',
        serverSessionId: SESSION_ID,
    };
}

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
        browserMocks.tabsSendMessage.mockImplementation(
            (_tabId: number, message: { type?: string }) =>
                Promise.resolve(
                    message.type === TOPSKIP_MESSAGE.CONTENT_ROUTE_STATUS
                        ? currentRouteStatus()
                        : undefined,
                ),
        );
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

    it('keeps worker transport exhaustion distinct from caption failure', async () => {
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
                event: 'analysis_interrupted',
                reason: 'runtime_unavailable',
                sessionId: SESSION_ID,
                videoId: VIDEO_ID,
            },
            SENDER,
        );

        expect(detectionMocks.set.mock.lastCall?.[1]).toMatchObject({
            status: 'unavailable',
            serverFailure: { code: 'analysis_interrupted' },
        });
        expect(clientMocks.requestAnalysis).not.toHaveBeenCalled();
        expect(clientMocks.requestJobStatus).not.toHaveBeenCalled();
    });

    it('acknowledges acquisition only after its detection snapshot persists', async () => {
        let releaseWrite = (): void => undefined;
        detectionMocks.set.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    releaseWrite = resolve;
                }),
        );
        let settled = false;

        const response = ServerAnalysisRuntimeMessages.handleSessionEvent(
            {
                event: 'acquisition_started',
                sessionId: SESSION_ID,
                videoId: VIDEO_ID,
            },
            SENDER,
        ).then((result) => {
            settled = true;
            return result;
        });
        await vi.waitFor(() => {
            expect(detectionMocks.set).toHaveBeenCalledOnce();
        });
        expect(settled).toBe(false);

        releaseWrite();

        await expect(response).resolves.toEqual({ ok: true });
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
            algorithmVersion: 'server-v6',
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

    it.each([
        'https://www.youtube.com/',
        'https://www.youtube.com/feed/subscriptions',
        'https://www.youtube.com/watch?v=previousVid',
    ])('accepts a live session when sender.url is stale at %s', async (url) => {
        await expect(
            ServerAnalysisRuntimeMessages.handleSessionEvent(
                {
                    event: 'acquisition_started',
                    sessionId: SESSION_ID,
                    videoId: VIDEO_ID,
                },
                {
                    id: browserMocks.runtimeId,
                    tab: { id: 42 },
                    frameId: 0,
                    url,
                } as never,
            ),
        ).resolves.toEqual({ ok: true });

        expect(browserMocks.tabsSendMessage).toHaveBeenCalledWith(42, {
            type: TOPSKIP_MESSAGE.CONTENT_ROUTE_STATUS,
        });
        expect(detectionMocks.set).toHaveBeenCalledWith(
            42,
            expect.objectContaining({
                videoId: VIDEO_ID,
                sessionId: SESSION_ID,
                status: 'analyzing',
                serverAnalysisPhase: 'caption_acquisition',
            }),
        );
    });

    it('submits captions after a same-origin SPA navigation', async () => {
        await expect(
            ServerAnalysisRuntimeMessages.handleRequest(
                REQUEST,
                {
                    id: browserMocks.runtimeId,
                    tab: { id: 42 },
                    frameId: 0,
                    url: 'https://www.youtube.com/feed/subscriptions',
                } as never,
            ),
        ).resolves.toMatchObject({ ok: true, status: 'processing' });

        expect(cacheMocks.loadExact).toHaveBeenCalledOnce();
        expect(clientMocks.requestAnalysis).toHaveBeenCalledOnce();
    });

    it.each([
        [
            'foreign extension',
            {
                id: 'foreign-extension',
                tab: { id: 42 },
                frameId: 0,
                url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
            },
        ],
        [
            'missing tab',
            {
                id: browserMocks.runtimeId,
                frameId: 0,
                url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
            },
        ],
        [
            'subframe',
            {
                id: browserMocks.runtimeId,
                tab: { id: 42 },
                frameId: 2,
                url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
            },
        ],
        [
            'malformed URL',
            {
                id: browserMocks.runtimeId,
                tab: { id: 42 },
                frameId: 0,
                url: 'not a URL',
            },
        ],
        [
            'URL with embedded credentials',
            {
                id: browserMocks.runtimeId,
                tab: { id: 42 },
                frameId: 0,
                url: `https://user:password@www.youtube.com/watch?v=${VIDEO_ID}`,
            },
        ],
        [
            'lookalike host',
            {
                id: browserMocks.runtimeId,
                tab: { id: 42 },
                frameId: 0,
                url: `https://www.youtube.com.example/watch?v=${VIDEO_ID}`,
            },
        ],
    ])('rejects a %s sender before cache or HTTP', async (_name, sender) => {
        await expect(
            ServerAnalysisRuntimeMessages.handleRequest(
                REQUEST,
                sender as never,
            ),
        ).resolves.toEqual({ ok: true, status: 'inactive' });

        expect(browserMocks.tabsSendMessage).not.toHaveBeenCalled();
        expect(detectionMocks.set).not.toHaveBeenCalled();
        expect(cacheMocks.loadExact).not.toHaveBeenCalled();
        expect(clientMocks.requestAnalysis).not.toHaveBeenCalled();
    });

    it('returns inactive when the live content receiver is missing', async () => {
        browserMocks.tabsSendMessage.mockRejectedValue(
            new Error('Receiving end does not exist'),
        );

        await expect(
            ServerAnalysisRuntimeMessages.handleRequest(REQUEST, SENDER),
        ).resolves.toEqual({ ok: true, status: 'inactive' });

        expect(detectionMocks.set).not.toHaveBeenCalled();
        expect(clientMocks.requestAnalysis).not.toHaveBeenCalled();
    });

    it.each([
        ['disabled', { enabled: false }],
        ['BYOK route', { analysisMode: 'byok' }],
        ['replaced session', { serverSessionId: '00000000-0000-4000-8000-000000000002' }],
        ['another video', { videoId: 'other-video' }],
        ['stale protocol', { protocolVersion: 2 }],
        ['stale extension', { extensionVersion: '0.0.9' }],
        ['malformed response', { ok: false }],
    ])('returns inactive for %s live route status', async (_name, override) => {
        browserMocks.tabsSendMessage.mockResolvedValue({
            ...currentRouteStatus(),
            ...override,
        });

        await expect(
            ServerAnalysisRuntimeMessages.handleRequest(REQUEST, SENDER),
        ).resolves.toEqual({ ok: true, status: 'inactive' });

        expect(detectionMocks.set).not.toHaveBeenCalled();
        expect(clientMocks.requestAnalysis).not.toHaveBeenCalled();
    });

    it('applies the same live ownership proof before polling', async () => {
        browserMocks.tabsSendMessage.mockResolvedValue({
            ...currentRouteStatus(),
            analysisMode: 'byok',
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
        ).resolves.toEqual({ ok: true, status: 'inactive' });

        expect(clientMocks.requestJobStatus).not.toHaveBeenCalled();
        expect(detectionMocks.set).not.toHaveBeenCalled();
    });

    it('rejects a polling response when navigation wins the network race', async () => {
        let routeProbeCount = 0;
        browserMocks.tabsSendMessage.mockImplementation(
            (_tabId: number, message: { type?: string }) => {
                if (message.type !== TOPSKIP_MESSAGE.CONTENT_ROUTE_STATUS) {
                    return Promise.resolve(undefined);
                }
                routeProbeCount += 1;
                return Promise.resolve({
                    ...currentRouteStatus(),
                    ...(routeProbeCount === 1
                        ? {}
                        : { videoId: 'next-video' }),
                });
            },
        );

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
        ).resolves.toEqual({ ok: true, status: 'inactive' });

        expect(clientMocks.requestJobStatus).toHaveBeenCalledOnce();
        expect(detectionMocks.set).not.toHaveBeenCalled();
    });

    it('rejects a session event when the live route owns another video', async () => {
        browserMocks.tabsSendMessage.mockResolvedValue({
            ...currentRouteStatus(),
            videoId: 'next-video',
        });

        await expect(
            ServerAnalysisRuntimeMessages.handleSessionEvent(
                {
                    event: 'acquisition_started',
                    sessionId: SESSION_ID,
                    videoId: VIDEO_ID,
                },
                SENDER,
            ),
        ).resolves.toEqual({ ok: true });

        expect(detectionMocks.set).not.toHaveBeenCalled();
        expect(browserMocks.tabsSendMessage).toHaveBeenCalledWith(42, {
            type: TOPSKIP_MESSAGE.CONTENT_ROUTE_STATUS,
        });
    });

    it('rejects a delayed processing response after SPA navigation', async () => {
        let routeProbeCount = 0;
        browserMocks.tabsSendMessage.mockImplementation(
            (_tabId: number, message: { type?: string }) => {
                if (message.type !== TOPSKIP_MESSAGE.CONTENT_ROUTE_STATUS) {
                    return Promise.resolve(undefined);
                }
                routeProbeCount += 1;
                return Promise.resolve({
                    ...currentRouteStatus(),
                    ...(routeProbeCount <= 2
                        ? {}
                        : { videoId: 'next-video' }),
                });
            },
        );

        await expect(
            ServerAnalysisRuntimeMessages.handleRequest(REQUEST, SENDER),
        ).resolves.toEqual({ ok: true, status: 'inactive' });

        expect(clientMocks.requestAnalysis).toHaveBeenCalledOnce();
        expect(detectionMocks.set).toHaveBeenCalledOnce();
        expect(detectionMocks.set.mock.lastCall?.[1]).toMatchObject({
            serverAnalysisPhase: 'caption_acquisition',
        });
    });

    it('does not start paid HTTP when cache lookup finishes on a stale route', async () => {
        let routeProbeCount = 0;
        browserMocks.tabsSendMessage.mockImplementation(
            (_tabId: number, message: { type?: string }) => {
                if (message.type !== TOPSKIP_MESSAGE.CONTENT_ROUTE_STATUS) {
                    return Promise.resolve(undefined);
                }
                routeProbeCount += 1;
                return Promise.resolve({
                    ...currentRouteStatus(),
                    ...(routeProbeCount === 1
                        ? {}
                        : { videoId: 'next-video' }),
                });
            },
        );

        await expect(
            ServerAnalysisRuntimeMessages.handleRequest(REQUEST, SENDER),
        ).resolves.toEqual({ ok: true, status: 'inactive' });

        expect(cacheMocks.loadExact).toHaveBeenCalledOnce();
        expect(clientMocks.requestAnalysis).not.toHaveBeenCalled();
        expect(detectionMocks.set).toHaveBeenCalledOnce();
    });

    it.each([
        'https://www.youtube.com/watch?v=next-video',
        'https://www.youtube.com/feed/subscriptions',
    ])('accepts exact-session cancellation after navigation to %s', async (url) => {
        await expect(
            ServerAnalysisRuntimeMessages.handleSessionEvent(
                {
                    event: 'cancelled',
                    sessionId: SESSION_ID,
                    videoId: VIDEO_ID,
                },
                {
                    id: browserMocks.runtimeId,
                    tab: { id: 42 },
                    frameId: 0,
                    url,
                } as never,
            ),
        ).resolves.toEqual({ ok: true });

        expect(detectionMocks.clear).toHaveBeenCalledWith(42, SESSION_ID);
        expect(browserMocks.tabsSendMessage).not.toHaveBeenCalled();
    });

    it('does not let an untrusted cancellation clear any session', async () => {
        await expect(
            ServerAnalysisRuntimeMessages.handleSessionEvent(
                {
                    event: 'cancelled',
                    sessionId: SESSION_ID,
                    videoId: VIDEO_ID,
                },
                {
                    id: browserMocks.runtimeId,
                    tab: { id: 42 },
                    frameId: 1,
                    url: 'https://www.youtube.com/feed/subscriptions',
                } as never,
            ),
        ).resolves.toEqual({ ok: false, error: 'Untrusted sender.' });

        expect(detectionMocks.clear).not.toHaveBeenCalled();
    });
});
