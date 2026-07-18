import type { Runtime } from 'webextension-polyfill/namespaces/runtime';
import * as v from 'valibot';

import { PromoDetectionStore } from '@/background/promo-detection-store';
import { ServerAnalysisConfiguration } from '@/background/server-analysis-configuration';
import { ServerAnalysisClient } from '@/background/server-analysis-client';
import { BackgroundServerAnalysisLog } from '@/background/server-analysis-log';
import { ServerTranscriptIdentity as ServerTranscriptFingerprint } from '@/background/server-transcript-identity';
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
    ServerAnalysisSessionEventPayload,
    TopSkipRuntimeMessage,
} from '@/shared/messages';
import { TOPSKIP_MESSAGE } from '@/shared/messages';
import { CaptionTranscriptCanonicalizer } from '@topskip/common/captions/canonical-transcript';
import type { PromoBlock } from '@topskip/common/promo-types';
import {
    SERVER_ANALYSIS_API_VERSION,
    SERVER_ANALYSIS_FAILURE_CODE,
    serverAnalysisFailureSchema,
    serverTranscriptIdentitySchema,
    type ServerAnalysisFailure,
    type ServerAnalysisResponse,
    type ServerTranscriptIdentity,
} from '@topskip/common/server-analysis-contract';
import {
    SERVER_FAILURE_CATEGORY,
    classifyServerFailure,
} from '@/shared/server-analysis-failure';

const WATCH_VIDEO_ID_QUERY_PARAMETER = 'v';
const LOCAL_E2E_HOST = '127.0.0.1';

/**
 * Handles session-bound Server analysis while keeping every HTTP operation in background.
 */
