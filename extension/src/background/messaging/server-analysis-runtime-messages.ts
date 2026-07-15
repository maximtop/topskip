import type { Runtime } from 'webextension-polyfill/namespaces/runtime';
import * as v from 'valibot';

import { PromoDetectionStore } from '@/background/promo-detection-store';
import { ServerAnalysisConfiguration } from '@/background/server-analysis-configuration';
import { ServerAnalysisClient } from '@/background/server-analysis-client';
import { BackgroundServerAnalysisLog } from '@/background/server-analysis-log';
import { PrefsSyncStorage } from '@/background/storage/prefs-sync';
import { ServerResultCacheStorage } from '@/background/storage/server-result-cache';
import browser from '@/shared/browser';
import { ANALYSIS_MODE } from '@/shared/constants';
import type {
    RefreshServerAnalysisStatusPayload,
    RefreshServerAnalysisStatusResponse,
    RequestServerAnalysisPayload,
    RequestServerAnalysisResponse,
    ServerAnalysisFailureContext,
    TopSkipRuntimeMessage,
} from '@/shared/messages';
import { TOPSKIP_MESSAGE } from '@/shared/messages';
import type { PromoBlock } from '@topskip/common/promo-types';
import {
    SERVER_ANALYSIS_API_VERSION,
    SERVER_ANALYSIS_FAILURE_CODE,
    serverAnalysisFailureSchema,
    type ServerAnalysisFailure,
    type ServerAnalysisResponse,
} from '@topskip/common/server-analysis-contract';
import {
    SERVER_FAILURE_CATEGORY,
    classifyServerFailure,
} from '@/shared/server-analysis-failure';

const WATCH_VIDEO_ID_QUERY_PARAMETER = 'v';
const LOCAL_E2E_HOST = '127.0.0.1';

/**
 * Handles server-first analysis requests from the watch content script; static
 * API only.
 */
export class ServerAnalysisRuntimeMessages {
    /**
     * Remembers the one deploy-recovery resubmission allowed for each active tab.
     */
    private static readonly restartedJobVideoByTab = new Map<number, string>();

    /**
     * Converts unknown client failures to the allow-listed response vocabulary.
     *
     * @param error - Opaque transport or validation failure.
     * @returns Safe stable failure details.
     */
    private static normalizeClientFailure(
        error: unknown,
    ): ServerAnalysisFailure {
        if (typeof error === 'object' && error !== null) {
            const parsed = v.safeParse(
                serverAnalysisFailureSchema,
                Reflect.get(error, 'failure'),
            );
            if (parsed.success) {
                return parsed.output;
            }
        }
        return { code: SERVER_ANALYSIS_FAILURE_CODE.InvalidServerResponse };
    }

    /**
     * Enriches stable failure details with public compatibility metadata for
     * popup localization and background-owned issue reporting.
     *
     * @param failure - Validated message-free server details.
     * @param algorithmVersion - Version carried by the terminal response.
     * @returns Runtime-safe failure context.
     */
    private static async buildFailureContext(
        failure: ServerAnalysisFailure,
        algorithmVersion?: string,
    ): Promise<ServerAnalysisFailureContext> {
        const config = await ServerAnalysisConfiguration.loadCached();
        const extensionVersion = browser.runtime.getManifest().version;
        return {
            code: failure.code,
            ...(failure.supportId === undefined
                ? {}
                : { supportId: failure.supportId }),
            ...(failure.retryAfterSec === undefined
                ? {}
                : { retryAfterSec: failure.retryAfterSec }),
            apiVersion: config?.apiVersion ?? SERVER_ANALYSIS_API_VERSION,
            extensionVersion,
            ...(algorithmVersion === undefined
                ? config?.algorithmVersion === undefined
                    ? {}
                    : { algorithmVersion: config.algorithmVersion }
                : { algorithmVersion }),
            ...(config?.supportIssueBaseUrl === undefined
                ? {}
                : { supportIssueBaseUrl: config.supportIssueBaseUrl }),
        };
    }

    /**
     * Publishes a localized server failure without storing raw backend text.
     *
     * @param input - Target tab/video, typed failure, and optional algorithm.
     * @returns Promise resolved after the state update.
     */
    private static async publishFailure(input: {
        tabId: number;
        videoId: string;
        failure: ServerAnalysisFailure;
        algorithmVersion?: string;
    }): Promise<void> {
        const category = classifyServerFailure(input.failure.code);
        const status =
            category === SERVER_FAILURE_CATEGORY.ServerFailure
                ? 'error'
                : 'unavailable';
        PromoDetectionStore.set(input.tabId, {
            videoId: input.videoId,
            status,
            source: 'server',
            serverFailure:
                await ServerAnalysisRuntimeMessages.buildFailureContext(
                    input.failure,
                    input.algorithmVersion,
                ),
        });
    }

