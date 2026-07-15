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
import { PromoDetectionStore } from '@/background/promo-detection-store';
import { mergeCaptionSegmentsToTranscript } from '@/shared/captions/merge-transcript';
import {
    ANALYSIS_MODE,
    MAX_CAPTION_TRANSCRIPT_CHARS,
} from '@/shared/constants';
import browser from '@/shared/browser';
import {
    TOPSKIP_MESSAGE,
    type CaptionsFromContentPayload,
    type PromoDetectionStatePayload,
} from '@/shared/messages';
import { PROVIDER_ID } from '@/shared/providers';
import { PROVIDER_AVAILABILITY } from '@/shared/chrome-prompt-api';
import { defaultRegistry } from '@/background/providers/default-registry';
import type { ProviderRegistry } from '@/background/providers/provider-registry';
import type { AnalyzeTranscriptResult } from '@/background/providers/llm-provider-adapter';
import {
    BLOCK_MERGE_GAP_SEC,
    CHUNK_BLOCK_TOLERANCE_SEC,
    LOG_CHUNK_TEXT_MAX_CHARS,
    LOG_MERGED_TEXT_MAX_CHARS,
    LOG_RAW_ASSISTANT_MAX_CHARS,
} from '@/background/messaging/chunk-plan-config';
import { ChunkPlanner } from '@/background/messaging/chunk-planner';
import { ChunkMerge } from '@/background/messaging/chunk-merge';
import { mergePromoBlocksWithGap } from '@topskip/common/promo-dedupe';
import {
    PROMO_DETECTION_PROMPT_VERSION,
    PROMO_DETECTION_SYSTEM_PROMPT,
} from '@/background/openrouter/promo-detection-system-prompt';
import type { PromoBlock } from '@topskip/common/promo-types';

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

        const setStatus = (state: PromoDetectionStatePayload): void => {
            PromoDetectionStore.set(tabId, {
                ...state,
                source: 'local_provider',
            });
        };

        try {
            const prefs = await PrefsSyncStorage.ready().then(() =>
                PrefsSyncStorage.load(),
            );
            if (!prefs.enabled || prefs.analysisMode !== ANALYSIS_MODE.Byok) {
                return;
            }

            const providerId = prefs.providerId;
            PromoAnalysis.inflight.set(tabId, {
                videoId,
                abort,
                providerId,
            });

            const adapter = PromoAnalysis.registry.get(providerId);
            if (!adapter) {
                setStatus({ videoId, status: 'not_configured' });
                return;
            }

            const avail = await adapter.availability();
            if (avail === PROVIDER_AVAILABILITY.UNAVAILABLE) {
                setStatus({ videoId, status: 'not_configured' });
                return;
            }

            const merged = mergeCaptionSegmentsToTranscript(
                segments,
                MAX_CAPTION_TRANSCRIPT_CHARS,
            );
            if (segments.length === 0 || merged.text.trim().length === 0) {
                setStatus({ videoId, status: 'no_promo' });
                return;
            }

            setStatus({ videoId, status: 'analyzing' });

            const budget = await adapter.maxTranscriptChars();
            if (budget <= 0) {
                setStatus({
                    videoId,
                    status: 'not_configured',
                    error: 'LLM provider has no transcript budget',
                });
                return;
            }

            const plan = ChunkPlanner.buildChunkPlan(merged.text, budget);
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

            const processSlice = async (
                chunkText: string,
                chunkIndex: number,
                chunkCountInner: number,
                retryLabel: string | undefined,
            ): Promise<void> => {
                if (PromoAnalysis.inflight.get(tabId)?.abort !== abort) {
                    return;
                }
                const { startSec: cStart, endSec: cEnd } =
                    PromoAnalysis.timeRangeFromChunkText(chunkText);
                const t0 = performance.now();
                const result = await adapter.analyzeTranscript({
                    ...baseParams,
                    transcript: chunkText,
                });
                const latencyMs = performance.now() - t0;
                totalAdapterCalls = totalAdapterCalls + 1;
                totalAdapterLatencyMs = totalAdapterLatencyMs + latencyMs;

                const aborted = abort.signal.aborted;
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
                        videoId,
                        promoBlocks: mergedBlocks,
                        partialCoverage: anyPartial,
                    });
                } catch {
                    // tab closed
                }

                setStatus({
                    videoId,
                    status: 'detected',
                    promoBlocks: mergedBlocks,
                    partialCoverage: anyPartial,
                });
            };

            for (let i = 0; i < plan.chunks.length; i++) {
                const chunk = plan.chunks[i];
                if (chunk === undefined) {
                    continue;
                }
                if (PromoAnalysis.inflight.get(tabId)?.abort !== abort) {
                    return;
                }

                if (abort.signal.aborted) {
                    return;
                }

                const t0 = performance.now();
                const first = await adapter.analyzeTranscript({
                    ...baseParams,
                    transcript: chunk.text,
                });
                const firstLatency = performance.now() - t0;
                totalAdapterCalls = totalAdapterCalls + 1;
                totalAdapterLatencyMs = totalAdapterLatencyMs + firstLatency;

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

                if (abort.signal.aborted) {
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
                        console.warn(
                            '[TopSkip] irreducible_chunk: single line exceeds budget',
                            { chunkIndex: i },
                        );
                        continue;
                    }
                    const [aText, bText] = halves;
                    await processSlice(aText, i, chunkCount, 'retry-split-a');
                    if (PromoAnalysis.inflight.get(tabId)?.abort !== abort) {
                        return;
                    }
                    await processSlice(bText, i, chunkCount, 'retry-split-b');
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
                        videoId,
                        promoBlocks: mergedBlocks,
                        partialCoverage: anyPartial,
                    });
                } catch {
                    // tab closed
                }

                setStatus({
                    videoId,
                    status: 'detected',
                    promoBlocks: mergedBlocks,
                    partialCoverage: anyPartial,
                });
            }

            if (PromoAnalysis.inflight.get(tabId)?.abort !== abort) {
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
                setStatus({
                    videoId,
                    status: 'error',
                    error: 'All transcript chunks failed',
                    partialCoverage: anyPartial,
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
                return;
            }

            if (mergedBlocks.length === 0) {
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
                setStatus({
                    videoId,
                    status: 'no_promo',
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
            setStatus({
                videoId,
                status: 'detected',
                promoBlocks: mergedBlocks,
                partialCoverage: anyPartial,
            });
        } catch (e) {
            if (e instanceof DOMException && e.name === 'AbortError') {
                return;
            }
            const msg = e instanceof Error ? e.message : String(e);
            console.error('[TopSkip] Promo analysis failed', msg);
            setStatus({
                videoId,
                status: 'error',
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
