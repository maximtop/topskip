import type { PromoBlock } from '@topskip/common/promo-types';

const BUNDLE_TITLE = '========== TopSkip promo analysis log bundle ==========';
const MAX_RAW_ASSISTANT_IN_BUNDLE = 20_000;

/**
 * Outcome label for per-chunk LLM logs (spec FR-009).
 */
export type ChunkLogOutcome =
    | 'success'
    | 'too_large'
    | 'parse_error'
    | 'adapter_error'
    | 'aborted'
    | 'other_error';

/**
 * Timeline slice omitted from a complete analysis (spec FR-009 aggregate).
 */
export type PromoUncoveredRange = {
    startSec: number;
    endSec: number;
    kind: 'dropped_tail' | 'failed_chunk' | 'irreducible_line';
};

/**
 * Final outcome variants represented in the promo analysis debug bundle.
 */
export type PromoAnalysisBundleOutcome =
    | { type: 'openrouter_error'; error: string }
    | { type: 'parse_error'; error: string }
    | { type: 'adapter_error'; error: string }
    | { type: 'no_promo' }
    | { type: 'promo_blocks'; blocks: PromoBlock[] };

/**
 * Parses timed lines from the merged transcript body (`[sec] text` per line).
 *
 * @param mergedText - Merged caption lines only (no videoId header)
 * @returns Rows with parsed seconds and full original line text
 */
export function listTimedLinesFromMergedTranscript(
    mergedText: string,
): { sec: number; line: string }[] {
    const rows: { sec: number; line: string }[] = [];
    for (const raw of mergedText.split('\n')) {
        const line = raw.trimEnd();
        const m = /^\[(\d+(?:\.\d+)?)\]\s*(.*)$/.exec(line);
        if (!m) {
            continue;
        }
        const sec = Number(m[1]);
        if (!Number.isFinite(sec)) {
            continue;
        }
        rows.push({ sec, line });
    }
    return rows;
}

/**
 * Returns a small excerpt of timed lines around the cue second for human
 * review.
 *
 * @param timedLines - Parsed `[sec]` lines from
 *   {@link listTimedLinesFromMergedTranscript}
 * @param targetSec - Second on the video timeline
 * @param linesBefore - Lines to include before the anchor line
 * @param linesAfter - Lines to include after the anchor line
 * @returns Plain text (newline-separated `[sec] text` lines)
 */
export function excerptTimedLinesAroundSec(
    timedLines: ReadonlyArray<{ sec: number; line: string }>,
    targetSec: number,
    linesBefore: number,
    linesAfter: number,
): string {
    if (timedLines.length === 0) {
        return '(no [seconds] lines found in merged transcript)\n';
    }
    let anchor = 0;
    for (let i = 0; i < timedLines.length; i++) {
        if (timedLines[i].sec <= targetSec) {
            anchor = i;
        } else {
            break;
        }
    }
    const start = Math.max(0, anchor - linesBefore);
    const end = Math.min(timedLines.length - 1, anchor + linesAfter);
    return timedLines
        .slice(start, end + 1)
        .map((r) => r.line)
        .join('\n');
}

/**
 * Builds the human-readable promo marker section inside a log bundle.
 *
 * @param mergedText - Merged transcript body
 * @param blocks - Validated promo blocks
 * @returns Plain-text section with START/END markers and excerpts
 */
function formatBlockMarkersSection(
    mergedText: string,
    blocks: readonly PromoBlock[],
): string {
    const timed = listTimedLinesFromMergedTranscript(mergedText);
    const parts: string[] = [
        '--- Promo markers (same [sec] layout as merged text) ---',
    ];
    blocks.forEach((b, i) => {
        const n = i + 1;
        parts.push('');
        parts.push(
            `>>> PROMO ${String(n)} START at ${String(b.startSec)}s <<<`,
        );
        parts.push(excerptTimedLinesAroundSec(timed, b.startSec, 4, 6));
        parts.push('');
        if (b.endSec !== undefined) {
            parts.push(
                `>>> PROMO ${String(n)} END at ${String(b.endSec)}s <<<`,
            );
            parts.push(excerptTimedLinesAroundSec(timed, b.endSec, 4, 6));
        } else {
            const endOmitted =
                `>>> PROMO ${String(n)} END ` +
                '(model omitted endSec; context near start) <<<';
            parts.push(endOmitted);
            parts.push(excerptTimedLinesAroundSec(timed, b.startSec, 2, 8));
        }
        const conf =
            b.confidence !== undefined ? ` confidence=${b.confidence}` : '';
        parts.push('');
        const endPart =
            b.endSec !== undefined
                ? String(b.endSec)
                : '(default / model omitted)';
        parts.push(
            `Block ${String(n)} summary: startSec=${String(b.startSec)} ` +
                `endSec=${endPart}${conf}`,
        );
    });
    return parts.join('\n');
}

