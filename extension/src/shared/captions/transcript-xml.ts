import type { CaptionSegment } from '@/shared/caption-types';

const TEXT_BLOCK = /<text\s+([^>]*)>([\s\S]*?)<\/text>/gi;

/**
 * YouTube `timedtext format="3"` uses `<p t="ms" d="ms">` instead of `<text>`.
 */
const P_BLOCK = /<p\s+([^>]*)>([\s\S]*?)<\/p>/gi;

/**
 * Strips simple HTML tags from caption cue text (YouTube may embed `<i>` etc.).
 *
 * @param raw Raw inner XML/HTML string.
 * @returns Plain text for analysis/logging.
 */
function stripCueHtml(raw: string): string {
  return raw.replace(/<[^>]*>/g, '').trim();
}

/**
 * Parses `start` / `dur` attributes from a `<text ...>` opening fragment.
 *
 * @param attrFragment Attribute string after `<text `.
 * @returns Parsed numbers or null if `start` is missing/invalid.
 */
function parseTextAttributes(attrFragment: string): {
  startSec: number;
  durationSec: number;
} | null {
  const startM = /start="([\d.]+)"/.exec(attrFragment);
  if (!startM) {
    return null;
  }
  const startSec = Number.parseFloat(startM[1]);
  if (!Number.isFinite(startSec) || startSec < 0) {
    return null;
  }
  const durM = /dur="([\d.]+)"/.exec(attrFragment);
  const durationSec = durM
    ? Number.parseFloat(durM[1])
    : 0;
  const dur =
    Number.isFinite(durationSec) && durationSec >= 0 ? durationSec : 0;
  return { startSec, durationSec: dur };
}

/**
 * Parses `t` / `d` attributes from a `<p ...>` opening fragment (milliseconds).
 *
 * @param attrFragment Attribute string after `<p `.
 * @returns Parsed times in seconds or `null` if `t` is missing/invalid.
 */
function parsePAttributes(attrFragment: string): {
  startSec: number;
  durationSec: number;
} | null {
  const tM = /\bt="(\d+)"/.exec(attrFragment);
  if (!tM) {
    return null;
  }
  const startMs = Number.parseInt(tM[1], 10);
  if (!Number.isFinite(startMs) || startMs < 0) {
    return null;
  }
  const dM = /\bd="(\d+)"/.exec(attrFragment);
  const durationMs = dM ? Number.parseInt(dM[1], 10) : 0;
  const dur =
    Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
  return {
    startSec: startMs / 1000,
    durationSec: dur / 1000,
  };
}

/**
 * Parses YouTube timedtext XML into structured caption segments.
 * Uses regex (no `DOMParser`) so unit tests run in Node without jsdom.
 *
 * @param xml Response body from a caption `baseUrl` (srv3 / legacy `<text>` or
 *   `format="3"` `<p t="ms" d="ms">`).
 * @returns Segments or a human-readable parse error.
 */
export function parseTranscriptXml(xml: string): {
  ok: true;
  segments: CaptionSegment[];
} | {
  ok: false;
  error: string;
} {
  const trimmed = xml.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'Empty transcript response' };
  }

  const segments: CaptionSegment[] = [];
  let m: RegExpExecArray | null;
  TEXT_BLOCK.lastIndex = 0;
  while ((m = TEXT_BLOCK.exec(xml)) !== null) {
    const attrs = m[1] ?? '';
    const inner = m[2] ?? '';
    const parsed = parseTextAttributes(attrs);
    if (!parsed) {
      continue;
    }
    segments.push({
      startSec: parsed.startSec,
      durationSec: parsed.durationSec,
      text: stripCueHtml(inner),
    });
  }

  if (segments.length === 0) {
    P_BLOCK.lastIndex = 0;
    while ((m = P_BLOCK.exec(xml)) !== null) {
      const attrs = m[1] ?? '';
      const inner = m[2] ?? '';
      const parsed = parsePAttributes(attrs);
      if (!parsed) {
        continue;
      }
      const text = stripCueHtml(inner);
      if (text.length === 0) {
        continue;
      }
      segments.push({
        startSec: parsed.startSec,
        durationSec: parsed.durationSec,
        text,
      });
    }
  }

  if (segments.length === 0) {
    return {
      ok: false,
      error: 'No caption cues found in transcript XML',
    };
  }

  return { ok: true, segments };
}