export class ServerAnalysisRuntimeMessages {
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
     * Enriches stable failure details only from already validated local metadata.
     *
     * @param failure - Validated message-free failure details.
     * @param algorithmVersion - Version observed in config or a response.
     * @returns Runtime-safe failure context for localized popup copy.
     */
    private static async buildFailureContext(
        failure: ServerAnalysisFailure,
        algorithmVersion?: string,
    ): Promise<ServerAnalysisFailureContext> {
        const config = await ServerAnalysisConfiguration.loadCached();
        return {
            code: failure.code,
            ...(failure.supportId === undefined
                ? {}
                : { supportId: failure.supportId }),
            ...(failure.retryAfterSec === undefined
                ? {}
                : { retryAfterSec: failure.retryAfterSec }),
            apiVersion: config?.apiVersion ?? SERVER_ANALYSIS_API_VERSION,
            extensionVersion: browser.runtime.getManifest().version,
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
     * Publishes one safe Server failure without retaining captions or raw responses.
     *
     * @param input - Target session, stable failure, and optional server version.
     * @returns Promise resolved after the detection snapshot is stored.
     */
    private static async publishFailure(input: {
        tabId: number;
        sessionId: string;
        videoId: string;
        failure: ServerAnalysisFailure;
        algorithmVersion?: string;
    }): Promise<void> {
        const category = classifyServerFailure(input.failure.code);
        PromoDetectionStore.set(input.tabId, {
            videoId: input.videoId,
            sessionId: input.sessionId,
            status:
                category === SERVER_FAILURE_CATEGORY.ServerFailure
                    ? 'error'
                    : 'unavailable',
            source: 'server',
            serverFailure:
                await ServerAnalysisRuntimeMessages.buildFailureContext(
                    input.failure,
                    input.algorithmVersion,
                ),
        });
    }

    /**
     * Delivers exact-session blocks through content and popup paths.
     *
     * @param input - Current tab/session, blocks, and cache origin.
     * @returns Promise resolved after best-effort content delivery.
     */
    private static async deliverDetectedBlocks(input: {
        tabId: number;
        sessionId: string;
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
            source: input.source,
            sessionId: input.sessionId,
            videoId: input.videoId,
            promoBlocks: input.promoBlocks,
        } satisfies TopSkipRuntimeMessage;
        try {
            await browser.tabs.sendMessage(input.tabId, message);
        } catch {
            // Navigation may remove the content context after the final guard.
        }

        const durationState =
            input.durationSec !== undefined &&
            Number.isFinite(input.durationSec) &&
            input.durationSec >= 0
                ? { durationSec: input.durationSec }
                : {};
        PromoDetectionStore.set(input.tabId, {
            videoId: input.videoId,
            sessionId: input.sessionId,
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
     * Reloads background-owned preferences before any server operation.
     *
     * @returns Whether Server mode is still enabled.
     */
    private static async loadServerModeActive(): Promise<boolean> {
        await PrefsSyncStorage.ready();
        const prefs = await PrefsSyncStorage.load();
        return prefs.enabled && prefs.analysisMode === ANALYSIS_MODE.Server;
    }

    /**
     * Avoids applying delayed results after the tab leaves the requested video.
     *
     * @param tabId - Source tab that initiated the session.
     * @param videoId - Video id tied to the session.
     * @returns Whether the tab still displays that watch video.
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
            // Content still enforces video/session identity when tab URLs are hidden.
            return true;
        }
    }

    /**
     * Extracts authoritative identity only from an identified response variant.
     *
     * @param response - Validated public server response.
     * @returns Complete identity, or `null` for pre-identity failures.
     */
    private static responseIdentity(
        response: ServerAnalysisResponse,
    ): ServerTranscriptIdentity | null {
        if (
            !('videoId' in response) ||
            !('languageCode' in response) ||
            !('transcriptHash' in response)
        ) {
            return null;
        }
        const parsed = v.safeParse(serverTranscriptIdentitySchema, {
            videoId: response.videoId,
            languageCode: response.languageCode,
            transcriptHash: response.transcriptHash,
            algorithmVersion: response.algorithmVersion,
        });
        return parsed.success ? parsed.output : null;
    }

    /**
     * Maps a validated backend response into one session-bound runtime acknowledgement.
     *
     * @param input - Tab/session request metadata and known response.
     * @returns Runtime acknowledgement consumed by the content-owned lifecycle.
     */
    private static async applyServerResponse(input: {
        tabId: number;
        sessionId: string;
        requestedVideoId: string;
        response: ServerAnalysisResponse;
        durationSec?: number;
        readySource: 'server' | 'server_cache';
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

        await ServerAnalysisConfiguration.noteAlgorithmVersion(
            input.response.algorithmVersion,
        );
        const identity = ServerAnalysisRuntimeMessages.responseIdentity(
            input.response,
        );

        switch (input.response.status) {
            case 'processing':
                if (identity === null) {
                    return { ok: false, error: 'Invalid server response.' };
                }
                PromoDetectionStore.set(input.tabId, {
                    videoId: input.requestedVideoId,
                    sessionId: input.sessionId,
                    status: 'analyzing',
                    source: 'server',
                    serverAnalysisPhase: 'server_analysis',
                });
                return {
                    ok: true,
                    status: 'processing',
                    jobId: input.response.jobId,
                    pollAfterSec: input.response.pollAfterSec,
                    identity,
                };
            case 'ready':
                try {
                    await ServerResultCacheStorage.saveTerminalResponse(
                        input.response,
                    );
                } catch {
                    // Cache persistence cannot block a valid terminal result.
                }
                await ServerAnalysisRuntimeMessages.deliverDetectedBlocks({
                    tabId: input.tabId,
                    sessionId: input.sessionId,
                    videoId: input.response.videoId,
                    promoBlocks: input.response.promoBlocks,
                    source: input.readySource,
                    durationSec: input.durationSec,
                });
                return { ok: true, status: 'ready' };
            case 'no_promo':
                try {
                    await ServerResultCacheStorage.saveTerminalResponse(
                        input.response,
                    );
                } catch {
                    // Cache persistence cannot block a valid terminal result.
                }
                PromoDetectionStore.set(input.tabId, {
                    videoId: input.requestedVideoId,
                    sessionId: input.sessionId,
                    status: 'no_promo',
                    source: 'server',
                });
                return { ok: true, status: 'no_promo' };
            case 'unavailable':
            case 'error':
            case 'rate_limited':
                await ServerAnalysisRuntimeMessages.publishFailure({
                    tabId: input.tabId,
                    sessionId: input.sessionId,
                    videoId: input.requestedVideoId,
                    failure: input.response.error,
                    algorithmVersion: input.response.algorithmVersion,
                });
                return { ok: true, status: input.response.status };
        }
    }

    /**
     * Applies caption acquisition phases locally without contacting TopSkip.
     *
     * @param payload - Validated session event from content.
     * @param sender - Browser sender containing the source tab.
     * @returns Safe acknowledgement after the local state update.
     */
    static async handleSessionEvent(
        payload: ServerAnalysisSessionEventPayload,
        sender: Runtime.MessageSender,
    ): Promise<{ ok: true } | { ok: false; error: string }> {
        const tabId = sender.tab?.id;
        if (tabId === undefined) {
            return { ok: false, error: 'Missing sender tab id.' };
        }
        if (payload.event === 'cancelled') {
            PromoDetectionStore.clear(tabId, payload.sessionId);
            return { ok: true };
        }
        if (
            !(await ServerAnalysisRuntimeMessages.loadServerModeActive()) ||
            !(await ServerAnalysisRuntimeMessages.isTabStillOnRequestedVideo(
                tabId,
                payload.videoId,
            ))
        ) {
            return { ok: true };
        }
        if (payload.event === 'acquisition_started') {
            PromoDetectionStore.set(tabId, {
                videoId: payload.videoId,
                sessionId: payload.sessionId,
                status: 'analyzing',
                source: 'server',
                serverAnalysisPhase: 'caption_acquisition',
            });
            return { ok: true };
        }

        const code =
            payload.event === 'captions_unavailable'
                ? SERVER_ANALYSIS_FAILURE_CODE.CaptionsUnavailable
                : SERVER_ANALYSIS_FAILURE_CODE.CaptionExtractionFailed;
        await ServerAnalysisRuntimeMessages.publishFailure({
            tabId,
            sessionId: payload.sessionId,
            videoId: payload.videoId,
            failure: { code },
        });
        return { ok: true };
    }

    /**
     * Canonicalizes captions before cache/config/network work can begin.
     *
     * @param payload - Validated runtime transcript submission.
     * @returns Exact browser identity excluding the server algorithm, or a safe failure.
     */
    private static async buildLocalIdentity(
        payload: RequestServerAnalysisPayload,
    ): Promise<
        | {
              ok: true;
              languageCode: string;
              transcriptHash: string;
          }
        | { ok: false; failure: ServerAnalysisFailure }
    > {
        const canonical = CaptionTranscriptCanonicalizer.canonicalize(payload);
        if (!canonical.ok) {
            return { ok: false, failure: { code: canonical.code } };
        }
        return {
            ok: true,
            languageCode: canonical.transcript.languageCode,
            transcriptHash: await ServerTranscriptFingerprint.sha256Hex(
                canonical.transcript.canonicalBytes,
            ),
        };
    }

    /**
     * Looks up one exact cache entry and otherwise submits complete captions.
     *
     * @param payload - Session-bound timed caption upload.
     * @param sender - Browser sender containing the source tab.
     * @returns Processing or terminal acknowledgement.
     */
    static async handleRequest(
        payload: RequestServerAnalysisPayload,
        sender: Runtime.MessageSender,
    ): Promise<RequestServerAnalysisResponse> {
        const tabId = sender.tab?.id;
        if (tabId === undefined) {
            return { ok: false, error: 'Missing sender tab id.' };
        }
        if (
            !(await ServerAnalysisRuntimeMessages.loadServerModeActive()) ||
            !(await ServerAnalysisRuntimeMessages.isTabStillOnRequestedVideo(
                tabId,
                payload.videoId,
            ))
        ) {
            return { ok: true, status: 'inactive' };
        }

        const localIdentity =
            await ServerAnalysisRuntimeMessages.buildLocalIdentity(payload);
        if (!localIdentity.ok) {
            await ServerAnalysisRuntimeMessages.publishFailure({
                tabId,
                sessionId: payload.sessionId,
                videoId: payload.videoId,
                failure: localIdentity.failure,
            });
            return { ok: true, status: 'unavailable' };
        }

        try {
            const config = await ServerAnalysisConfiguration.loadActive();
            const cached =
                config === null
                    ? null
                    : await ServerResultCacheStorage.loadExact({
                          videoId: payload.videoId,
                          languageCode: localIdentity.languageCode,
                          transcriptHash: localIdentity.transcriptHash,
                          algorithmVersion: config.algorithmVersion,
                      });
            if (cached?.status === 'ready') {
                await ServerAnalysisRuntimeMessages.deliverDetectedBlocks({
                    tabId,
                    sessionId: payload.sessionId,
                    videoId: cached.videoId,
                    promoBlocks: cached.promoBlocks,
                    source: 'local_cache',
                    durationSec: payload.durationSec,
                });
                return { ok: true, status: 'ready' };
            }
            if (cached?.status === 'no_promo') {
                PromoDetectionStore.set(tabId, {
                    videoId: cached.videoId,
                    sessionId: payload.sessionId,
                    status: 'no_promo',
                    source: 'local_cache',
                });
                return { ok: true, status: 'no_promo' };
            }

            const response = await ServerAnalysisClient.requestAnalysis({
                videoId: payload.videoId,
                durationSec: payload.durationSec,
                extensionVersion: browser.runtime.getManifest().version,
                languageCode: payload.languageCode,
                segments: payload.segments,
            });
            return await ServerAnalysisRuntimeMessages.applyServerResponse({
                tabId,
                sessionId: payload.sessionId,
                requestedVideoId: payload.videoId,
                response,
                durationSec: payload.durationSec,
                readySource: 'server_cache',
            });
        } catch (error) {
            const failure =
                ServerAnalysisRuntimeMessages.normalizeClientFailure(error);
            await ServerAnalysisRuntimeMessages.publishFailure({
                tabId,
                sessionId: payload.sessionId,
                videoId: payload.videoId,
                failure,
            });
            return { ok: false, error: 'Server analysis failed.' };
        }
    }

    /**
     * Polls one owner-authorized job using identity retained by content.
     *
     * @param payload - Session/job identity that survives worker restart.
     * @param sender - Browser sender containing the source tab.
     * @returns Processing, resubmission, or terminal acknowledgement.
     */
    static async handleRefreshStatus(
        payload: RefreshServerAnalysisStatusPayload,
        sender: Runtime.MessageSender,
    ): Promise<RefreshServerAnalysisStatusResponse> {
        const tabId = sender.tab?.id;
        if (tabId === undefined) {
            return { ok: false, error: 'Missing sender tab id.' };
        }
        if (
            payload.videoId !== payload.identity.videoId ||
            !(await ServerAnalysisRuntimeMessages.loadServerModeActive()) ||
            !(await ServerAnalysisRuntimeMessages.isTabStillOnRequestedVideo(
                tabId,
                payload.videoId,
            ))
        ) {
            return { ok: true, status: 'inactive' };
        }

        try {
            const response = await ServerAnalysisClient.requestJobStatus({
                jobId: payload.jobId,
                identity: payload.identity,
            });
            if (
                response.status === 'error' &&
                response.error.code === SERVER_ANALYSIS_FAILURE_CODE.JobNotFound
            ) {
                return { ok: true, status: 'resubmit_required' };
            }
            return await ServerAnalysisRuntimeMessages.applyServerResponse({
                tabId,
                sessionId: payload.sessionId,
                requestedVideoId: payload.videoId,
                response,
                readySource: 'server',
            });
        } catch (error) {
            const failure =
                ServerAnalysisRuntimeMessages.normalizeClientFailure(error);
            await ServerAnalysisRuntimeMessages.publishFailure({
                tabId,
                sessionId: payload.sessionId,
                videoId: payload.videoId,
                failure,
                algorithmVersion: payload.identity.algorithmVersion,
            });
            return { ok: false, error: 'Server analysis failed.' };
        }
    }
}
