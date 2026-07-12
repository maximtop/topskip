import type { Runtime } from 'webextension-polyfill/namespaces/runtime';

import { PromoDetectionStore } from '@/background/promo-detection-store';
import { ServerAnalysisClient } from '@/background/server-analysis-client';
import { PrefsSyncStorage } from '@/background/storage/prefs-sync';
import { ServerResultCacheStorage } from '@/background/storage/server-result-cache';
import browser from '@/shared/browser';
import { ANALYSIS_MODE } from '@/shared/constants';
import { getErrorMessage } from '@/shared/error';
import type {
    RefreshServerAnalysisStatusPayload,
    RefreshServerAnalysisStatusResponse,
    RequestServerAnalysisPayload,
    RequestServerAnalysisResponse,
    TopSkipRuntimeMessage,
} from '@/shared/messages';
import { TOPSKIP_MESSAGE } from '@/shared/messages';
import type { PromoBlock } from '@/shared/promo-types';
import {
    SERVER_ANALYSIS_ALGORITHM_VERSION,
    type ServerAnalysisResponse,
} from '@/shared/server-analysis-contract';

const WATCH_VIDEO_ID_QUERY_PARAMETER = 'v';
const LOCAL_E2E_HOST = '127.0.0.1';

/**
 * Handles server-first analysis requests from the watch content script; static
 * API only.
 */
export class ServerAnalysisRuntimeMessages {
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
        source: 'local_cache' | 'server_cache';
    }): Promise<void> {
        if (
            !(await ServerAnalysisRuntimeMessages.isTabStillOnRequestedVideo(
                input.tabId,
                input.videoId,
            ))
        ) {
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

        PromoDetectionStore.set(input.tabId, {
            videoId: input.videoId,
            status: 'detected',
            source: input.source,
            promoBlocks: input.promoBlocks,
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
     * @param input - Sender tab, requested video id, and backend response.
     * @returns Runtime ack for the content script.
     */
    private static async applyServerResponse(input: {
        tabId: number;
        requestedVideoId: string;
        response: ServerAnalysisResponse;
    }): Promise<RequestServerAnalysisResponse> {
        if (
            !(await ServerAnalysisRuntimeMessages.loadServerModeActive()) ||
            !(await ServerAnalysisRuntimeMessages.isTabStillOnRequestedVideo(
                input.tabId,
                input.requestedVideoId,
            ))
        ) {
            return { ok: true, status: 'inactive' };
        }
        if (input.response.status === 'rate_limited') {
            PromoDetectionStore.set(input.tabId, {
                videoId: input.requestedVideoId,
                status: 'unavailable',
                source: 'server',
                error: input.response.error.message,
            });
            return { ok: true, status: 'rate_limited' };
        }

        if (input.response.videoId !== input.requestedVideoId) {
            const error = 'Server returned analysis for a different video.';
            PromoDetectionStore.set(input.tabId, {
                videoId: input.requestedVideoId,
                status: 'error',
                source: 'server',
                error,
            });
            return { ok: false, error };
        }

        if (
            input.response.algorithmVersion !==
            SERVER_ANALYSIS_ALGORITHM_VERSION
        ) {
            const error =
                'Server returned analysis for an unsupported algorithm version.';
            PromoDetectionStore.set(input.tabId, {
                videoId: input.requestedVideoId,
                status: 'error',
                source: 'server',
                error,
            });
            return { ok: false, error };
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
                    source: 'server_cache',
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
                PromoDetectionStore.set(input.tabId, {
                    videoId: input.requestedVideoId,
                    status: 'unavailable',
                    source: 'server',
                    error: input.response.message,
                });
                return { ok: true, status: 'unavailable' };
            case 'error':
                PromoDetectionStore.set(input.tabId, {
                    videoId: input.requestedVideoId,
                    status: 'error',
                    source: 'server',
                    error: input.response.error.message,
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
            return { ok: false, error: 'Missing sender tab id.' };
        }

        if (!(await ServerAnalysisRuntimeMessages.loadServerModeActive())) {
            return { ok: true, status: 'inactive' };
        }
        if (
            !(await ServerAnalysisRuntimeMessages.isTabStillOnRequestedVideo(
                tabId,
                payload.videoId,
            ))
        ) {
            return { ok: true, status: 'inactive' };
        }

        try {
            const cached = await ServerResultCacheStorage.loadFresh({
                videoId: payload.videoId,
                algorithmVersion: SERVER_ANALYSIS_ALGORITHM_VERSION,
            });
            if (cached !== null) {
                await ServerAnalysisRuntimeMessages.deliverDetectedBlocks({
                    tabId,
                    videoId: cached.videoId,
                    promoBlocks: cached.promoBlocks,
                    source: 'local_cache',
                });
                return { ok: true, status: 'ready' };
            }

            const response = await ServerAnalysisClient.requestAnalysis({
                videoId: payload.videoId,
                durationSec: payload.durationSec,
                extensionVersion: browser.runtime.getManifest().version,
            });

            return await ServerAnalysisRuntimeMessages.applyServerResponse({
                tabId,
                requestedVideoId: payload.videoId,
                response,
            });
        } catch (e) {
            const error = getErrorMessage(e);
            PromoDetectionStore.set(tabId, {
                videoId: payload.videoId,
                status: 'error',
                source: 'server',
                error,
            });
            return { ok: false, error };
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
            return { ok: false, error: 'Missing sender tab id.' };
        }

        if (!(await ServerAnalysisRuntimeMessages.loadServerModeActive())) {
            return { ok: true, status: 'inactive' };
        }
        if (
            !(await ServerAnalysisRuntimeMessages.isTabStillOnRequestedVideo(
                tabId,
                payload.videoId,
            ))
        ) {
            return { ok: true, status: 'inactive' };
        }

        try {
            const response = await ServerAnalysisClient.requestJobStatus(
                payload.jobId,
            );
            return await ServerAnalysisRuntimeMessages.applyServerResponse({
                tabId,
                requestedVideoId: payload.videoId,
                response,
            });
        } catch (e) {
            const error = getErrorMessage(e);
            PromoDetectionStore.set(tabId, {
                videoId: payload.videoId,
                status: 'error',
                source: 'server',
                error,
            });
            return { ok: false, error };
        }
    }
}