    /**
     * Sends active promo blocks through the existing content and popup paths.
     *
     * @param input - Current tab, video, blocks, and detection source.
     * @returns Promise resolved after delivery and popup state update.
     */
    private static async deliverDetectedBlocks(input: {
        tabId: number;
        videoId: string;
        promoBlocks: PromoBlock[];
        source: 'server' | 'local_cache' | 'server_cache';
        durationSec?: number;
    }): Promise<void> {
        if (
            !(await ServerAnalysisRuntimeMessages.isTabStillOnRequestedVideo(
                input.tabId,
                input.videoId,
            ))
        ) {
            BackgroundServerAnalysisLog.info('delivery-skipped', {
                tabId: input.tabId,
                videoId: input.videoId,
                reason: 'stale-tab',
            });
            return;
        }
        const message = {
            type: TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED,
            videoId: input.videoId,
            promoBlocks: input.promoBlocks,
        } satisfies TopSkipRuntimeMessage;

        try {
            await browser.tabs.sendMessage(input.tabId, message);
        } catch {
            // The tab may have navigated away after requesting analysis.
        }

        const durationState =
            input.durationSec !== undefined &&
            Number.isFinite(input.durationSec) &&
            input.durationSec > 0
                ? { durationSec: input.durationSec }
                : {};
        PromoDetectionStore.set(input.tabId, {
            videoId: input.videoId,
            status: 'detected',
            source: input.source,
            promoBlocks: input.promoBlocks,
            ...durationState,
        });
        BackgroundServerAnalysisLog.info('blocks-delivered', {
            tabId: input.tabId,
            videoId: input.videoId,
            blockCount: input.promoBlocks.length,
            source: input.source,
        });
    }

    /**
     * Reloads current preferences before a backend request can be made.
     *
     * @returns Whether server analysis is still enabled.
     */
    private static async loadServerModeActive(): Promise<boolean> {
        await PrefsSyncStorage.ready();
        const prefs = await PrefsSyncStorage.load();
        return prefs.enabled && prefs.analysisMode === ANALYSIS_MODE.Server;
    }

    /**
     * Avoids applying delayed results after the tab has navigated to another video.
     *
     * @param tabId - Source tab that initiated the backend request.
     * @param videoId - Video id tied to the backend response.
     * @returns Whether the tab still displays the requested watch video.
     */
    private static async isTabStillOnRequestedVideo(
        tabId: number,
        videoId: string,
    ): Promise<boolean> {
        try {
            const tab = await browser.tabs.get(tabId);
            if (tab.url === undefined) {
                return false;
            }
            const url = new URL(tab.url);
            return (
                url.hostname === LOCAL_E2E_HOST ||
                url.searchParams.get(WATCH_VIDEO_ID_QUERY_PARAMETER) === videoId
            );
        } catch {
            // Some browser implementations do not expose a tab URL to this
            // extension context; content-side video guards remain authoritative.
            return true;
        }
    }

