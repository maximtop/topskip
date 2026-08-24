import type { Runtime } from 'webextension-polyfill/namespaces/runtime';

import { PrefsSyncStorage } from '@/background/storage/prefs-sync';
import {
    buildPromoAnalysisLogBundle,
    listTimedLinesFromMergedTranscript,
    LogPromoAnalysis,
    logChunkPromoEntry,
    type ChunkLogOutcome,
    type PromoUncoveredRange,
} from '@/background/openrouter/log-promo-analysis';
import { DevConsole } from '@/background/dev-console';
import { PromoDetectionStore } from '@/background/promo-detection-store';
import { mergeCaptionSegmentsToTranscript } from '@/shared/captions/merge-transcript';
import {
    ANALYSIS_MODE,
    MAX_CAPTION_TRANSCRIPT_CHARS,
} from '@/shared/constants';
import browser from '@/shared/browser';
import {
    PROMO_DETECTION_SOURCE,
    TOPSKIP_MESSAGE,
    type CaptionsFromContentPayload,
    type LocalDetectionState,
    type TopSkipRuntimeMessage,
} from '@/shared/messages';
import { PROVIDER_ID } from '@/shared/providers';
import { PROVIDER_AVAILABILITY } from '@/shared/chrome-prompt-api';
import { defaultRegistry } from '@/background/providers/default-registry';
import type { ProviderRegistry } from '@/background/providers/provider-registry';
import {
    PROVIDER_ANALYSIS_FAILURE_CODE,
    type AnalyzeTranscriptResult,
} from '@/background/providers/llm-provider-adapter';
import {
    BLOCK_MERGE_GAP_SEC,
    CHUNK_BLOCK_TOLERANCE_SEC,
    LOG_CHUNK_TEXT_MAX_CHARS,
    LOG_MERGED_TEXT_MAX_CHARS,
    LOG_RAW_ASSISTANT_MAX_CHARS,
    MAX_CHUNKS_PER_VIDEO,
    OVERLAP_CEILING_SEC,
    OVERLAP_FLOOR_SEC,
    OVERLAP_FRACTION,
} from '@/background/messaging/chunk-plan-config';
import { ChunkPlanner } from '@topskip/common/promo-chunk-planner';
import { ChunkMerge } from '@topskip/common/promo-chunk-merge';
import { mergePromoBlocksWithGap } from '@topskip/common/promo-dedupe';
import {
    PROMO_DETECTION_PROMPT_VERSION,
    PROMO_DETECTION_SYSTEM_PROMPT,
} from '@/background/openrouter/promo-detection-system-prompt';
import {
    PROMO_DETECTION_STATUS,
    type PromoBlock,
} from '@topskip/common/promo-types';
import { DebugLog } from '@/background/debug-log/debug-log';
import {
    DEBUG_LOG_EVENT,
    formatPromoBlockTimings,
} from '@/shared/debug-log-events';
import { toDebugLogModelName } from '@/shared/detection-models';

/**
 * Stable code logged for an unexpected BYOK analysis exception (never the
 * free-form provider error, which can embed a response body).
 */
const PROMO_ANALYSIS_FAILED_CODE = 'promo-analysis-failed';

/**
 * Model stand-in written before any adapter call has reported a model name.
 */
const BYOK_MODEL_UNKNOWN = 'unknown';

/**
 * Stable BYOK outcome kinds written to the debug log; never provider
 * text. `byok-run-ended` uses `Success` for both no-promo and promo results
 * (`parsedBlocks` distinguishes them).
 */
const BYOK_OUTCOME = {
    Success: 'success',
    TooLarge: 'too-large',
    ParseError: 'parse-error',
    AdapterError: 'adapter-error',
    Aborted: 'aborted',
    HostAccessRequired: 'host-access-required',
} as const;

/**
 * `host-access-check` outcome when the optional host grant is present.
 */
const HOST_ACCESS_GRANTED_OUTCOME = 'granted';

/**
 * Orchestrates LLM analysis after captions arrive; static API only.
 */
export class PromoAnalysis {
    /**
     * In-flight caption analysis per tab (abort + provider context).
     */
    private static readonly inflight = new Map<
        number,
        { videoId: string; abort: AbortController; providerId: string | null }
    >();

    /**
     * LLM adapters used for `analyzeTranscript` on this worker.
     */
    private static registry: ProviderRegistry = defaultRegistry;

    /**
     * Splits chunk user message on newlines into two contiguous halves for a
     * bounded `tooLarge` retry (non-recursive).
     *
     * @param text - Chunk user message
     * @returns Two halves or `null` if not splittable
     */
    private static splitTranscriptLinesInHalf(
        text: string,
    ): [string, string] | null {
        const lines = text.split('\n');
        if (lines.length < 2) {
            return null;
        }
        const mid = Math.ceil(lines.length / 2);
        return [lines.slice(0, mid).join('\n'), lines.slice(mid).join('\n')];
    }

