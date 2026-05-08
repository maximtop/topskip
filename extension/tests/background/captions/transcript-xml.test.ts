import { describe, expect, it } from 'vitest';

import { parseTranscriptXml } from '@/shared/captions/transcript-xml';

describe('parseTranscriptXml', () => {
    it('parses typical YouTube timedtext XML', () => {
        const xml = `
      <transcript>
        <text start="0.5" dur="2.1">Hello</text>
        <text start="2.6" dur="1.0">world</text>
      </transcript>
    `;
        const r = parseTranscriptXml(xml);
        expect(r.ok).toBe(true);
        if (!r.ok) {
            return;
        }
        expect(r.segments).toHaveLength(2);
        expect(r.segments[0]).toEqual({
            startSec: 0.5,
            durationSec: 2.1,
            text: 'Hello',
        });
        expect(r.segments[1]).toEqual({
            startSec: 2.6,
            durationSec: 1.0,
            text: 'world',
        });
    });

    it('strips inline tags inside cues', () => {
        const xml =
            '<transcript><text start="0" dur="1"><i>Hi</i> there</text></transcript>';
        const r = parseTranscriptXml(xml);
        expect(r.ok).toBe(true);
        if (!r.ok) {
            return;
        }
        expect(r.segments[0]?.text).toBe('Hi there');
    });

    it('defaults dur when missing', () => {
        const xml = '<transcript><text start="1.2">Only</text></transcript>';
        const r = parseTranscriptXml(xml);
        expect(r.ok).toBe(true);
        if (!r.ok) {
            return;
        }
        expect(r.segments[0]?.durationSec).toBe(0);
    });

    it('rejects empty input', () => {
        const r = parseTranscriptXml('   ');
        expect(r.ok).toBe(false);
        if (r.ok) {
            return;
        }
        expect(r.error).toMatch(/empty/i);
    });

    it('rejects XML with no text elements', () => {
        const r = parseTranscriptXml('<transcript></transcript>');
        expect(r.ok).toBe(false);
        if (r.ok) {
            return;
        }
        expect(r.error).toMatch(/No caption cues/i);
    });

    it('parses timedtext format="3" (<p t="ms" d="ms">)', () => {
        const xml = [
            '<?xml version="1.0" encoding="utf-8" ?>',
            '<timedtext format="3"><body>',
            '<p t="1000" d="2000">First line</p>',
            '<p t="3500" d="1500"><s>Styled</s> cue</p>',
            '</body></timedtext>',
        ].join('');
        const r = parseTranscriptXml(xml);
        expect(r.ok).toBe(true);
        if (!r.ok) {
            return;
        }
        expect(r.segments).toHaveLength(2);
        expect(r.segments[0]).toEqual({
            startSec: 1,
            durationSec: 2,
            text: 'First line',
        });
        expect(r.segments[1]?.text).toBe('Styled cue');
        expect(r.segments[1]?.startSec).toBe(3.5);
    });
});
