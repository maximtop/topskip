/**
 * @file Handles session-bound Server-mode analysis runtime messages,
 * keeping every HTTP operation and route-ownership check in the background.
 */

import { CaptionTranscriptCanonicalizer } from '@topskip/common/captions/canonical-transcript';
import {
    PROMO_DETECTION_STATUS,
    type PromoBlock,
} from '@topskip/common/promo-types';
import {
    SERVER_ANALYSIS_API_VERSION,
    SERVER_ANALYSIS_FAILURE_CODE,
    serverAnalysisFailureSchema,
    serverTranscriptIdentitySchema,
    type ServerAnalysisFailure,
    type ServerAnalysisResponse,
    type ServerTranscriptIdentity,
} from '@topskip/common/server-analysis-contract';
import * as v from 'valibot';

import { DebugLog } from '@/background/debug-log/debug-log';
import { PromoDetectionStore } from '@/background/promo-detection-store';
import { ServerAnalysisClient } from '@/background/server-analysis-client';
import { ServerAnalysisConfiguration } from '@/background/server-analysis-configuration';
import { BackgroundServerAnalysisLog } from '@/background/server-analysis-log';
import { ServerTranscriptIdentity as ServerTranscriptFingerprint } from '@/background/server-transcript-identity';
import { PrefsSyncStorage } from '@/background/storage/prefs-sync';
import { ServerResultCacheStorage } from '@/background/storage/server-result-cache';
import browser from '@/shared/browser';
import { ANALYSIS_MODE, TOP_FRAME_ID } from '@/shared/constants';
import {
    DEBUG_LOG_EVENT,
    formatPromoBlockTimings,
} from '@/shared/debug-log-events';
import {
    contentRouteStatusResponseSchema,
    PROMO_DETECTION_SOURCE,
    SERVER_ANALYSIS_PHASE,
    SERVER_ANALYSIS_SESSION_EVENT,
    TOPSKIP_MESSAGE,
    type RefreshServerAnalysisStatusPayload,
    type RefreshServerAnalysisStatusResponse,
    type RequestServerAnalysisPayload,
    type RequestServerAnalysisResponse,
    type ServerAnalysisFailureContext,
    type ServerAnalysisSessionEventPayload,
    type ServerPromoDetectionSource,
    type TopSkipRuntimeMessage,
} from '@/shared/messages';
import {
    SERVER_FAILURE_CATEGORY,
    classifyServerFailure,
} from '@/shared/server-analysis-failure';
import { isTopSkipContentDocumentUrl } from '@/shared/watch-route';

import type { Runtime } from 'webextension-polyfill/namespaces/runtime';

const LOCAL_SESSION_FAILURE_CODE = {
    [SERVER_ANALYSIS_SESSION_EVENT.CaptionsUnavailable]:
        SERVER_ANALYSIS_FAILURE_CODE.CaptionsUnavailable,
    [SERVER_ANALYSIS_SESSION_EVENT.CaptionExtractionFailed]:
        SERVER_ANALYSIS_FAILURE_CODE.CaptionExtractionFailed,
    [SERVER_ANALYSIS_SESSION_EVENT.AnalysisInterrupted]:
        SERVER_ANALYSIS_FAILURE_CODE.AnalysisInterrupted,
} as const;

/**
 * Fresh backend responses may be computed or served by the backend cache.
 */
type ReadyServerDetectionSource = | typeof PROMO_DETECTION_SOURCE.Server
    | typeof PROMO_DETECTION_SOURCE.ServerCache;

/**
 * Handles session-bound Server analysis while keeping every HTTP operation in background.
 */
