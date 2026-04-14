import type { CaptionSegment } from '@/shared/caption-types';

/**
 * Parses YouTube `fmt=json3` timedtext (Innertube-style events + segs).
 *
 * @param raw JSON string from `/api/timedtext?...&fmt=json3`.
 * @returns Segments or a parse error.
 */
export function parseTranscriptJson3(raw: string): {
  ok: true;
  segments: CaptionSegment[];
} | {
  ok: false;
  error: string;
} {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'Empty transcript response' };
  }

  let root: unknown;
  try {
    root = JSON.parse(trimmed) as unknown;
  } catch {
    return { ok: false, error: 'Invalid JSON transcript' };
  }

  if (!root || typeof root !== 'object') {
    return { ok: false, error: 'Invalid JSON transcript' };
  }

  const events = (root as { events?: unknown }).events;
  if (!Array.isArray(events)) {
    return { ok: false, error: 'No events in JSON transcript' };
  }

  const segments: CaptionSegment[] = [];

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') {
      continue;
    }
    const e = ev as Record<string, unknown>;
    const tStartMs = e['tStartMs'];
    const segs = e['segs'];
    if (typeof tStartMs !== 'number' || !Array.isArray(segs)) {
      continue;
    }
    const startSec = tStartMs / 1000;
    let text = '';
    for (const s of segs) {
      if (s && typeof s === 'object') {
        const u = (s as { utf8?: unknown }).utf8;
        if (typeof u === 'string') {
          text += u;
        }
      }
    }
    text = text.replace(/\n/g, ' ').trim();
    const dDurationMs = e['dDurationMs'];
    const durationSec =
      typeof dDurationMs === 'number' && Number.isFinite(dDurationMs)
        ? dDurationMs / 1000
        : 0;
    if (text.length > 0) {
      segments.push({
        startSec,
        durationSec,
        text,
      });
    }
  }

  if (segments.length === 0) {
    return {
      ok: false,
      error: 'No caption cues found in JSON transcript',
    };
  }

  return { ok: true, segments };
}
