import { describe, expect, it } from 'vitest';

import { BYTES_PER_KIB, BYTES_PER_MIB } from '@/shared/constants';
import { DEBUG_LOG_EVENT, DEBUG_LOG_SOURCE } from '@/shared/debug-log-events';
import {
    buildDebugLogFileName,
    formatBinarySize,
    formatDebugLogLine,
    sliceDebugLogTail,
    utf8ByteLength,
    type DebugLogLineRecord,
} from '@/shared/debug-log-format';

const TS_MS = Date.UTC(2026, 7, 22, 23, 59, 59, 123);
const SESSION_ID = '00000000-0000-4000-8000-000000000001';

/**
 * Fully attributed record with overridable parts.
 */
function record(overrides: Partial<DebugLogLineRecord> = {}): DebugLogLineRecord {
    return {
        tsMs: TS_MS,
        worker: 'w3',
        seq: 41,
        src: DEBUG_LOG_SOURCE.Background,
        event: DEBUG_LOG_EVENT.RouteDecision,
        fields: {},
        ...overrides,
    };
}

describe('formatDebugLogLine', () => {
    it('writes the fixed head, ids in order, the event and inline fields', () => {
        const line = formatDebugLogLine(
            record({
                src: DEBUG_LOG_SOURCE.Content,
                tab: 12,
                video: 'dQw4w9WgXcQ',
                session: SESSION_ID,
                job: 'job-x',
                support: `support-${SESSION_ID}`,
                fields: { route: 'server', reason: 'a b', skipped: undefined, count: 2 },
            }),
        );
        expect(line).toBe(
            `2026-08-22T23:59:59.123Z w3#41 ct t12 v=dQw4w9WgXcQ s=${SESSION_ID} j=job-x ` +
                `sup=support-${SESSION_ID} route-decision route=server reason="a b" count=2`,
        );
    });

    it('omits absent ids and trailing space when there are no fields', () => {
        expect(formatDebugLogLine(record())).toBe('2026-08-22T23:59:59.123Z w3#41 bg route-decision');
        expect(formatDebugLogLine(record({ src: DEBUG_LOG_SOURCE.Bridge }))).toContain(' br ');
    });

    it('never throws on an unrepresentable timestamp', () => {
        expect(formatDebugLogLine(record({ tsMs: 1e20 }))).toContain('invalid-ts w3#41');
        expect(formatDebugLogLine(record({ tsMs: Number.NaN }))).toContain('invalid-ts w3#41');
    });
});

describe('utf8ByteLength', () => {
    it('counts encoded bytes, not UTF-16 units', () => {
        expect(utf8ByteLength('abc')).toBe(3);
        expect(utf8ByteLength('é')).toBe(2);
        expect(utf8ByteLength('😀')).toBe(4);
    });
});

describe('buildDebugLogFileName', () => {
    it('stamps the UTC instant without punctuation or milliseconds', () => {
        expect(buildDebugLogFileName(new Date(Date.UTC(2026, 7, 22, 13, 5, 9, 123)))).toBe(
            'topskip-debug-log-20260822T130509Z.txt',
        );
    });
});

describe('sliceDebugLogTail', () => {
    it('returns the whole text when it fits', () => {
        expect(sliceDebugLogTail('abc', 10)).toEqual({ text: 'abc', shownBytes: 3, totalBytes: 3 });
    });

    it('keeps the last bytes without splitting a UTF-8 sequence', () => {
        // 'a'(1) 'é'(2) '😀'(4) 'b'(1) = 8 bytes.
        expect(sliceDebugLogTail('aé😀b', 5)).toEqual({ text: '😀b', shownBytes: 5, totalBytes: 8 });
        expect(sliceDebugLogTail('aé😀b', 4)).toEqual({ text: 'b', shownBytes: 1, totalBytes: 8 });
        expect(sliceDebugLogTail('aé😀b', 0)).toEqual({ text: '', shownBytes: 0, totalBytes: 8 });
    });
});

describe('formatBinarySize', () => {
    it('uses B, KiB and MiB with one decimal', () => {
        expect(formatBinarySize(512)).toBe('512 B');
        expect(formatBinarySize(3.5 * BYTES_PER_KIB)).toBe('3.5 KiB');
        expect(formatBinarySize(5 * BYTES_PER_MIB)).toBe('5.0 MiB');
    });
});