    /**
     * Maps backend analysis responses into popup state and content delivery.
     *
     * @param input - Sender tab, requested video metadata, response, and ready-result origin.
     * @returns Runtime ack for the content script.
     */
    private static async applyServerResponse(input: {
        tabId: number;
        requestedVideoId: string;
        response: ServerAnalysisResponse;
        durationSec?: number;
        readySource: 'server' | 'server_cache';
    }): Promise<RequestServerAnalysisResponse> {
        BackgroundServerAnalysisLog.info('response-applying', {
            tabId: input.tabId,
            videoId: input.requestedVideoId,
            status: input.response.status,
            jobId:
                input.response.status === 'processing'
                    ? input.response.jobId
                    : undefined,
        });
        if (
            !(await ServerAnalysisRuntimeMessages.loadServerModeActive()) ||
            !(await ServerAnalysisRuntimeMessages.isTabStillOnRequestedVideo(
                input.tabId,
                input.requestedVideoId,
            ))
        ) {
            ServerAnalysisRuntimeMessages.restartedJobVideoByTab.delete(
                input.tabId,
            );
            BackgroundServerAnalysisLog.info('response-skipped', {
                tabId: input.tabId,
                videoId: input.requestedVideoId,
                reason: 'inactive-or-stale',
            });
            return { ok: true, status: 'inactive' };
        }
        if (input.response.status !== 'processing') {
            ServerAnalysisRuntimeMessages.restartedJobVideoByTab.delete(
                input.tabId,
            );
        }
        if (input.response.status === 'rate_limited') {
            if (input.response.algorithmVersion !== undefined) {
                await ServerAnalysisConfiguration.noteAlgorithmVersion(
                    input.response.algorithmVersion,
                );
            }
            await ServerAnalysisRuntimeMessages.publishFailure({
                tabId: input.tabId,
                videoId: input.requestedVideoId,
                failure: input.response.error,
                algorithmVersion: input.response.algorithmVersion,
            });
            return { ok: true, status: 'rate_limited' };
        }

        const responseVideoId =
            'videoId' in input.response ? input.response.videoId : undefined;
        const responseAlgorithmVersion =
            'algorithmVersion' in input.response
                ? input.response.algorithmVersion
                : undefined;
        if (
            responseVideoId !== undefined &&
            responseVideoId !== input.requestedVideoId
        ) {
            await ServerAnalysisRuntimeMessages.publishFailure({
                tabId: input.tabId,
                videoId: input.requestedVideoId,
                failure: {
                    code: SERVER_ANALYSIS_FAILURE_CODE.InvalidServerResponse,
                },
                algorithmVersion: responseAlgorithmVersion,
            });
            return { ok: false, error: 'Invalid server response.' };
        }
        if (responseAlgorithmVersion !== undefined) {
            await ServerAnalysisConfiguration.noteAlgorithmVersion(
                responseAlgorithmVersion,
            );
        }

        switch (input.response.status) {
            case 'processing':
                PromoDetectionStore.set(input.tabId, {
                    videoId: input.requestedVideoId,
                    status: 'analyzing',
                    source: 'server',
                });
                return {
                    ok: true,
                    status: 'processing',
                    jobId: input.response.jobId,
                    pollAfterSec: input.response.pollAfterSec,
                };
            case 'ready':
                try {
                    await ServerResultCacheStorage.saveReadyResponse(
                        input.response,
                    );
                } catch {
                    // Local cache persistence must never block a valid server result.
                }

                await ServerAnalysisRuntimeMessages.deliverDetectedBlocks({
                    tabId: input.tabId,
                    videoId: input.response.videoId,
                    promoBlocks: input.response.promoBlocks,
                    source: input.readySource,
                    durationSec: input.durationSec,
                });
                return { ok: true, status: 'ready' };
            case 'no_promo':
                PromoDetectionStore.set(input.tabId, {
                    videoId: input.requestedVideoId,
                    status: 'no_promo',
                    source: 'server',
                });
                return { ok: true, status: 'no_promo' };
            case 'unavailable':
                await ServerAnalysisRuntimeMessages.publishFailure({
                    tabId: input.tabId,
                    videoId: input.requestedVideoId,
                    failure: input.response.error,
                    algorithmVersion: input.response.algorithmVersion,
                });
                return { ok: true, status: 'unavailable' };
            case 'error':
                await ServerAnalysisRuntimeMessages.publishFailure({
                    tabId: input.tabId,
                    videoId: input.requestedVideoId,
                    failure: input.response.error,
                    algorithmVersion: input.response.algorithmVersion,
                });
                return { ok: true, status: 'error' };
        }
    }

    /**
     * Calls the local backend and maps the response into popup/content state.
     *
     * @param payload - Current video metadata from the content script.
     * @param sender - Runtime sender containing the source tab id.
     * @returns Processing ack or a user-safe server error.
     */
    static async handleRequest(
        payload: RequestServerAnalysisPayload,
        sender: Runtime.MessageSender,
    ): Promise<RequestServerAnalysisResponse> {
        const tabId = sender.tab?.id;
        if (tabId === undefined) {
            BackgroundServerAnalysisLog.warn('runtime-request-rejected', {
                videoId: payload.videoId,
                reason: 'missing-tab-id',
            });
            return { ok: false, error: 'Missing sender tab id.' };
        }
        ServerAnalysisRuntimeMessages.restartedJobVideoByTab.delete(tabId);

        BackgroundServerAnalysisLog.info('runtime-request-received', {
            tabId,
            videoId: payload.videoId,
            durationSec: payload.durationSec,
        });

        if (!(await ServerAnalysisRuntimeMessages.loadServerModeActive())) {
            BackgroundServerAnalysisLog.info('runtime-request-inactive', {
                tabId,
                videoId: payload.videoId,
                reason: 'prefs',
            });
            return { ok: true, status: 'inactive' };
        }
        if (
            !(await ServerAnalysisRuntimeMessages.isTabStillOnRequestedVideo(
                tabId,
                payload.videoId,
            ))
        ) {
            BackgroundServerAnalysisLog.info('runtime-request-inactive', {
                tabId,
                videoId: payload.videoId,
                reason: 'stale-tab',
            });
            return { ok: true, status: 'inactive' };
        }

        try {
            const config = await ServerAnalysisConfiguration.loadActive();
            const cached =
                config === null
                    ? await ServerResultCacheStorage.loadLatestFreshForVideo({
                          videoId: payload.videoId,
                      })
                    : await ServerResultCacheStorage.loadFresh({
                          videoId: payload.videoId,
                          algorithmVersion: config.algorithmVersion,
                      });
            if (cached !== null) {
                BackgroundServerAnalysisLog.info('local-cache-hit', {
                    tabId,
                    videoId: payload.videoId,
                    blockCount: cached.promoBlocks.length,
                });
                await ServerAnalysisRuntimeMessages.deliverDetectedBlocks({
                    tabId,
                    videoId: cached.videoId,
                    promoBlocks: cached.promoBlocks,
                    source: 'local_cache',
                    durationSec: payload.durationSec,
                });
                return { ok: true, status: 'ready' };
            }

            BackgroundServerAnalysisLog.info('local-cache-miss', {
                tabId,
                videoId: payload.videoId,
            });

            const response = await ServerAnalysisClient.requestAnalysis({
                videoId: payload.videoId,
                durationSec: payload.durationSec,
                extensionVersion: browser.runtime.getManifest().version,
            });

            return await ServerAnalysisRuntimeMessages.applyServerResponse({
                tabId,
                requestedVideoId: payload.videoId,
                response,
                durationSec: payload.durationSec,
                readySource: 'server_cache',
            });
        } catch (e) {
            const failure =
                ServerAnalysisRuntimeMessages.normalizeClientFailure(e);
            BackgroundServerAnalysisLog.warn('runtime-request-error', {
                tabId,
                videoId: payload.videoId,
                code: 'backend-request-failed',
            });
            await ServerAnalysisRuntimeMessages.publishFailure({
                tabId,
                videoId: payload.videoId,
                failure,
            });
            return { ok: false, error: 'Server analysis failed.' };
        }
    }