/**
 * Renders bundle header outcome lines for developer log text.
 *
 * @param outcome - Parsed / HTTP outcome for the bundle header
 * @returns Lines inserted under metadata in the log bundle
 */
function formatOutcomeLines(outcome: PromoAnalysisBundleOutcome): string[] {
    switch (outcome.type) {
        case 'openrouter_error':
            return [
                'outcome: OpenRouter request failed',
                `error: ${outcome.error}`,
            ];
        case 'parse_error':
            return [
                'outcome: assistant output failed validation',
                `error: ${outcome.error}`,
            ];
        case 'adapter_error':
            return [
                'outcome: adapter request failed',
                `error: ${outcome.error}`,
            ];
        case 'no_promo':
            return ['outcome: hasPromo false (no blocks)'];
        case 'promo_blocks':
            return [
                `outcome: hasPromo true (${String(outcome.blocks.length)} block(s))`,
                'parsed blocks (plain):',
                ...outcome.blocks.map((b, i) => {
                    const end = b.endSec !== undefined ? String(b.endSec) : '—';
                    const co = b.confidence ?? '—';
                    return (
                        `  block ${String(i + 1)}: startSec=${String(b.startSec)} ` +
                        `endSec=${end} confidence=${co}`
                    );
                }),
            ];
    }
}

/**
 * Caps raw assistant text length for bundle size with an explicit notice.
 *
 * @param raw - Full assistant message
 * @returns Possibly sliced text plus optional truncation notice line
 */
function truncateRawAssistant(raw: string): { text: string; note: string } {
    if (raw.length <= MAX_RAW_ASSISTANT_IN_BUNDLE) {
        return { text: raw, note: '' };
    }
    const lim = String(MAX_RAW_ASSISTANT_IN_BUNDLE);
    return {
        text: raw.slice(0, MAX_RAW_ASSISTANT_IN_BUNDLE),
        note: `\n(raw assistant truncated to ${lim} chars for log size)`,
    };
}

/**
 * Truncates long strings for console logging with an explicit notice.
 *
 * @param raw - Full text
 * @param maxChars - Maximum UTF-16 length to emit
 * @returns Possibly truncated text plus optional notice line
 */
export function truncateForLog(
    raw: string,
    maxChars: number,
): { text: string; note: string } {
    if (raw.length <= maxChars) {
        return { text: raw, note: '' };
    }
    const lim = String(maxChars);
    return {
        text: raw.slice(0, maxChars),
        note:
            `\n(truncated to ${lim} chars; ` +
            `original length ${String(raw.length)})`,
    };
}

/**
 * Emits one per-chunk or per-slice analysis record (spec FR-009).
 *
 * @param params - Chunk metadata, latency, optional payloads
 * @param enabled - Explicit override used by unit tests.
 */
export function logChunkPromoEntry(
    params: {
        chunkIndex: number;
        chunkCount: number;
        chunkStartSec: number;
        chunkEndSec: number;
        chunkChars: number;
        promptVersion: string;
        chunkText: string;
        chunkTextMaxChars: number;
        rawAssistant: string | null;
        rawAssistantMaxChars: number;
        adapterLatencyMs: number;
        outcome: ChunkLogOutcome;
        parsedBlockCount?: number;
        retryLabel?: string;
    },
    enabled = __TOPSKIP_INCLUDE_DEV_LOCAL__,
): void {
    if (!enabled) {
        return;
    }
    const chunkT = truncateForLog(params.chunkText, params.chunkTextMaxChars);
    const rawT =
        params.rawAssistant === null
            ? { text: '(not available)', note: '' }
            : truncateForLog(params.rawAssistant, params.rawAssistantMaxChars);
    const chunkHead =
        params.retryLabel !== undefined
            ? `chunk: ${String(params.chunkIndex + 1)}/` +
              `${String(params.chunkCount)} (${params.retryLabel})`
            : `chunk: ${String(params.chunkIndex + 1)}/` +
              `${String(params.chunkCount)}`;
    const lines: string[] = [
        '---------- TopSkip chunk analysis ----------',
        chunkHead,
        `timeRangeSec: ${String(params.chunkStartSec)}–` +
            `${String(params.chunkEndSec)}`,
        `chunkChars: ${String(params.chunkChars)}`,
        `promptVersion: ${params.promptVersion}`,
        `adapterLatencyMs: ${String(Math.round(params.adapterLatencyMs))}`,
        `outcome: ${params.outcome}`,
        `parsedBlocks: ${String(params.parsedBlockCount ?? '—')}`,
        '',
        '--- chunkText (user message) ---',
        chunkT.text + chunkT.note,
        '',
        '--- rawAssistant ---',
        rawT.text + rawT.note,
        '---------- end chunk ----------',
    ];
    console.info(lines.join('\n'));
}

/**
 * Builds one plain-text developer log artifact (FR-002, FR-003, FR-007).
 *
 * @param params - Metadata, merged body, model, optional raw assistant,
 *   and outcome
 * @returns Multiline string suitable for a single console copy/paste
 */
