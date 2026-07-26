import { describe, expect, it } from 'vitest';

import {
    buildUserMessageFromSegments,
    parseCaptionSegmentsFromTopSkipConsoleLog,
} from '../../../scripts/extract-transcript-from-topskip-console-log';

describe('parseCaptionSegmentsFromTopSkipConsoleLog', () => {
    it('parses single-quoted text segments', () => {
        const sample = [
            'chunk 0–39 (40) [{…}]',
            "0: {start: 73.56, dur: 1, text: 'hello'}",
            "1: {start: 75, dur: 1, text: '&gt;&gt; x'}",
        ].join('');
        const segs = parseCaptionSegmentsFromTopSkipConsoleLog(sample);
        expect(segs).toHaveLength(2);
        expect(segs[0]).toEqual({ startSec: 73.56, text: 'hello' });
        expect(segs[1]).toEqual({ startSec: 75, text: '>> x' });
    });
});

describe('buildUserMessageFromSegments', () => {
    it('builds headers and sorted [sec] lines', () => {
        const body = buildUserMessageFromSegments(
            [
                { startSec: 10, text: 'b' },
                { startSec: 2, text: 'a' },
            ],
            'vid',
            'ru',
        );
        expect(body).toContain('videoId=vid');
        expect(body).toContain('language=ru');
        expect(body).toContain('[2] a');
        expect(body).toContain('[10] b');
    });
});