    /**
     * Caption time span covering the timed lines present in one chunk slice.
     *
     * @param chunkText - `[sec] text` lines
     * @returns First and last caption seconds in the slice
     */
    private static timeRangeFromChunkText(chunkText: string): {
        startSec: number;
        endSec: number;
    } {
        const t = listTimedLinesFromMergedTranscript(chunkText);
        if (t.length === 0) {
            return { startSec: 0, endSec: 0 };
        }
        return {
            startSec: t[0].sec,
            endSec: t[t.length - 1].sec,
        };
    }

    /**
     * Time range of timed caption lines after the last planned chunk (chunk-cap
     * tail), if any.
     *
     * @param mergedText - Full merged transcript
     * @param lastChunkLineEndIndex - Inclusive index of the last caption line
     *   included in the final planned chunk
     * @returns First and last seconds of the dropped tail, or `null`
     */
    private static droppedTailRangeSec(
        mergedText: string,
        lastChunkLineEndIndex: number,
    ): { startSec: number; endSec: number } | null {
        const lines = listTimedLinesFromMergedTranscript(mergedText);
        const nextIdx = lastChunkLineEndIndex + 1;
        if (nextIdx >= lines.length) {
            return null;
        }
        const firstLine = lines[nextIdx];
        const lastLine = lines[lines.length - 1];
        if (firstLine === undefined || lastLine === undefined) {
            return null;
        }
        return { startSec: firstLine.sec, endSec: lastLine.sec };
    }

    /**
     * Maps adapter outcome + abort flag to a compact chunk log label.
     *
     * @param result - Adapter result
     * @param aborted - Whether the run was aborted
     * @returns Log label
     */
    private static chunkOutcomeForLog(
        result: AnalyzeTranscriptResult,
        aborted: boolean,
    ): ChunkLogOutcome {
        if (aborted) {
            // FIXME why not enum? I saw this magic strings in other places too
            return 'aborted';
        }
        if (result.ok) {
            return 'success';
        }
        if (result.tooLarge === true) {
            return 'too_large';
        }
        if (
            result.rawAssistant !== undefined &&
            result.rawAssistant.length > 0
        ) {
            return 'parse_error';
        }
        return 'adapter_error';
    }

    /**
     * Separates a revoked optional grant from ordinary provider failures so
     * the run returns to setup-required without consuming remaining chunks.
     *
     * @param result - Provider result inspected before generic error handling.
     * @returns Whether the provider host grant must be restored explicitly.
     */
    private static requiresProviderHostAccess(
        result: AnalyzeTranscriptResult,
    ): boolean {
        return (
            !result.ok &&
            result.failureCode ===
                PROVIDER_ANALYSIS_FAILURE_CODE.HostAccessRequired
        );
    }

    /**
     * Maps one adapter result to a stable outcome kind for `byok-chunk`:
     * never the free-form provider error (it never reads `error` or
     * `rawAssistant`, which can embed provider response text).
     *
     * @param result - Adapter result of the chunk call.
     * @param aborted - Whether the run was superseded while the call was in flight.
     * @returns Stable outcome token.
     */
    private static byokChunkOutcomeForLog(
        result: AnalyzeTranscriptResult,
        aborted: boolean,
    ): string {
        if (aborted) {
            return BYOK_OUTCOME.Aborted;
        }
        if (result.ok) {
            return BYOK_OUTCOME.Success;
        }
        if (
            result.failureCode === PROVIDER_ANALYSIS_FAILURE_CODE.HostAccessRequired
        ) {
            return BYOK_OUTCOME.HostAccessRequired;
        }
        if (result.tooLarge === true) {
            return BYOK_OUTCOME.TooLarge;
        }
        if (result.kind === 'parse') {
            return BYOK_OUTCOME.ParseError;
        }
        if (result.kind === 'aborted') {
            return BYOK_OUTCOME.Aborted;
        }
        return BYOK_OUTCOME.AdapterError;
    }