export class ServerAnalysisRuntimeMessages {
    /**
     * Converts unknown client failures to the allow-listed response vocabulary.
     *
     * @param error - Opaque transport or validation failure.
     *
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
     * Prefers the response-observed algorithm version over the cached config's,
     * so a fresh server-reported version is never shadowed by a stale one.
     *
     * @param algorithmVersion - Version observed in config or a response.
     * @param configAlgorithmVersion - Version from the cached compatibility config.
     *
     * @returns Spreadable field, or an empty object when neither is known.
     */
    private static resolveAlgorithmVersionField(
        algorithmVersion: string | undefined,
        configAlgorithmVersion: string | undefined,
    ): { algorithmVersion: string } | Record<string, never> {
        if (algorithmVersion !== undefined) {
            return { algorithmVersion };
        }
        if (configAlgorithmVersion !== undefined) {
            return { algorithmVersion: configAlgorithmVersion };
        }
        return {};
    }

    /**
     * Enriches stable failure details only from already validated local metadata.
     *
     * @param failure - Validated message-free failure details.
     * @param algorithmVersion - Version observed in config or a response.
     *
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
            ...ServerAnalysisRuntimeMessages.resolveAlgorithmVersionField(
                algorithmVersion,
                config?.algorithmVersion,
            ),
            ...(config?.supportIssueBaseUrl === undefined
                ? {}
                : { supportIssueBaseUrl: config.supportIssueBaseUrl }),
        };
    }

    /**
     * Publishes one safe Server failure without retaining captions or raw responses.
     *
     * @param input - Target session, stable failure, and optional server version.
     * @param input.tabId - Source tab that owns the session.
     * @param input.sessionId - Content-owned session id.
     * @param input.videoId - Video id tied to the session.
     * @param input.failure - Stable failure details to publish.
     * @param input.algorithmVersion - Server-reported version, when known.
     *
     * @returns Whether the failure still belonged to the live content route.
     */
    private static async publishFailure(input: {
        tabId: number;
        sessionId: string;
        videoId: string;
        failure: ServerAnalysisFailure;
        algorithmVersion?: string;
    }): Promise<boolean> {
        const category = classifyServerFailure(input.failure.code);
        const failureContext = await ServerAnalysisRuntimeMessages.buildFailureContext(
            input.failure,
            input.algorithmVersion,
        );
        if (
            !(await ServerAnalysisRuntimeMessages.isCurrentServerRoute(
                input.tabId,
                input.videoId,
                input.sessionId,
            ))
        ) {
            return false;
        }
        DebugLog.record(
            DEBUG_LOG_EVENT.TerminalEvent,
            { failureCode: input.failure.code },
            {
                tab: input.tabId,
                video: input.videoId,
                session: input.sessionId,
                support: input.failure.supportId,
            },
        );
        await PromoDetectionStore.set(input.tabId, {
            videoId: input.videoId,
            sessionId: input.sessionId,
            status:
                category === SERVER_FAILURE_CATEGORY.ServerFailure
                    ? PROMO_DETECTION_STATUS.Error
                    : PROMO_DETECTION_STATUS.Unavailable,
            source: PROMO_DETECTION_SOURCE.Server,
            serverFailure: failureContext,
        });
        return true;
    }

