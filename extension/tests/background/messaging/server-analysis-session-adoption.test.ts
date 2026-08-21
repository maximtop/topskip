import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    CONTENT_SCRIPT_PROTOCOL_VERSION,
    TOPSKIP_MESSAGE,
} from '@/shared/messages';

const prefsMocks = vi.hoisted(() => ({
    ready: vi.fn().mockResolvedValue(undefined),
    load: vi.fn(),
}));
const clientMocks = vi.hoisted(() => ({
    requestAnalysis: vi.fn(),
    requestJobStatus: vi.fn(),
}));
const configurationMocks = vi.hoisted(() => ({
    loadActive: vi.fn(),
    loadCached: vi.fn(),
    noteAlgorithmVersion: vi.fn(),
}));
const cacheMocks = vi.hoisted(() => ({
    loadExact: vi.fn(),
    saveTerminalResponse: vi.fn(),
}));
const browserMocks = vi.hoisted(() => {
    const sessionData: Record<string, unknown> = {};
    return {
        runtimeSendMessage: vi.fn(),
        tabsSendMessage: vi.fn(),
        sessionData,
        sessionGet: vi.fn(),
        sessionSet: vi.fn(),
    };
});

vi.mock('@/background/storage/prefs-sync', () => ({
    PrefsSyncStorage: prefsMocks,
}));
vi.mock('@/background/server-analysis-client', () => ({
    ServerAnalysisClient: clientMocks,
}));
vi.mock('@/background/server-analysis-configuration', () => ({
    ServerAnalysisConfiguration: configurationMocks,
}));
vi.mock('@/background/storage/server-result-cache', () => ({
    ServerResultCacheStorage: cacheMocks,
}));
vi.mock('@/shared/browser', () => ({
    default: {
        runtime: {
            getManifest: () => ({ version: '0.1.0' }),
            sendMessage: browserMocks.runtimeSendMessage,
        },
        storage: {
            session: {
                get: browserMocks.sessionGet,
                set: browserMocks.sessionSet,
            },
        },
        tabs: {
            sendMessage: browserMocks.tabsSendMessage,
        },
    },
}));

const TAB_ID = 42;
const VIDEO_ID = 'dQw4w9WgXcQ';
const SESSION_A = '00000000-0000-4000-8000-000000000001';
const SESSION_B = '00000000-0000-4000-8000-000000000002';
const SEGMENTS = [{ startSec: 0, durationSec: 1, text: 'Caption' }];
const TRANSCRIPT_HASH = createHash('sha256')
    .update('[[0,1,"Caption"]]')
    .digest('hex');
const IDENTITY = {
    videoId: VIDEO_ID,
    languageCode: 'en',
    transcriptHash: TRANSCRIPT_HASH,
    algorithmVersion: 'server-v6',
};
const CONFIG = {
    apiVersion: 1 as const,
    algorithmVersion: 'server-v6',
    supportedCapabilities: ['processing-status', 'typed-server-errors-v1'],
    supportIssueBaseUrl: 'https://github.com/maximtop/topskip/issues/new',
};
const REQUEST = {
    sessionId: SESSION_B,
    videoId: VIDEO_ID,
    durationSec: 213,
    languageCode: 'en',
    segments: SEGMENTS,
};
const SENDER = {
    tab: { id: TAB_ID },
    frameId: 0,
    url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
} as never;

describe('Server request session adoption after worker restart', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        for (const key of Object.keys(browserMocks.sessionData)) {
            delete browserMocks.sessionData[key];
        }
        browserMocks.sessionGet.mockImplementation((key: string) =>
            Promise.resolve(
                key in browserMocks.sessionData
                    ? { [key]: browserMocks.sessionData[key] }
                    : {},
            ),
        );
        browserMocks.sessionSet.mockImplementation(
            (items: Record<string, unknown>) => {
                Object.assign(browserMocks.sessionData, items);
                return Promise.resolve();
            },
        );
        browserMocks.runtimeSendMessage.mockResolvedValue(undefined);
        browserMocks.tabsSendMessage.mockImplementation(
            (_tabId: number, message: { type?: string }) =>
                Promise.resolve(
                    message.type === TOPSKIP_MESSAGE.CONTENT_ROUTE_STATUS
                        ? {
                                ok: true,
                                protocolVersion:
                                    CONTENT_SCRIPT_PROTOCOL_VERSION,
                                extensionVersion: '0.1.0',
                                videoId: VIDEO_ID,
                                enabled: true,
                                analysisMode: 'server',
                                serverSessionId: SESSION_B,
                            }
                        : undefined,
                ),
        );
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
        clientMocks.requestAnalysis.mockResolvedValue({
            status: 'processing',
            ...IDENTITY,
            jobId: 'job-v6',
            pollAfterSec: 3,
        });
        clientMocks.requestJobStatus.mockResolvedValue({
            status: 'ready',
            ...IDENTITY,
            source: 'server_cache',
            sourceResultId: 'result-v6',
            freshness: { expiresAtMs: 4_102_444_800_000 },
            promoBlocks: [{ startSec: 10, endSec: 20 }],
        });
    });

    it('adopts request B when persisted A survives and acquisition B was lost', async () => {
        vi.resetModules();
        const initialStoreModule =
            await import('@/background/promo-detection-store');
        await initialStoreModule.PromoDetectionStore.set(TAB_ID, {
            videoId: VIDEO_ID,
            status: 'analyzing',
            source: 'server',
            sessionId: SESSION_A,
            serverAnalysisPhase: 'server_analysis',
        });

        vi.resetModules();
        const [{ ServerAnalysisRuntimeMessages }, { PromoDetectionStore }] =
            await Promise.all([
                import('@/background/messaging/server-analysis-runtime-messages'),
                import('@/background/promo-detection-store'),
            ]);

        await expect(
            ServerAnalysisRuntimeMessages.handleRequest(REQUEST, SENDER),
        ).resolves.toMatchObject({ ok: true, status: 'processing' });
        expect(PromoDetectionStore.get(TAB_ID)).toMatchObject({
            sessionId: SESSION_B,
            status: 'analyzing',
            serverAnalysisPhase: 'server_analysis',
        });

        await expect(
            ServerAnalysisRuntimeMessages.handleRefreshStatus(
                {
                    sessionId: SESSION_B,
                    videoId: VIDEO_ID,
                    jobId: 'job-v6',
                    identity: IDENTITY,
                },
                SENDER,
            ),
        ).resolves.toEqual({ ok: true, status: 'ready' });
        const terminalB = PromoDetectionStore.get(TAB_ID);
        expect(terminalB).toMatchObject({
            sessionId: SESSION_B,
            status: 'detected',
            promoBlocks: [{ startSec: 10, endSec: 20 }],
        });

        await expect(
            ServerAnalysisRuntimeMessages.handleSessionEvent(
                {
                    event: 'cancelled',
                    sessionId: SESSION_A,
                    videoId: VIDEO_ID,
                },
                {
                    tab: { id: TAB_ID },
                    frameId: 0,
                    url: 'https://www.youtube.com/feed/subscriptions',
                } as never,
            ),
        ).resolves.toEqual({ ok: true });
        expect(PromoDetectionStore.get(TAB_ID)).toEqual(terminalB);

        await PromoDetectionStore.set(TAB_ID, {
            videoId: VIDEO_ID,
            status: 'no_promo',
            source: 'server',
            sessionId: SESSION_A,
        });
        expect(PromoDetectionStore.get(TAB_ID)).toEqual(terminalB);
    });
});