    /**
     * Records the terminal BYOK metadata summary (no prompt/assistant text).
     *
     * @param input - Terminal run counters and stable outcome.
     */
    private static recordByokRunEnded(input: {
        tabId: number;
        videoId: string;
        provider: string;
        model: string;
        chunks: number;
        parsedBlocks: number;
        coverage: number;
        uncovered: number;
        blocks: PromoBlock[];
        totalLatencyMs: number;
        outcome: string;
    }): void {
        DebugLog.record(
            DEBUG_LOG_EVENT.ByokRunEnded,
            {
                provider: input.provider,
                model: input.model,
                chunks: input.chunks,
                parsedBlocks: input.parsedBlocks,
                coverage: input.coverage,
                uncovered: input.uncovered,
                blocks: formatPromoBlockTimings(input.blocks),
                totalLatencyMs: Math.round(input.totalLatencyMs),
                outcome: input.outcome,
            },
            { tab: input.tabId, video: input.videoId },
        );
    }

    /**
     * Replaces the registry used for caption-triggered promo analysis.
     *
     * @param registry - Provider registry used for subsequent analysis runs
     */
    static setRegistry(registry: ProviderRegistry): void {
        PromoAnalysis.registry = registry;
    }

    /**
     * Aborts the in-flight LLM run for one tab, if any.
     *
     * @param tabId - Target tab whose current analysis should be aborted
     */
    static abortForTab(tabId: number): void {
        const inflight = PromoAnalysis.inflight.get(tabId);
        if (!inflight) {
            return;
        }
        inflight.abort.abort();
        PromoAnalysis.inflight.delete(tabId);
    }

    /**
     * Invalidates every tab-owned provider run before a global preference
     * transition can make an old same-video result look current again.
     */
    static abortAll(): void {
        for (const tabId of [...PromoAnalysis.inflight.keys()]) {
            PromoAnalysis.abortForTab(tabId);
        }
    }

    /**
     * Couples abort state with map identity so an old async continuation cannot
     * reclaim a tab after a same-video replacement has installed its owner.
     *
     * @param tabId - Tab whose provider run is being checked.
     * @param abort - Controller captured by the async continuation.
     * @returns Whether the continuation still owns the live provider route.
     */
    private static isCurrentRun(
        tabId: number,
        abort: AbortController,
    ): boolean {
        return (
            !abort.signal.aborted &&
            PromoAnalysis.inflight.get(tabId)?.abort === abort
        );
    }

    /**
     * Aborts any in-flight work that was started under a different provider.
     *
     * @param providerId - Newly selected provider identifier
     */
    static abortForProviderChange(providerId: string): void {
        for (const [tabId, inflight] of PromoAnalysis.inflight.entries()) {
            if (
                inflight.providerId === null ||
                inflight.providerId !== providerId
            ) {
                PromoAnalysis.abortForTab(tabId);
            }
        }
    }

    /**
     * Runs after successful captions from the watch content script (non-blocking
     * for the ack).
     *
     * @param sender - Message sender (must include `tab.id`)
     * @param payload - Successful captions payload
     */
    static onCaptionsReady(
        sender: Runtime.MessageSender,
        payload: Extract<CaptionsFromContentPayload, { ok: true }>,
    ): void {
        const tabId = sender.tab?.id;
        if (tabId === undefined) {
            return;
        }
        void PromoAnalysis.run(tabId, payload);
    }

