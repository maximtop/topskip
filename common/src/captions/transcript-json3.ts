import type { CaptionSegment } from '@topskip/common/caption-types';
import { MS_PER_SECOND } from '@topskip/common/constants';

/**
 * Parses YouTube JSON3 caption events and segments from any owning runtime.
 *
 * @param raw - JSON3 subtitle document.
 * @returns Segments or a parse error.
 */
export function parseTranscriptJson3(raw: string):
    | {
          ok: true;
          segments: CaptionSegment[];
      }
    | {
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
        const tStartMs: unknown = Reflect.get(ev, 'tStartMs');
        const segs: unknown = Reflect.get(ev, 'segs');
        if (typeof tStartMs !== 'number' || !Array.isArray(segs)) {
            continue;
        }
        const startSec = tStartMs / MS_PER_SECOND;
        let text = '';
        for (const s of segs) {
            if (s && typeof s === 'object') {
                const u: unknown = Reflect.get(s, 'utf8');
                if (typeof u === 'string') {
                    text += u;
                }
            }
        }
        text = text.replace(/\n/g, ' ').trim();
        const dDurationMs: unknown = Reflect.get(ev, 'dDurationMs');
        const durationSec =
            typeof dDurationMs === 'number' && Number.isFinite(dDurationMs)
                ? dDurationMs / MS_PER_SECOND
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
