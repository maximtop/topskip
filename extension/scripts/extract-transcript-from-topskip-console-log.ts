#!/usr/bin/env node
/**
 * Rebuilds the LLM-style merged transcript from a Chrome-exported service
 * worker log where {@link logTranscriptForDeveloper} printed caption chunks as
 * `N: {start: …, dur: …, text: '…'}` (expanded objects).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

type Segment = { startSec: number; text: string };

/**
 * @param raw - Substring inside single-quoted `text: '…'`
 * @returns Unescaped caption text
 */
function unescapeJsSingleQuotedText(raw: string): string {
  return raw.replace(/\\(['\\])/g, (_m, ch: string) =>
    ch === '\\' ? '\\' : "'",
  );
}

/**
 * @param raw - Substring inside double-quoted `text: "…"`
 * @returns Unescaped caption text
 */
function unescapeJsDoubleQuotedText(raw: string): string {
  return raw.replace(/\\(["\\])/g, (_m, ch: string) =>
    ch === '\\' ? '\\' : '"',
  );
}

/**
 * @param s - Caption fragment as logged in DevTools
 * @returns Plain text for the merged transcript
 */
function decodeHtmlEntities(s: string): string {
  return s
    .replaceAll('&gt;', '>')
    .replaceAll('&lt;', '<')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');
}

const RE_SINGLE = new RegExp(
  String.raw`\d+: \{start: ([0-9.]+), dur: [0-9.]+, text: '((?:\\'|[^'])*)'\}`,
  'g',
);
const RE_DOUBLE = new RegExp(
  String.raw`\d+: \{start: ([0-9.]+), dur: [0-9.]+, text: "((?:\\"|[^"])*)"\}`,
  'g',
);
const RE_MANGLED = new RegExp(
  String.raw`dur: ([0-9.]+)start: ([0-9.]+)text: "((?:\\"|[^"])*)"`,
  'g',
);

/**
 * @param logText - Full `.log` file contents
 * @returns Parsed caption segments (may be unsorted; caller sorts)
 */
export function parseCaptionSegmentsFromTopSkipConsoleLog(
  logText: string,
): Segment[] {
  const out: Segment[] = [];
  for (const re of [RE_SINGLE, RE_DOUBLE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null = re.exec(logText);
    while (m !== null) {
      const startSec = Number(m[1]);
      const rawText = m[2] ?? '';
      const body =
        re === RE_SINGLE
          ? unescapeJsSingleQuotedText(rawText)
          : unescapeJsDoubleQuotedText(rawText);
      if (Number.isFinite(startSec)) {
        out.push({ startSec, text: decodeHtmlEntities(body) });
      }
      m = re.exec(logText);
    }
  }
  RE_MANGLED.lastIndex = 0;
  let mm: RegExpExecArray | null = RE_MANGLED.exec(logText);
  while (mm !== null) {
    const startSec = Number(mm[2]);
    const rawText = mm[3] ?? '';
    const body = unescapeJsDoubleQuotedText(rawText);
    if (Number.isFinite(startSec)) {
      out.push({ startSec, text: decodeHtmlEntities(body) });
    }
    mm = RE_MANGLED.exec(logText);
  }
  return out;
}

/**
 * @param segments - Parsed segments
 * @param videoId - YouTube id for the user message header
 * @param languageCode - BCP-like language code
 * @returns Full user message body (videoId/language headers plus `[sec]`
 *   lines, same shape as production merge + headers)
 */
export function buildUserMessageFromSegments(
  segments: readonly Segment[],
  videoId: string,
  languageCode: string,
): string {
  const sorted = [...segments].sort((a, b) => a.startSec - b.startSec);
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const s of sorted) {
    const key = `${String(s.startSec)}\t${s.text}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    lines.push(`[${String(s.startSec)}] ${s.text.trim()}`);
  }
  const head = [`videoId=${videoId}`, `language=${languageCode}`, ''].join(
    '\n',
  );
  return `${head}\n${lines.join('\n')}`;
}

type ExtractCliOpts = { out?: string; videoId: string; language: string };

/**
 * @param argv - Typically `process.argv.slice(2)`
 * @returns Arguments for Commander after stripping wrapper-injected `--`
 */
function normalizeForwardedCliArgs(argv: readonly string[]): string[] {
  let i = 0;
  while (i < argv.length && argv[i] === '--') {
    i += 1;
  }
  return argv.slice(i);
}

/**
 * @param logPath - Exported DevTools `.log` path
 * @param opts - Output path and synthetic message headers
 * @returns void
 */
function extractCliAction(logPath: string, opts: ExtractCliOpts): void {
  const logText = readFileSync(logPath, 'utf8');
  const segments = parseCaptionSegmentsFromTopSkipConsoleLog(logText);
  if (segments.length === 0) {
    console.error(
      'No caption segments found. Export must include expanded ' +
        '`N: {start:, text:}` lines (not only [{…}] collapsed).',
    );
    process.exit(1);
  }
  const body = buildUserMessageFromSegments(
    segments,
    opts.videoId,
    opts.language,
  );
  if (opts.out) {
    writeFileSync(opts.out, body, 'utf8');
    const n = String(segments.length);
    console.error(`Wrote ${n} segments → ${opts.out}`);
  } else {
    process.stdout.write(body);
  }
}

/**
 * @returns Promise that settles when the CLI finishes
 */
async function runCli(): Promise<void> {
  const program = new Command();
  program
    .name('extract-transcript-from-topskip-console-log')
    .description(
      'Extract merged [sec] lines from TopSkip caption chunk console export.',
    )
    .argument('<log-file>', 'Path to exported .log')
    .option('-o, --out <path>', 'Write user message UTF-8 (default: stdout)')
    .option('--video-id <id>', 'videoId= line', 'unknown')
    .option('--language <code>', 'language= line', 'und')
    .action(extractCliAction);
  await program.parseAsync(normalizeForwardedCliArgs(process.argv.slice(2)), {
    from: 'user',
  });
}

const entryPath = path.resolve(process.argv[1] ?? '');
const thisFile = fileURLToPath(import.meta.url);
if (entryPath === thisFile) {
  void runCli();
}