export function buildPromoAnalysisLogBundle(params: {
    videoId: string;
    languageCode: string;
    segmentCount: number;
    maxTranscriptChars: number;
    mergedText: string;
    mergedTruncated: boolean;
    providerId: string;
    model: string;
    rawAssistant: string | null;
    outcome: PromoAnalysisBundleOutcome;
    /**
     * When set, includes multi-chunk aggregate telemetry (spec FR-009).
     */
    chunkedMeta?: {
        promptVersion: string;
        systemPromptFull: string;
        plannedBudgetChars: number;
        overlapSec: number;
        totalChunks: number;
        totalAdapterCalls: number;
        coverageFraction: number;
        partialCoverage: boolean;
        /**
         * Failed adapter slices and transcript tail dropped by the chunk cap.
         */
        uncoveredRanges?: PromoUncoveredRange[];
        totalAdapterLatencyMs: number;
        totalWallClockMs: number;
        globalTruncated: boolean;
        mergedTextLogMaxChars: number;
    };
}): string {
    const used = params.mergedText.length;
    const meta = params.chunkedMeta;
    const mergedForLog =
        meta !== undefined
            ? truncateForLog(params.mergedText, meta.mergedTextLogMaxChars)
            : { text: params.mergedText, note: '' };
    const lines: string[] = [
        BUNDLE_TITLE,
        `videoId: ${params.videoId}`,
        `language: ${params.languageCode}`,
        `providerId: ${params.providerId}`,
        `captionSegmentCount: ${String(params.segmentCount)}`,
        `mergedTranscriptChars: ${String(used)} / ` +
            `${String(params.maxTranscriptChars)} (budget)`,
        `mergedTruncated: ${params.mergedTruncated ? 'yes' : 'no'}`,
        `model: ${params.model}`,
    ];
    if (meta !== undefined) {
        lines.push(
            `promptVersion: ${meta.promptVersion}`,
            `plannedBudgetChars: ${String(meta.plannedBudgetChars)}`,
            `overlapSec: ${String(Math.round(meta.overlapSec * 100) / 100)}`,
            `totalChunks: ${String(meta.totalChunks)}`,
            `totalAdapterCalls: ${String(meta.totalAdapterCalls)}`,
            `coverageFraction: ${String(
                Math.round(meta.coverageFraction * 1000) / 1000,
            )}`,
            `partialCoverage: ${meta.partialCoverage ? 'yes' : 'no'}`,
            `totalAdapterLatencyMs: ${String(
                Math.round(meta.totalAdapterLatencyMs),
            )}`,
            `totalWallClockMs: ${String(Math.round(meta.totalWallClockMs))}`,
            `globalTruncated: ${meta.globalTruncated ? 'yes' : 'no'}`,
        );
        const ranges = meta.uncoveredRanges;
        if (ranges !== undefined && ranges.length > 0) {
            lines.push('uncoveredRanges:');
            for (const r of ranges) {
                lines.push(
                    `  - ${r.kind} ${String(r.startSec)}s–${String(r.endSec)}s`,
                );
            }
        }
    }
    lines.push(
        '',
        ...formatOutcomeLines(params.outcome),
        '',
        '--- Merged transcript (timed lines shown to the model) ---',
        mergedForLog.text.length > 0 ? mergedForLog.text : '(empty)',
        mergedForLog.note,
    );
    if (meta !== undefined) {
        lines.push(
            '',
            '--- System prompt (full, for this promptVersion) ---',
            meta.systemPromptFull,
        );
    }

    if (
        params.outcome.type === 'promo_blocks' &&
        params.outcome.blocks.length > 0
    ) {
        const { blocks } = params.outcome;
        lines.push('');
        lines.push(formatBlockMarkersSection(params.mergedText, blocks));
    }

    lines.push('');
    lines.push('--- Raw assistant message (aggregate / last slice) ---');
    if (params.rawAssistant === null) {
        lines.push(
            '(not available — OpenRouter did not return assistant text)',
        );
    } else {
        const { text, note } = truncateRawAssistant(params.rawAssistant);
        lines.push(text + note);
    }

    lines.push(BUNDLE_TITLE);
    return lines.join('\n');
}

/**
 * Developer-facing logs for promo / OpenRouter analysis. Never logs API keys
 * or `Authorization` headers (FR-020).
 */
export class LogPromoAnalysis {
    /**
     * Emits a single multiline plain-text analysis bundle to the service worker
     * console (FR-002, FR-003, FR-007).
     *
     * @param bundle - Output of {@link buildPromoAnalysisLogBundle}
     * @param enabled - Explicit override used by unit tests.
     */
    static logAnalysisBundle(
        bundle: string,
        enabled = __TOPSKIP_INCLUDE_DEV_LOCAL__,
    ): void {
        if (!enabled) {
            return;
        }
        console.info(bundle);
    }
}