    /**
     * End-to-end chunked promo detection for one tab’s merged transcript.
     *
     * @param tabId - Target tab
     * @param payload - Caption payload
     * @returns Promise that settles when analysis finishes or aborts
     */
    private static async run(
        tabId: number,
        payload: Extract<CaptionsFromContentPayload, { ok: true }>,
    ): Promise<void> {
        const { videoId, languageCode, segments } = payload;

        PromoAnalysis.abortForTab(tabId);
        const abort = new AbortController();
        PromoAnalysis.inflight.set(tabId, {
            videoId,
            abort,
            providerId: null,
        });

        const runStartedAt = performance.now();

        // `let` widens the literal type to `string`.
        let runProvider = BYOK_MODEL_UNKNOWN;
        let runModel = BYOK_MODEL_UNKNOWN;

        const setStatus = async (
            state: Omit<LocalDetectionState, 'source'>,
        ): Promise<void> => {
            if (!PromoAnalysis.isCurrentRun(tabId, abort)) {
                return;
            }
            await PromoDetectionStore.set(tabId, {
                ...state,
                source: PROMO_DETECTION_SOURCE.LocalProvider,
            });
        };

        try {
            await PrefsSyncStorage.ready();
            if (!PromoAnalysis.isCurrentRun(tabId, abort)) {
                return;
            }
            const prefs = await PrefsSyncStorage.load();
            if (!PromoAnalysis.isCurrentRun(tabId, abort)) {
                return;
            }
            if (!prefs.enabled || prefs.analysisMode !== ANALYSIS_MODE.Byok) {
                return;
            }

            const providerId = prefs.providerId;
            runProvider = providerId;
            DebugLog.record(
                DEBUG_LOG_EVENT.ByokRunStarted,
                { provider: providerId },
                { tab: tabId, video: videoId },
            );
            PromoAnalysis.inflight.set(tabId, {
                videoId,
                abort,
                providerId,
            });

            const adapter = PromoAnalysis.registry.get(providerId);
            if (!adapter) {
                await setStatus({
                    videoId,
                    status: PROMO_DETECTION_STATUS.NotConfigured,
                });
                return;
            }

            const avail = await adapter.availability();
            if (!PromoAnalysis.isCurrentRun(tabId, abort)) {
                return;
            }
            if (avail === PROVIDER_AVAILABILITY.UNAVAILABLE) {
                await setStatus({
                    videoId,
                    status: PROMO_DETECTION_STATUS.NotConfigured,
                });
                return;
            }

            const merged = mergeCaptionSegmentsToTranscript(
                segments,
                MAX_CAPTION_TRANSCRIPT_CHARS,
            );
            if (segments.length === 0 || merged.text.trim().length === 0) {
                await setStatus({
                    videoId,
                    status: PROMO_DETECTION_STATUS.NoPromo,
                });
                return;
            }

            await setStatus({
                videoId,
                status: PROMO_DETECTION_STATUS.Analyzing,
            });
            if (!PromoAnalysis.isCurrentRun(tabId, abort)) {
                return;
            }

            const budget = await adapter.maxTranscriptChars();
            if (!PromoAnalysis.isCurrentRun(tabId, abort)) {
                return;
            }
            if (budget <= 0) {
                await setStatus({
                    videoId,
                    status: PROMO_DETECTION_STATUS.NotConfigured,
                    error: 'LLM provider has no transcript budget',
                });
                return;
            }

            DebugLog.record(
                DEBUG_LOG_EVENT.HostAccessCheck,
                { provider: providerId, outcome: HOST_ACCESS_GRANTED_OUTCOME },
                { tab: tabId, video: videoId },
            );

            const plan = ChunkPlanner.buildChunkPlan(
                listTimedLinesFromMergedTranscript(merged.text),
                {
                    budgetChars: budget,
                    maxChunks: MAX_CHUNKS_PER_VIDEO,
                    overlap: {
                        kind: 'dynamic',
                        floorSec: OVERLAP_FLOOR_SEC,
                        ceilingSec: OVERLAP_CEILING_SEC,
                        fraction: OVERLAP_FRACTION,
                    },
                },
            );
            const uncoveredRanges: PromoUncoveredRange[] = [];
            if (plan.partialCoverage && plan.chunks.length > 0) {
                const last = plan.chunks[plan.chunks.length - 1];
                if (last !== undefined) {
                    const tail = PromoAnalysis.droppedTailRangeSec(
                        merged.text,
                        last.lineEndIndex,
                    );
                    if (tail !== null) {
                        uncoveredRanges.push({
                            startSec: tail.startSec,
                            endSec: tail.endSec,
                            kind: 'dropped_tail',
                        });
                    }
                }
            }

            const baseParams = {
                videoId,
                languageCode,
                durationSec: undefined satisfies number | undefined,
                signal: abort.signal,
            };

            let mergedBlocks: PromoBlock[] = [];
            let totalAdapterLatencyMs = 0;
            let totalAdapterCalls = 0;
            let chunkFailures = 0;
            let anyPartial = plan.partialCoverage || merged.truncated;
            let lastRawAssistant: string | null = null;
            const chunkCount = plan.chunks.length;

            const recordChunk = (input: {
                result: AnalyzeTranscriptResult;
                aborted: boolean;
                chunkIndex: number;
                startSec: number;
                endSec: number;
                chars: number;
                latencyMs: number;
            }): void => {
                if (input.result.ok) {
                    runModel = toDebugLogModelName(
                        providerId,
                        input.result.providerMeta.model,
                    );
                }
                let parsedBlocks: number | undefined;
                if (input.result.ok) {
                    parsedBlocks = input.result.hasPromo
                        ? input.result.blocks.length
                        : 0;
                }
                const status: number | null | undefined = input.result.ok
                    ? undefined
                    : input.result.status;
                DebugLog.record(
                    DEBUG_LOG_EVENT.ByokChunk,
                    {
                        provider: providerId,
                        model: runModel,
                        chunk: input.chunkIndex,
                        chunks: chunkCount,
                        startSec: input.startSec,
                        endSec: input.endSec,
                        chars: input.chars,
                        latencyMs: Math.round(input.latencyMs),
                        outcome: PromoAnalysis.byokChunkOutcomeForLog(
                            input.result,
                            input.aborted,
                        ),
                        parsedBlocks,
                        status: status ?? undefined,
                    },
                    { tab: tabId, video: videoId },
                );
            };

            let providerHostAccessRequired = false;

            const stopForMissingProviderHostAccess = async (
                result: AnalyzeTranscriptResult,
            ): Promise<boolean> => {
                if (!PromoAnalysis.requiresProviderHostAccess(result)) {
                    return false;
                }
                if (providerHostAccessRequired) {
                    return true;
                }
                providerHostAccessRequired = true;
                DebugLog.record(
                    DEBUG_LOG_EVENT.HostAccessCheck,
                    {
                        provider: providerId,
                        outcome: BYOK_OUTCOME.HostAccessRequired,
                    },
                    { tab: tabId, video: videoId },
                );
                await setStatus({
                    videoId,
                    status: PROMO_DETECTION_STATUS.NotConfigured,
                });
                return true;
            };

            const processSlice = async (
                chunkText: string,
                chunkIndex: number,
                chunkCountInner: number,
                retryLabel: string | undefined,
            ): Promise<void> => {
                if (!PromoAnalysis.isCurrentRun(tabId, abort)) {
                    return;
                }
                const { startSec: cStart, endSec: cEnd } =
                    PromoAnalysis.timeRangeFromChunkText(chunkText);
                const t0 = performance.now();
                const result = await adapter.analyzeTranscript({
                    ...baseParams,
                    transcript: chunkText,
                });
                if (!PromoAnalysis.isCurrentRun(tabId, abort)) {
                    return;
                }
                const latencyMs = performance.now() - t0;
                totalAdapterCalls = totalAdapterCalls + 1;
                totalAdapterLatencyMs = totalAdapterLatencyMs + latencyMs;

                recordChunk({
                    result,
                    aborted: !PromoAnalysis.isCurrentRun(tabId, abort),
                    chunkIndex,
                    startSec: cStart,
                    endSec: cEnd,
                    chars: chunkText.length,
                    latencyMs,
                });

                const aborted = !PromoAnalysis.isCurrentRun(tabId, abort);
                if (__TOPSKIP_INCLUDE_DEV_LOCAL__) {
                    if (result.ok) {
                        lastRawAssistant = result.rawAssistant;
                    } else if (result.rawAssistant !== undefined) {
                        lastRawAssistant = result.rawAssistant;
                    }

                    let parsedCount: number | undefined;
                    if (result.ok && result.hasPromo) {
                        parsedCount = result.blocks.length;
                    } else if (result.ok && !result.hasPromo) {
                        parsedCount = 0;
                    }

                    logChunkPromoEntry({
                        chunkIndex,
                        chunkCount: chunkCountInner,
                        chunkStartSec: cStart,
                        chunkEndSec: cEnd,
                        chunkChars: chunkText.length,
                        promptVersion: PROMO_DETECTION_PROMPT_VERSION,
                        chunkText,
                        chunkTextMaxChars: LOG_CHUNK_TEXT_MAX_CHARS,
                        rawAssistant: result.ok
                            ? result.rawAssistant
                            : (result.rawAssistant ?? null),
                        rawAssistantMaxChars: LOG_RAW_ASSISTANT_MAX_CHARS,
                        adapterLatencyMs: latencyMs,
                        outcome: PromoAnalysis.chunkOutcomeForLog(
                            result,
                            aborted,
                        ),
                        parsedBlockCount: parsedCount,
                        retryLabel,
                    });
                }

                if (aborted) {
                    return;
                }

                if (await stopForMissingProviderHostAccess(result)) {
                    return;
                }
                if (!PromoAnalysis.isCurrentRun(tabId, abort)) {
                    return;
                }

                if (!result.ok) {
                    chunkFailures = chunkFailures + 1;
                    if (result.tooLarge === true) {
                        anyPartial = true;
                    }
                    uncoveredRanges.push({
                        startSec: cStart,
                        endSec: cEnd,
                        kind: 'failed_chunk',
                    });
                    return;
                }

                if (!result.hasPromo) {
                    return;
                }

                const filtered = ChunkMerge.filterPromoBlocksForChunkTimeRange(
                    result.blocks,
                    cStart,
                    cEnd,
                    CHUNK_BLOCK_TOLERANCE_SEC,
                );
                mergedBlocks = mergePromoBlocksWithGap(
                    [...mergedBlocks, ...filtered],
                    BLOCK_MERGE_GAP_SEC,
                );

                try {
                    await browser.tabs.sendMessage(tabId, {
                        type: TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED,
                        source: PROMO_DETECTION_SOURCE.LocalProvider,
                        videoId,
                        promoBlocks: mergedBlocks,
                        partialCoverage: anyPartial,
                    } satisfies TopSkipRuntimeMessage);
                } catch {
                    // tab closed
                }
                if (!PromoAnalysis.isCurrentRun(tabId, abort)) {
                    return;
                }

                await setStatus({
                    videoId,
                    status: PROMO_DETECTION_STATUS.Detected,
                    promoBlocks: mergedBlocks,
                    partialCoverage: anyPartial,
                });
            };

            for (let i = 0; i < plan.chunks.length; i++) {
                const chunk = plan.chunks[i];
                if (chunk === undefined) {
                    continue;
                }
                if (!PromoAnalysis.isCurrentRun(tabId, abort)) {
                    return;
                }

                const t0 = performance.now();
                const first = await adapter.analyzeTranscript({
                    ...baseParams,
                    transcript: chunk.text,
                });
                if (!PromoAnalysis.isCurrentRun(tabId, abort)) {
                    return;
                }
                const firstLatency = performance.now() - t0;
                totalAdapterCalls = totalAdapterCalls + 1;
                totalAdapterLatencyMs = totalAdapterLatencyMs + firstLatency;

                recordChunk({
                    result: first,
                    aborted: !PromoAnalysis.isCurrentRun(tabId, abort),
                    chunkIndex: i,
                    startSec: chunk.startSec,
                    endSec: chunk.endSec,
                    chars: chunk.text.length,
                    latencyMs: firstLatency,
                });

                if (__TOPSKIP_INCLUDE_DEV_LOCAL__) {
                    if (first.ok) {
                        lastRawAssistant = first.rawAssistant;
                    } else if (first.rawAssistant !== undefined) {
                        lastRawAssistant = first.rawAssistant;
                    }

                    let parsedCount: number | undefined;
                    if (first.ok && first.hasPromo) {
                        parsedCount = first.blocks.length;
                    } else if (first.ok && !first.hasPromo) {
                        parsedCount = 0;
                    }
                    logChunkPromoEntry({
                        chunkIndex: i,
                        chunkCount,
                        chunkStartSec: chunk.startSec,
                        chunkEndSec: chunk.endSec,
                        chunkChars: chunk.text.length,
                        promptVersion: PROMO_DETECTION_PROMPT_VERSION,
                        chunkText: chunk.text,
                        chunkTextMaxChars: LOG_CHUNK_TEXT_MAX_CHARS,
                        rawAssistant: first.ok
                            ? first.rawAssistant
                            : (first.rawAssistant ?? null),
                        rawAssistantMaxChars: LOG_RAW_ASSISTANT_MAX_CHARS,
                        adapterLatencyMs: firstLatency,
                        outcome: PromoAnalysis.chunkOutcomeForLog(
                            first,
                            abort.signal.aborted,
                        ),
                        parsedBlockCount: parsedCount,
                        retryLabel: undefined,
                    });
                }

                if (await stopForMissingProviderHostAccess(first)) {
                    return;
                }
                if (!PromoAnalysis.isCurrentRun(tabId, abort)) {
                    return;
                }

                if (!first.ok && first.tooLarge === true) {
                    const halves = PromoAnalysis.splitTranscriptLinesInHalf(
                        chunk.text,
                    );
                    if (halves === null) {
                        chunkFailures = chunkFailures + 1;
                        anyPartial = true;
                        uncoveredRanges.push({
                            startSec: chunk.startSec,
                            endSec: chunk.endSec,
                            kind: 'irreducible_line',
                        });
                        DevConsole.warn([
                            '[TopSkip] irreducible_chunk: single line exceeds budget',
                            { chunkIndex: i },
                        ]);
                        continue;
                    }
                    const [aText, bText] = halves;
                    await processSlice(aText, i, chunkCount, 'retry-split-a');
                    if (!PromoAnalysis.isCurrentRun(tabId, abort)) {
                        return;
                    }
                    if (providerHostAccessRequired) {
                        return;
                    }
                    await processSlice(bText, i, chunkCount, 'retry-split-b');
                    if (!PromoAnalysis.isCurrentRun(tabId, abort)) {
                        return;
                    }
                    if (providerHostAccessRequired) {
                        return;
                    }
                    continue;
                }

                if (!first.ok) {
                    chunkFailures = chunkFailures + 1;
                    uncoveredRanges.push({
                        startSec: chunk.startSec,
                        endSec: chunk.endSec,
                        kind: 'failed_chunk',
                    });
                    continue;
                }

                if (!first.hasPromo) {
                    continue;
                }

                const filtered = ChunkMerge.filterPromoBlocksForChunkTimeRange(
                    first.blocks,
                    chunk.startSec,
                    chunk.endSec,
                    CHUNK_BLOCK_TOLERANCE_SEC,
                );
                mergedBlocks = mergePromoBlocksWithGap(
                    [...mergedBlocks, ...filtered],
                    BLOCK_MERGE_GAP_SEC,
                );

                try {
                    await browser.tabs.sendMessage(tabId, {
                        type: TOPSKIP_MESSAGE.PROMO_BLOCKS_DETECTED,
                        source: PROMO_DETECTION_SOURCE.LocalProvider,
                        videoId,
                        promoBlocks: mergedBlocks,
                        partialCoverage: anyPartial,
                    } satisfies TopSkipRuntimeMessage);
                } catch {
                    // tab closed
                }
                if (!PromoAnalysis.isCurrentRun(tabId, abort)) {
                    return;
                }

                await setStatus({
                    videoId,
                    status: PROMO_DETECTION_STATUS.Detected,
                    promoBlocks: mergedBlocks,
                    partialCoverage: anyPartial,
                });
            }

            if (!PromoAnalysis.isCurrentRun(tabId, abort)) {
                return;
            }

            const totalWallClockMs = performance.now() - runStartedAt;

            const outcomeBlocks =
                mergedBlocks.length > 0
                    ? { type: 'promo_blocks' as const, blocks: mergedBlocks }
                    : chunkFailures >= plan.chunks.length &&
                        plan.chunks.length > 0
                        ? {
                                type: 'adapter_error' as const,
                                error: 'All transcript chunks failed',
                            }
                        : { type: 'no_promo' as const };

            if (chunkFailures >= plan.chunks.length && plan.chunks.length > 0) {
                await setStatus({
                    videoId,
                    status: PROMO_DETECTION_STATUS.Error,
                    error: 'All transcript chunks failed',
                    partialCoverage: anyPartial,
                });
                if (!PromoAnalysis.isCurrentRun(tabId, abort)) {
                    return;
                }
                if (__TOPSKIP_INCLUDE_DEV_LOCAL__) {
                    LogPromoAnalysis.logAnalysisBundle(
                        buildPromoAnalysisLogBundle({
                            videoId,
                            languageCode,
                            segmentCount: segments.length,
                            maxTranscriptChars: MAX_CAPTION_TRANSCRIPT_CHARS,
                            mergedText: merged.text,
                            mergedTruncated: merged.truncated,
                            providerId,
                            model: 'unknown',
                            rawAssistant: lastRawAssistant,
                            outcome: outcomeBlocks,
                            chunkedMeta: {
                                promptVersion: PROMO_DETECTION_PROMPT_VERSION,
                                systemPromptFull: PROMO_DETECTION_SYSTEM_PROMPT,
                                plannedBudgetChars: budget,
                                overlapSec: plan.overlapSec,
                                totalChunks: plan.chunks.length,
                                totalAdapterCalls,
                                coverageFraction: plan.coverageFraction,
                                partialCoverage: anyPartial,
                                uncoveredRanges:
                                    uncoveredRanges.length > 0
                                        ? uncoveredRanges
                                        : undefined,
                                totalAdapterLatencyMs,
                                totalWallClockMs,
                                globalTruncated: merged.truncated,
                                mergedTextLogMaxChars:
                                    LOG_MERGED_TEXT_MAX_CHARS,
                            },
                        }),
                    );
                }
                PromoAnalysis.recordByokRunEnded({
                    tabId,
                    videoId,
                    provider: providerId,
                    model: runModel,
                    chunks: plan.chunks.length,
                    parsedBlocks: 0,
                    coverage: plan.coverageFraction,
                    uncovered: uncoveredRanges.length,
                    blocks: [],
                    totalLatencyMs: totalAdapterLatencyMs,
                    outcome: BYOK_OUTCOME.AdapterError,
                });
                return;
            }

            if (mergedBlocks.length === 0) {
                PromoAnalysis.recordByokRunEnded({
                    tabId,
                    videoId,
                    provider: providerId,
                    model: runModel,
                    chunks: plan.chunks.length,
                    parsedBlocks: 0,
                    coverage: plan.coverageFraction,
                    uncovered: uncoveredRanges.length,
                    blocks: [],
                    totalLatencyMs: totalAdapterLatencyMs,
                    outcome: BYOK_OUTCOME.Success,
                });
                if (__TOPSKIP_INCLUDE_DEV_LOCAL__) {
                    LogPromoAnalysis.logAnalysisBundle(
                        buildPromoAnalysisLogBundle({
                            videoId,
                            languageCode,
                            segmentCount: segments.length,
                            maxTranscriptChars: MAX_CAPTION_TRANSCRIPT_CHARS,
                            mergedText: merged.text,
                            mergedTruncated: merged.truncated,
                            providerId,
                            model:
                                providerId === PROVIDER_ID.OpenRouter
                                    ? '(see per-chunk logs)'
                                    : 'gemini-nano',
                            rawAssistant: lastRawAssistant,
                            outcome:
                                outcomeBlocks.type === 'no_promo'
                                    ? { type: 'no_promo' }
                                    : outcomeBlocks,
                            chunkedMeta: {
                                promptVersion: PROMO_DETECTION_PROMPT_VERSION,
                                systemPromptFull: PROMO_DETECTION_SYSTEM_PROMPT,
                                plannedBudgetChars: budget,
                                overlapSec: plan.overlapSec,
                                totalChunks: plan.chunks.length,
                                totalAdapterCalls,
                                coverageFraction: plan.coverageFraction,
                                partialCoverage: anyPartial,
                                uncoveredRanges:
                                    uncoveredRanges.length > 0
                                        ? uncoveredRanges
                                        : undefined,
                                totalAdapterLatencyMs,
                                totalWallClockMs,
                                globalTruncated: merged.truncated,
                                mergedTextLogMaxChars:
                                    LOG_MERGED_TEXT_MAX_CHARS,
                            },
                        }),
                    );
                }
                await setStatus({
                    videoId,
                    status: PROMO_DETECTION_STATUS.NoPromo,
                    partialCoverage: anyPartial,
                });
                return;
            }

            if (__TOPSKIP_INCLUDE_DEV_LOCAL__) {
                LogPromoAnalysis.logAnalysisBundle(
                    buildPromoAnalysisLogBundle({
                        videoId,
                        languageCode,
                        segmentCount: segments.length,
                        maxTranscriptChars: MAX_CAPTION_TRANSCRIPT_CHARS,
                        mergedText: merged.text,
                        mergedTruncated: merged.truncated,
                        providerId,
                        model:
                            providerId === PROVIDER_ID.OpenRouter
                                ? '(see per-chunk logs)'
                                : 'gemini-nano',
                        rawAssistant: lastRawAssistant,
                        outcome: { type: 'promo_blocks', blocks: mergedBlocks },
                        chunkedMeta: {
                            promptVersion: PROMO_DETECTION_PROMPT_VERSION,
                            systemPromptFull: PROMO_DETECTION_SYSTEM_PROMPT,
                            plannedBudgetChars: budget,
                            overlapSec: plan.overlapSec,
                            totalChunks: plan.chunks.length,
                            totalAdapterCalls,
                            coverageFraction: plan.coverageFraction,
                            partialCoverage: anyPartial,
                            uncoveredRanges:
                                uncoveredRanges.length > 0
                                    ? uncoveredRanges
                                    : undefined,
                            totalAdapterLatencyMs,
                            totalWallClockMs,
                            globalTruncated: merged.truncated,
                            mergedTextLogMaxChars: LOG_MERGED_TEXT_MAX_CHARS,
                        },
                    }),
                );
            }
            PromoAnalysis.recordByokRunEnded({
                tabId,
                videoId,
                provider: providerId,
                model: runModel,
                chunks: plan.chunks.length,
                parsedBlocks: mergedBlocks.length,
                coverage: plan.coverageFraction,
                uncovered: uncoveredRanges.length,
                blocks: mergedBlocks,
                totalLatencyMs: totalAdapterLatencyMs,
                outcome: BYOK_OUTCOME.Success,
            });
            await setStatus({
                videoId,
                status: PROMO_DETECTION_STATUS.Detected,
                promoBlocks: mergedBlocks,
                partialCoverage: anyPartial,
            });
        } catch (e) {
            if (
                !PromoAnalysis.isCurrentRun(tabId, abort) ||
                (e instanceof DOMException && e.name === 'AbortError')
            ) {
                return;
            }
            const msg = e instanceof Error ? e.message : String(e);
            if (__TOPSKIP_INCLUDE_DEV_LOCAL__) {
                console.error('[TopSkip] Promo analysis failed', msg);
            } else {
                console.error(
                    '[TopSkip] Promo analysis failed',
                    PROMO_ANALYSIS_FAILED_CODE,
                );
            }
            DebugLog.record(
                DEBUG_LOG_EVENT.ByokRunEnded,
                {
                    provider: runProvider,
                    model: runModel,
                    outcome: BYOK_OUTCOME.AdapterError,
                },
                { tab: tabId, video: videoId },
            );
            await setStatus({
                videoId,
                status: PROMO_DETECTION_STATUS.Error,
                error: msg,
            });
        } finally {
            const cur = PromoAnalysis.inflight.get(tabId);
            if (cur?.abort === abort) {
                PromoAnalysis.inflight.delete(tabId);
            }
        }
    }
}