    /**
     * Delivers exact-session blocks through content and popup paths.
     *
     * @param input - Current tab/session, blocks, and cache origin.
     * @param input.tabId - Source tab that owns the session.
     * @param input.sessionId - Content-owned session id.
     * @param input.videoId - Video id the blocks apply to.
     * @param input.promoBlocks - Detected promo blocks to deliver.
     * @param input.source - Origin of these blocks (server, server cache, or local cache).
     * @param input.durationSec - Video duration, when known.
     *
     * @returns Whether the exact live route accepted the delivery.
     */
    private static async deliverDetectedBlocks(input: {
        tabId: number;
        sessionId: string;
        videoId: string;
        promoBlocks: PromoBlock[];
        source: ServerPromoDetectionSource;
        durationSec?: number;
    }): Promise<boolean> {
        if (
            !(await ServerAnalysisRuntimeMessages.isCurrentServerRoute(
                input.tabId,
                input.videoId,
                input.sessionId,
            ))
        ) {
            BackgroundServerAnalysisLog.info('delivery-skipped', {
                tabId: input.tabId,
                videoId: input.videoId,
                reason: 'stale-tab',
            });
            DebugLog.record(
                DEBUG_LOG_EVENT.DeliverySkipped,
                { reason: 'stale-tab' },
                {
                    tab: input.tabId,
                    video: input.videoId,
                    session: input.sessionId,
                },
            );
            return false;
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
            return false;
        }
        if (
            !(await ServerAnalysisRuntimeMessages.isCurrentServerRoute(
                input.tabId,
                input.videoId,
                input.sessionId,
            ))
        ) {
            return false;
        }

        const durationState = input.durationSec !== undefined
            && Number.isFinite(input.durationSec)
            && input.durationSec >= 0
            ? { durationSec: input.durationSec }
            : {};
        await PromoDetectionStore.set(input.tabId, {
            videoId: input.videoId,
            sessionId: input.sessionId,
            status: PROMO_DETECTION_STATUS.Detected,
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
        DebugLog.record(
            DEBUG_LOG_EVENT.CacheDecision,
            { decision: input.source },
            {
                tab: input.tabId,
                video: input.videoId,
                session: input.sessionId,
            },
        );
        DebugLog.record(
            DEBUG_LOG_EVENT.BlocksDelivered,
            {
                count: input.promoBlocks.length,
                blocks: formatPromoBlockTimings(input.promoBlocks),
            },
            {
                tab: input.tabId,
                video: input.videoId,
                session: input.sessionId,
            },
        );
        return true;
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
     * Asks the live isolated bundle to prove exact Server-session ownership.
     *
     * @param tabId - Source tab that initiated the session.
     * @param videoId - Video id tied to the session.
     * @param sessionId - Content-owned session expected to remain active.
     *
     * @returns Whether the current bundle still owns the requested route.
     */
    private static async isCurrentServerRoute(
        tabId: number,
        videoId: string,
        sessionId: string,
    ): Promise<boolean> {
        try {
            const response: unknown = await browser.tabs.sendMessage(tabId, {
                type: TOPSKIP_MESSAGE.CONTENT_ROUTE_STATUS,
            });
            const parsed = v.safeParse(
                contentRouteStatusResponseSchema,
                response,
            );
            if (!parsed.success) {
                return false;
            }
            const current = parsed.output;
            return (
                current.extensionVersion
                    === browser.runtime.getManifest().version
                && current.videoId === videoId
                && current.enabled
                && current.analysisMode === ANALYSIS_MODE.Server
                && current.serverSessionId === sessionId
            );
        } catch {
            return false;
        }
    }

    /**
     * Trusts this extension's top-frame messages from a declaratively matched
     * document while leaving mutable route ownership to the live content probe.
     *
     * @param sender - Browser-authenticated runtime sender metadata.
     *
     * @returns Trusted source tab id, or `null` without document proof.
     */
    private static trustedSenderTabId(
        sender: Runtime.MessageSender,
    ): number | null {
        const tabId = sender.tab?.id;
        const senderUrl = sender.url;
        if (
            sender.id !== browser.runtime.id
            || tabId === undefined
            || sender.frameId !== TOP_FRAME_ID
            || senderUrl === undefined
            || !isTopSkipContentDocumentUrl(senderUrl)
        ) {
            return null;
        }
        return tabId;
    }

    /**
     * Extracts authoritative identity only from an identified response variant.
     *
     * @param response - Validated public server response.
     *
     * @returns Complete identity, or `null` for pre-identity failures.
     */
    private static responseIdentity(
        response: ServerAnalysisResponse,
    ): ServerTranscriptIdentity | null {
        if (
            !('videoId' in response)
            || !('languageCode' in response)
            || !('transcriptHash' in response)
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
     * @param input.tabId - Source tab that owns the session.
     * @param input.sessionId - Content-owned session id.
     * @param input.requestedVideoId - Video id the request was made for.
     * @param input.response - Validated backend response to map.
     * @param input.durationSec - Video duration, when known.
     * @param input.readySource - Origin to record for a `ready` result.
     *
     * @returns Runtime acknowledgement consumed by the content-owned lifecycle.
     */
    private static async applyServerResponse(input: {
        tabId: number;
        sessionId: string;
        requestedVideoId: string;
        response: ServerAnalysisResponse;
        durationSec?: number;
        readySource: ReadyServerDetectionSource;
    }): Promise<RequestServerAnalysisResponse> {
        if (
            !(await ServerAnalysisRuntimeMessages.loadServerModeActive())
            || !(await ServerAnalysisRuntimeMessages.isCurrentServerRoute(
                input.tabId,
                input.requestedVideoId,
                input.sessionId,
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
                if (
                    !(await ServerAnalysisRuntimeMessages.isCurrentServerRoute(
                        input.tabId,
                        input.requestedVideoId,
                        input.sessionId,
                    ))
                ) {
                    return { ok: true, status: 'inactive' };
                }
                await PromoDetectionStore.set(input.tabId, {
                    videoId: input.requestedVideoId,
                    sessionId: input.sessionId,
                    status: PROMO_DETECTION_STATUS.Analyzing,
                    source: PROMO_DETECTION_SOURCE.Server,
                    serverAnalysisPhase: SERVER_ANALYSIS_PHASE.ServerAnalysis,
                });
                return {
                    ok: true,
                    status: 'processing',
                    jobId: input.response.jobId,
                    pollAfterSec: input.response.pollAfterSec,
                    identity,
                };
            case 'ready': {
                try {
                    await ServerResultCacheStorage.saveTerminalResponse(
                        input.response,
                    );
                } catch {
                    // Cache persistence cannot block a valid terminal result.
                }
                const delivered = await ServerAnalysisRuntimeMessages.deliverDetectedBlocks({
                    tabId: input.tabId,
                    sessionId: input.sessionId,
                    videoId: input.response.videoId,
                    promoBlocks: input.response.promoBlocks,
                    source: input.readySource,
                    durationSec: input.durationSec,
                });
                if (!delivered) {
                    return { ok: true, status: 'inactive' };
                }
                return { ok: true, status: 'ready' };
            }
            case 'no_promo':
                try {
                    await ServerResultCacheStorage.saveTerminalResponse(
                        input.response,
                    );
                } catch {
                    // Cache persistence cannot block a valid terminal result.
                }
                if (
                    !(await ServerAnalysisRuntimeMessages.isCurrentServerRoute(
                        input.tabId,
                        input.requestedVideoId,
                        input.sessionId,
                    ))
                ) {
                    return { ok: true, status: 'inactive' };
                }
                await PromoDetectionStore.set(input.tabId, {
                    videoId: input.requestedVideoId,
                    sessionId: input.sessionId,
                    status: PROMO_DETECTION_STATUS.NoPromo,
                    source: PROMO_DETECTION_SOURCE.Server,
                });
                return { ok: true, status: 'no_promo' };
            case 'unavailable':
            case 'error':
            case 'rate_limited':
                if (
                    !(await ServerAnalysisRuntimeMessages.publishFailure({
                        tabId: input.tabId,
                        sessionId: input.sessionId,
                        videoId: input.requestedVideoId,
                        failure: input.response.error,
                        algorithmVersion: input.response.algorithmVersion,
                    }))
                ) {
                    return { ok: true, status: 'inactive' };
                }
                return { ok: true, status: input.response.status };
            // no default
        }
        return { ok: true, status: 'inactive' };
    }

    /**
     * Applies caption acquisition phases locally without contacting TopSkip.
     *
     * @param payload - Validated session event from content.
     * @param sender - Browser sender containing the source tab.
     *
     * @returns Safe acknowledgement after the local state update.
     */
    static async handleSessionEvent(
        payload: ServerAnalysisSessionEventPayload,
        sender: Runtime.MessageSender,
    ): Promise<{ ok: true } | { ok: false; error: string }> {
        if (payload.event === SERVER_ANALYSIS_SESSION_EVENT.Cancelled) {
            const tabId = ServerAnalysisRuntimeMessages.trustedSenderTabId(
                sender,
            );
            if (tabId === null) {
                return { ok: false, error: 'Untrusted sender.' };
            }
            await PromoDetectionStore.clear(tabId, payload.sessionId);
            return { ok: true };
        }
        const tabId = ServerAnalysisRuntimeMessages.trustedSenderTabId(
            sender,
        );
        if (tabId === null) {
            return { ok: true };
        }
        if (
            !(await ServerAnalysisRuntimeMessages.loadServerModeActive())
            || !(await ServerAnalysisRuntimeMessages.isCurrentServerRoute(
                tabId,
                payload.videoId,
                payload.sessionId,
            ))
        ) {
            return { ok: true };
        }
        if (
            payload.event === SERVER_ANALYSIS_SESSION_EVENT.AcquisitionStarted
        ) {
            await PromoDetectionStore.set(tabId, {
                videoId: payload.videoId,
                sessionId: payload.sessionId,
                status: PROMO_DETECTION_STATUS.Analyzing,
                source: PROMO_DETECTION_SOURCE.Server,
                serverAnalysisPhase:
                    SERVER_ANALYSIS_PHASE.CaptionAcquisition,
            });
            return { ok: true };
        }

        const code = LOCAL_SESSION_FAILURE_CODE[payload.event];
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
     *
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
     *
     * @returns Processing or terminal acknowledgement.
     */
    static async handleRequest(
        payload: RequestServerAnalysisPayload,
        sender: Runtime.MessageSender,
    ): Promise<RequestServerAnalysisResponse> {
        const tabId = ServerAnalysisRuntimeMessages.trustedSenderTabId(
            sender,
        );
        if (tabId === null) {
            return { ok: true, status: 'inactive' };
        }
        if (
            !(await ServerAnalysisRuntimeMessages.loadServerModeActive())
            || !(await ServerAnalysisRuntimeMessages.isCurrentServerRoute(
                tabId,
                payload.videoId,
                payload.sessionId,
            ))
        ) {
            return { ok: true, status: 'inactive' };
        }

        await PromoDetectionStore.set(tabId, {
            videoId: payload.videoId,
            sessionId: payload.sessionId,
            status: PROMO_DETECTION_STATUS.Analyzing,
            source: PROMO_DETECTION_SOURCE.Server,
            serverAnalysisPhase: SERVER_ANALYSIS_PHASE.CaptionAcquisition,
        });
        const localIdentity = await ServerAnalysisRuntimeMessages.buildLocalIdentity(payload);
        if (!localIdentity.ok) {
            if (
                !(await ServerAnalysisRuntimeMessages.publishFailure({
                    tabId,
                    sessionId: payload.sessionId,
                    videoId: payload.videoId,
                    failure: localIdentity.failure,
                }))
            ) {
                return { ok: true, status: 'inactive' };
            }
            return { ok: true, status: 'unavailable' };
        }

        try {
            const config = await ServerAnalysisConfiguration.loadActive();
            const cached = config === null
                ? null
                : await ServerResultCacheStorage.loadExact({
                    videoId: payload.videoId,
                    languageCode: localIdentity.languageCode,
                    transcriptHash: localIdentity.transcriptHash,
                    algorithmVersion: config.algorithmVersion,
                });
            if (cached?.status === 'ready') {
                if (
                    !(await ServerAnalysisRuntimeMessages.deliverDetectedBlocks({
                        tabId,
                        sessionId: payload.sessionId,
                        videoId: cached.videoId,
                        promoBlocks: cached.promoBlocks,
                        source: PROMO_DETECTION_SOURCE.LocalCache,
                        durationSec: payload.durationSec,
                    }))
                ) {
                    return { ok: true, status: 'inactive' };
                }
                return { ok: true, status: 'ready' };
            }
            if (cached?.status === 'no_promo') {
                if (
                    !(await ServerAnalysisRuntimeMessages.isCurrentServerRoute(
                        tabId,
                        payload.videoId,
                        payload.sessionId,
                    ))
                ) {
                    return { ok: true, status: 'inactive' };
                }
                await PromoDetectionStore.set(tabId, {
                    videoId: cached.videoId,
                    sessionId: payload.sessionId,
                    status: PROMO_DETECTION_STATUS.NoPromo,
                    source: PROMO_DETECTION_SOURCE.LocalCache,
                });
                return { ok: true, status: 'no_promo' };
            }

            if (
                !(await ServerAnalysisRuntimeMessages.isCurrentServerRoute(
                    tabId,
                    payload.videoId,
                    payload.sessionId,
                ))
            ) {
                return { ok: true, status: 'inactive' };
            }
            const response = await ServerAnalysisClient.requestAnalysis({
                videoId: payload.videoId,
                durationSec: payload.durationSec,
                extensionVersion: browser.runtime.getManifest().version,
                languageCode: payload.languageCode,
                segments: payload.segments,
                tabId,
            });
            return await ServerAnalysisRuntimeMessages.applyServerResponse({
                tabId,
                sessionId: payload.sessionId,
                requestedVideoId: payload.videoId,
                response,
                durationSec: payload.durationSec,
                readySource: PROMO_DETECTION_SOURCE.ServerCache,
            });
        } catch (error) {
            const failure = ServerAnalysisRuntimeMessages.normalizeClientFailure(error);
            if (
                !(await ServerAnalysisRuntimeMessages.publishFailure({
                    tabId,
                    sessionId: payload.sessionId,
                    videoId: payload.videoId,
                    failure,
                }))
            ) {
                return { ok: true, status: 'inactive' };
            }
            return { ok: false, error: 'Server analysis failed.' };
        }
    }

    /**
     * Polls one owner-authorized job using identity retained by content.
     *
     * @param payload - Session/job identity that survives worker restart.
     * @param sender - Browser sender containing the source tab.
     *
     * @returns Processing, resubmission, or terminal acknowledgement.
     */
    static async handleRefreshStatus(
        payload: RefreshServerAnalysisStatusPayload,
        sender: Runtime.MessageSender,
    ): Promise<RefreshServerAnalysisStatusResponse> {
        const tabId = ServerAnalysisRuntimeMessages.trustedSenderTabId(
            sender,
        );
        if (tabId === null) {
            return { ok: true, status: 'inactive' };
        }
        if (
            payload.videoId !== payload.identity.videoId
            || !(await ServerAnalysisRuntimeMessages.loadServerModeActive())
            || !(await ServerAnalysisRuntimeMessages.isCurrentServerRoute(
                tabId,
                payload.videoId,
                payload.sessionId,
            ))
        ) {
            return { ok: true, status: 'inactive' };
        }

        try {
            const response = await ServerAnalysisClient.requestJobStatus({
                jobId: payload.jobId,
                identity: payload.identity,
                tabId,
            });
            if (
                response.status === 'error'
                && response.error.code === SERVER_ANALYSIS_FAILURE_CODE.JobNotFound
            ) {
                if (
                    !(await ServerAnalysisRuntimeMessages.isCurrentServerRoute(
                        tabId,
                        payload.videoId,
                        payload.sessionId,
                    ))
                ) {
                    return { ok: true, status: 'inactive' };
                }
                return { ok: true, status: 'resubmit_required' };
            }
            return await ServerAnalysisRuntimeMessages.applyServerResponse({
                tabId,
                sessionId: payload.sessionId,
                requestedVideoId: payload.videoId,
                response,
                readySource: PROMO_DETECTION_SOURCE.Server,
            });
        } catch (error) {
            const failure = ServerAnalysisRuntimeMessages.normalizeClientFailure(error);
            if (
                !(await ServerAnalysisRuntimeMessages.publishFailure({
                    tabId,
                    sessionId: payload.sessionId,
                    videoId: payload.videoId,
                    failure,
                    algorithmVersion: payload.identity.algorithmVersion,
                }))
            ) {
                return { ok: true, status: 'inactive' };
            }
            return { ok: false, error: 'Server analysis failed.' };
        }
    }
}