    /**
     * Refreshes a pollable backend job after content-owned timer scheduling.
     *
     * @param payload - Current video id and backend job id.
     * @param sender - Runtime sender containing the source tab id.
     * @returns Polling ack or terminal status.
     */
    static async handleRefreshStatus(
        payload: RefreshServerAnalysisStatusPayload,
        sender: Runtime.MessageSender,
    ): Promise<RefreshServerAnalysisStatusResponse> {
        const tabId = sender.tab?.id;
        if (tabId === undefined) {
            BackgroundServerAnalysisLog.warn('poll-rejected', {
                videoId: payload.videoId,
                jobId: payload.jobId,
                reason: 'missing-tab-id',
            });
            return { ok: false, error: 'Missing sender tab id.' };
        }

        BackgroundServerAnalysisLog.info('poll-received', {
            tabId,
            videoId: payload.videoId,
            jobId: payload.jobId,
            durationSec: payload.durationSec,
        });

        if (!(await ServerAnalysisRuntimeMessages.loadServerModeActive())) {
            ServerAnalysisRuntimeMessages.restartedJobVideoByTab.delete(tabId);
            BackgroundServerAnalysisLog.info('poll-inactive', {
                tabId,
                videoId: payload.videoId,
                jobId: payload.jobId,
                reason: 'prefs',
            });
            return { ok: true, status: 'inactive' };
        }
        if (
            !(await ServerAnalysisRuntimeMessages.isTabStillOnRequestedVideo(
                tabId,
                payload.videoId,
            ))
        ) {
            ServerAnalysisRuntimeMessages.restartedJobVideoByTab.delete(tabId);
            BackgroundServerAnalysisLog.info('poll-inactive', {
                tabId,
                videoId: payload.videoId,
                jobId: payload.jobId,
                reason: 'stale-tab',
            });
            return { ok: true, status: 'inactive' };
        }

        try {
            let response = await ServerAnalysisClient.requestJobStatus(
                payload.jobId,
            );
            if (
                response.status === 'error' &&
                response.error.code ===
                    SERVER_ANALYSIS_FAILURE_CODE.JobNotFound &&
                ServerAnalysisRuntimeMessages.restartedJobVideoByTab.get(
                    tabId,
                ) !== payload.videoId
            ) {
                ServerAnalysisRuntimeMessages.restartedJobVideoByTab.set(
                    tabId,
                    payload.videoId,
                );
                response = await ServerAnalysisClient.requestAnalysis({
                    videoId: payload.videoId,
                    durationSec: payload.durationSec,
                    extensionVersion: browser.runtime.getManifest().version,
                });
            }
            return await ServerAnalysisRuntimeMessages.applyServerResponse({
                tabId,
                requestedVideoId: payload.videoId,
                response,
                durationSec: payload.durationSec,
                readySource: 'server',
            });
        } catch (e) {
            const failure =
                ServerAnalysisRuntimeMessages.normalizeClientFailure(e);
            BackgroundServerAnalysisLog.warn('poll-error', {
                tabId,
                videoId: payload.videoId,
                jobId: payload.jobId,
                code: 'backend-request-failed',
            });
            await ServerAnalysisRuntimeMessages.publishFailure({
                tabId,
                videoId: payload.videoId,
                failure,
            });
            return { ok: false, error: 'Server analysis failed.' };
        }
    }
}
