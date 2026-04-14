import type { CaptionSegment } from '@/shared/caption-types';

import { isPlayerRecord } from '@/shared/captions/player-json';

/**
 * Collects every non-empty `params` string under a caption track object.
 * YouTube sometimes nests `params` instead of placing it on the track root.
 *
 * @param track Single caption track value.
 * @param depth Recursion guard.
 * @returns All candidate `params` strings.
 */
function collectParamsStringsDeep(
  track: unknown,
  depth = 0,
): string[] {
  if (depth > 28 || track === null || track === undefined) {
    return [];
  }
  if (Array.isArray(track)) {
    const out: string[] = [];
    for (const x of track) {
      out.push(...collectParamsStringsDeep(x, depth + 1));
    }
    return out;
  }
  if (!isPlayerRecord(track)) {
    return [];
  }
  const own = track['params'];
  const head =
    typeof own === 'string' && own.length > 0 ? [own] : ([] as string[]);
  const rest: string[] = [];
  for (const v of Object.values(track)) {
    rest.push(...collectParamsStringsDeep(v, depth + 1));
  }
  return [...head, ...rest];
}

/**
 * Some `captionTracks[]` entries include a `params` field for transcript RPCs.
 * Picks the **longest** candidate — transcript tokens are long base64; short
 * `params` may appear on unrelated nested endpoints.
 *
 * @param tracks Raw caption tracks array.
 * @returns Params string or `null`.
 */
export function findParamsOnCaptionTracks(tracks: unknown[]): string | null {
  let best: string | null = null;
  for (const t of tracks) {
    for (const p of collectParamsStringsDeep(t)) {
      if (!best || p.length > best.length) {
        best = p;
      }
    }
  }
  return best;
}

/**
 * Walks player JSON for Innertube `getTranscriptEndpoint.params` (used by
 * `youtubei/v1/get_transcript`).
 *
 * @param data Parsed player or subtree.
 * @returns Base64 `params`, or `null`.
 */
export function findGetTranscriptParams(data: unknown): string | null {
  if (data === null || data === undefined) {
    return null;
  }
  if (Array.isArray(data)) {
    for (const x of data) {
      const r = findGetTranscriptParams(x);
      if (r) {
        return r;
      }
    }
    return null;
  }
  if (!isPlayerRecord(data)) {
    return null;
  }
  const ep = data['getTranscriptEndpoint'];
  if (isPlayerRecord(ep)) {
    const p = ep['params'];
    if (typeof p === 'string' && p.length > 0) {
      return p;
    }
  }
  for (const v of Object.values(data)) {
    const r = findGetTranscriptParams(v);
    if (r) {
      return r;
    }
  }
  return null;
}

/**
 * Parses millisecond fields that may be string or number.
 *
 * @param v Raw attribute value.
 * @returns Milliseconds or `null`.
 */
function numMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    return v;
  }
  if (typeof v === 'string') {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Builds caption text from `snippet.runs` or `simpleText`.
 *
 * @param snippet Snippet object from Innertube.
 * @returns Plain text.
 */
function snippetText(snippet: unknown): string {
  if (!snippet || typeof snippet !== 'object') {
    return '';
  }
  const s = snippet as Record<string, unknown>;
  const simple = s['simpleText'];
  if (typeof simple === 'string') {
    return simple;
  }
  const runs = s['runs'];
  if (!Array.isArray(runs)) {
    return '';
  }
  let t = '';
  for (const run of runs) {
    if (run && typeof run === 'object') {
      const u = (run as { text?: unknown }).text;
      if (typeof u === 'string') {
        t += u;
      }
    }
  }
  return t.trim();
}

/**
 * Collects cue segments from a `get_transcript` JSON response.
 *
 * @param data Parsed JSON body.
 * @returns Segments or `null` if none found.
 */
export function segmentsFromGetTranscriptJson(
  data: unknown,
): CaptionSegment[] | null {
  const out: CaptionSegment[] = [];

  const walk = (node: unknown): void => {
    if (node === null || node === undefined) {
      return;
    }
    if (Array.isArray(node)) {
      for (const x of node) {
        walk(x);
      }
      return;
    }
    if (typeof node !== 'object') {
      return;
    }
    const o = node as Record<string, unknown>;
    const seg = o['transcriptSegmentRenderer'];
    if (seg && typeof seg === 'object') {
      const r = seg as Record<string, unknown>;
      const startMs = numMs(r['startMs'] ?? r['startTimeMs']);
      const endMs = numMs(r['endMs'] ?? r['endTimeMs']);
      const text = snippetText(r['snippet']);
      if (text.length > 0 && startMs !== null) {
        const startSec = startMs / 1000;
        const durationSec =
          endMs !== null && endMs >= startMs
            ? (endMs - startMs) / 1000
            : 0;
        out.push({ startSec, durationSec, text });
      }
    }
    for (const v of Object.values(o)) {
      walk(v);
    }
  };

  walk(data);
  return out.length > 0 ? out : null;
}
