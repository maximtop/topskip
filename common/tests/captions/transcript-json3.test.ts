import { describe, expect, it } from 'vitest';

import { parseTranscriptJson3 } from '@topskip/common/captions/transcript-json3';

describe('parseTranscriptJson3', () => {
    it('returns segments from Innertube-style events', () => {
        const raw = JSON.stringify({
            events: [
                {
                    tStartMs: 0,
                    dDurationMs: 1000,
                    segs: [{ utf8: 'hello ' }, { utf8: 'world' }],
                },
            ],
        });
        const r = parseTranscriptJson3(raw);
        expect(r.ok).toBe(true);
        if (!r.ok) {
            return;
        }
        expect(r.segments).toHaveLength(1);
        expect(r.segments[0]?.text).toBe('hello world');
        expect(r.segments[0]?.startSec).toBe(0);
        expect(r.segments[0]?.durationSec).toBe(1);
    });

    it('returns error when events missing', () => {
        const r = parseTranscriptJson3('{}');
        expect(r.ok).toBe(false);
        if (r.ok) {
            return;
        }
        expect(r.error).toMatch(/events/i);
    });

    it('rejects empty json3 bodies', () => {
        const r = parseTranscriptJson3('');
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toMatch(/empty/i);
        }
    });

    it('skips events without text cues', () => {
        const r = parseTranscriptJson3(
            JSON.stringify({
                events: [
                    { tStartMs: 0 },
                    { tStartMs: 1, segs: [{ utf8: '' }] },
                ],
            }),
        );
        expect(r.ok).toBe(false);
        if (!r.ok) {
            expect(r.error).toMatch(/No caption cues/i);
        }
    });

    it('keeps multiline cue text readable', () => {
        const r = parseTranscriptJson3(
            JSON.stringify({
                events: [
                    {
                        tStartMs: 0,
                        dDurationMs: 1000,
                        segs: [{ utf8: 'hello\n' }, { utf8: 'world' }],
                    },
                ],
            }),
        );
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.segments[0]?.text).toBe('hello world');
        }
    });
});
