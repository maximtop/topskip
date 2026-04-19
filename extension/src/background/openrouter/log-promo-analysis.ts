import type { PromoBlock } from '@/shared/promo-types';

const BUNDLE_TITLE =
  '========== TopSkip promo analysis log bundle ==========';
const MAX_RAW_ASSISTANT_IN_BUNDLE = 20_000;

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
    parts.push(`>>> PROMO ${String(n)} START at ${String(b.startSec)}s <<<`);
    parts.push(excerptTimedLinesAroundSec(timed, b.startSec, 4, 6));
    parts.push('');
    if (b.endSec !== undefined) {
      parts.push(`>>> PROMO ${String(n)} END at ${String(b.endSec)}s <<<`);
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
}): string {
  const used = params.mergedText.length;
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
    '',
    ...formatOutcomeLines(params.outcome),
    '',
    '--- Merged transcript (timed lines shown to the model) ---',
    params.mergedText.length > 0 ? params.mergedText : '(empty)',
  ];

  if (
    params.outcome.type === 'promo_blocks' &&
    params.outcome.blocks.length > 0
  ) {
    const { blocks } = params.outcome;
    lines.push('');
    lines.push(formatBlockMarkersSection(params.mergedText, blocks));
  }

  lines.push('');
  lines.push('--- Raw assistant message ---');
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
  private constructor() {}

  /**
   * Emits a single multiline plain-text analysis bundle to the service worker
   * console (FR-002, FR-003, FR-007).
   *
   * @param bundle - Output of {@link buildPromoAnalysisLogBundle}
   */
  static logAnalysisBundle(bundle: string): void {
    console.info(bundle);
  }
}
