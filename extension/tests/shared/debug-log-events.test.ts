import { describe, expect, it } from 'vitest';

import {
    BYTES_PER_KIB,
    BYTES_PER_MIB,
    MIME_TEXT_PLAIN_UTF8,
    SESSION_STORAGE_KEY_DEBUG_LOG_TABS,
    SESSION_STORAGE_KEY_DEBUG_LOG_WORKER,
    STORAGE_KEY_DEBUG_LOG_INDEX,
    STORAGE_KEY_DEBUG_LOG_PREFIX,
    STORAGE_KEY_DEBUG_LOG_SEGMENT_PREFIX,
    STORAGE_KEY_DEBUG_LOG_SWITCH,
    STORAGE_KEY_SERVER_RESULT_CACHE,
    STORAGE_KEY_SERVER_RESULT_CACHE_INDEX,
    TOP_FRAME_ID,
} from '@/shared/constants';
import {
    DEBUG_LOG_APPEND_MAX_EVENTS,
    DEBUG_LOG_CAP_BYTES,
    DEBUG_LOG_DEFAULT_ENABLED,
    DEBUG_LOG_MAX_BLOCK_TIMINGS,
    DEBUG_LOG_MAX_FIELD_STRING_LENGTH,
    DEBUG_LOG_POLL_SUMMARY_EVERY_POLLS,
    DEBUG_LOG_SEGMENT_MAX_BYTES,
} from '@/shared/debug-log-constants';
import {
    DEBUG_LOG_COMMON_FIELDS,
    DEBUG_LOG_DROP_REASON,
    DEBUG_LOG_EVENT,
    DEBUG_LOG_EVENT_FIELDS,
    DEBUG_LOG_PAGE_STAGE_PREFIX,
    DEBUG_LOG_RESTART_CAUSE,
    DEBUG_LOG_SOURCE,
    JOB_ID_PATTERN,
    SUPPORT_ID_PATTERN,
    UUID_PATTERN,
    VIDEO_ID_PATTERN,
    debugLogEventNameSchema,
    formatPromoBlockTimings,
    isAllowedDebugLogField,
    roundLogSeconds,
    sanitizeDebugLogFields,
} from '@/shared/debug-log-events';
import * as v from 'valibot';

const EVENT_NAMES = Object.values(DEBUG_LOG_EVENT);
const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const VIDEO_ID = 'dQw4w9WgXcQ';

describe('shared constants additions', () => {
    it('defines the binary units, MIME type, frame id and storage keys', () => {
        expect(BYTES_PER_KIB).toBe(1024);
        expect(BYTES_PER_MIB).toBe(1_048_576);
        expect(MIME_TEXT_PLAIN_UTF8).toBe('text/plain;charset=utf-8');
        expect(TOP_FRAME_ID).toBe(0);
        expect(STORAGE_KEY_DEBUG_LOG_PREFIX).toBe('topskip:debug-log:');
        expect(STORAGE_KEY_DEBUG_LOG_SWITCH).toBe('topskip:debug-log:switch');
        expect(STORAGE_KEY_DEBUG_LOG_INDEX).toBe('topskip:debug-log:index');
        expect(STORAGE_KEY_DEBUG_LOG_SEGMENT_PREFIX).toBe('topskip:debug-log:segment:');
        expect(STORAGE_KEY_SERVER_RESULT_CACHE_INDEX).toBe('topskip:server-result-cache:index');
        expect(SESSION_STORAGE_KEY_DEBUG_LOG_WORKER).toBe('topskipDebugLogWorker');
        expect(SESSION_STORAGE_KEY_DEBUG_LOG_TABS).toBe('topskipDebugLogTabs');
    });

    it('keeps the debug-log key space disjoint from the result-cache key space (FR-004)', () => {
        expect(
            STORAGE_KEY_SERVER_RESULT_CACHE.startsWith(STORAGE_KEY_DEBUG_LOG_PREFIX),
        ).toBe(false);
        expect(
            STORAGE_KEY_DEBUG_LOG_PREFIX.startsWith(STORAGE_KEY_SERVER_RESULT_CACHE),
        ).toBe(false);
        expect(STORAGE_KEY_SERVER_RESULT_CACHE_INDEX.startsWith(STORAGE_KEY_DEBUG_LOG_PREFIX)).toBe(
            false,
        );
    });
});

describe('debug-log constants', () => {
    it('pins the spec budgets', () => {
        expect(DEBUG_LOG_CAP_BYTES).toBe(5 * BYTES_PER_MIB);
        expect(DEBUG_LOG_SEGMENT_MAX_BYTES).toBe(64 * BYTES_PER_KIB);
        expect(DEBUG_LOG_MAX_FIELD_STRING_LENGTH).toBe(128);
        expect(DEBUG_LOG_MAX_BLOCK_TIMINGS).toBe(20);
        expect(DEBUG_LOG_APPEND_MAX_EVENTS).toBe(64);
        expect(DEBUG_LOG_POLL_SUMMARY_EVERY_POLLS).toBe(10);
    });

    it('is off by default under release-like defines (vitest sets the define to false)', () => {
        expect(DEBUG_LOG_DEFAULT_ENABLED).toBe(false);
    });
});

describe('DEBUG_LOG_EVENT', () => {
    it('lists the 44 spec events exactly once each, as kebab-case wire names', () => {
        expect(EVENT_NAMES).toHaveLength(44);
        expect(new Set(EVENT_NAMES).size).toBe(EVENT_NAMES.length);
        for (const name of EVENT_NAMES) {
            expect(name).toMatch(/^[a-z]+(?:-[a-z]+)*$/u);
        }
        expect(DEBUG_LOG_EVENT.LoggingEnabled).toBe('logging-enabled');
        expect(DEBUG_LOG_EVENT.WorkerStarted).toBe('worker-started');
        expect(DEBUG_LOG_EVENT.PollSummary).toBe('poll-summary');
        expect(DEBUG_LOG_EVENT.SkipSuppressed).toBe('skip-suppressed');
        expect(DEBUG_LOG_EVENT.ConnectionKeySaved).toBe('connection-key-saved');
        // FR-046: the switch markers are events; export/copy/download never are.
        expect(EVENT_NAMES).toContain('logging-enabled');
        expect(EVENT_NAMES).toContain('logging-disabled');
        expect(EVENT_NAMES.some((name) => /export|copy|download/u.test(name))).toBe(false);
    });

    it('has a permitted-field set for every event and validates names with the schema', () => {
        for (const name of EVENT_NAMES) {
            expect(Array.isArray(DEBUG_LOG_EVENT_FIELDS[name])).toBe(true);
            expect(v.safeParse(debugLogEventNameSchema, name).success).toBe(true);
        }
        expect(v.safeParse(debugLogEventNameSchema, 'not-an-event').success).toBe(false);
        expect(DEBUG_LOG_SOURCE).toEqual({ Background: 'background', Content: 'content', Bridge: 'bridge' });
        expect(DEBUG_LOG_PAGE_STAGE_PREFIX).toBe('page:');
        expect(DEBUG_LOG_DROP_REASON).toEqual({
            Incognito: 'incognito',
            Coalesced: 'coalesced',
            Ceiling: 'ceiling',
            Unreachable: 'unreachable',
            Lost: 'lost',
        });
        expect(DEBUG_LOG_RESTART_CAUSE.SessionStateLost).toBe('session-state-lost');
        expect(DEBUG_LOG_COMMON_FIELDS).toEqual(['tab', 'video', 'session', 'job', 'support']);
    });
});

describe('isAllowedDebugLogField', () => {
    it('allows common ids everywhere and family fields only on their events', () => {
        expect(isAllowedDebugLogField(DEBUG_LOG_EVENT.SkipApplied, 'video')).toBe(true);
        expect(isAllowedDebugLogField(DEBUG_LOG_EVENT.SkipApplied, 'block')).toBe(true);
        expect(isAllowedDebugLogField(DEBUG_LOG_EVENT.SkipApplied, 'apiKey')).toBe(false);
        expect(isAllowedDebugLogField(DEBUG_LOG_EVENT.ByokChunk, 'latencyMs')).toBe(true);
        expect(isAllowedDebugLogField(DEBUG_LOG_EVENT.ByokChunk, 'transcript')).toBe(false);
        expect(isAllowedDebugLogField(DEBUG_LOG_EVENT.HttpError, 'url')).toBe(false);
    });
});

describe('id patterns', () => {
    it('match the shapes the spec allows and nothing looser', () => {
        expect(VIDEO_ID_PATTERN.test(VIDEO_ID)).toBe(true);
        expect(VIDEO_ID_PATTERN.test('short')).toBe(false);
        expect(UUID_PATTERN.test(SESSION_ID)).toBe(true);
        expect(UUID_PATTERN.test('job-' + SESSION_ID)).toBe(false);
        expect(JOB_ID_PATTERN.test('job-' + SESSION_ID)).toBe(true);
        expect(JOB_ID_PATTERN.test('local-e2eFixture1-server-v7')).toBe(true);
        expect(JOB_ID_PATTERN.test('has space')).toBe(false);
        expect(JOB_ID_PATTERN.test('a'.repeat(161))).toBe(false);
        expect(SUPPORT_ID_PATTERN.test(`support-${SESSION_ID}`)).toBe(true);
        expect(SUPPORT_ID_PATTERN.test('support-x')).toBe(false);
    });
});

describe('formatPromoBlockTimings', () => {
    it('renders one-decimal ranges separated by semicolons and caps with ;+N', () => {
        expect(formatPromoBlockTimings([])).toBe('');
        expect(
            formatPromoBlockTimings([
                { startSec: 12, endSec: 45.5 },
                { startSec: 300.25, endSec: 330 },
                { startSec: 400 },
            ]),
        ).toBe('12.0-45.5;300.3-330.0;400.0-end');
        const many = Array.from({ length: DEBUG_LOG_MAX_BLOCK_TIMINGS + 3 }, (_, i) => ({
            startSec: i,
            endSec: i + 1,
        }));
        const rendered = formatPromoBlockTimings(many);
        expect(rendered.endsWith(';+3')).toBe(true);
        expect(rendered.split(';')).toHaveLength(DEBUG_LOG_MAX_BLOCK_TIMINGS + 1);
    });
});

describe('roundLogSeconds', () => {
    it('rounds to two decimals', () => {
        expect(roundLogSeconds(10.2 - 9)).toBe(1.2);
        expect(roundLogSeconds(20 - 10.2)).toBe(9.8);
        expect(roundLogSeconds(1.005)).toBe(1);
        expect(roundLogSeconds(0)).toBe(0);
    });
});

describe('sanitizeDebugLogFields', () => {
    it('drops unknown keys, nested values, arrays and non-finite numbers; caps strings', () => {
        const sanitized = sanitizeDebugLogFields(DEBUG_LOG_EVENT.RouteDecision, {
            route: 'server',
            reason: 'x'.repeat(DEBUG_LOG_MAX_FIELD_STRING_LENGTH + 10),
            nested: { a: 1 },
            list: [1, 2],
            elapsedMs: Number.NaN,
            decision: null,
            terminal: true,
            secret: 'sk-live',
        });
        expect(Object.keys(sanitized)).toEqual(['route', 'reason', 'decision', 'terminal']);
        expect(sanitized.reason).toHaveLength(DEBUG_LOG_MAX_FIELD_STRING_LENGTH);
        expect(sanitized.decision).toBeNull();
        expect(sanitized.terminal).toBe(true);
    });

    it('keeps identifier fields only when they match their patterns', () => {
        const sanitized = sanitizeDebugLogFields(DEBUG_LOG_EVENT.CacheDecision, {
            tab: 12,
            video: VIDEO_ID,
            session: 'not-a-uuid',
            job: 'job-' + SESSION_ID,
            support: 'support-x',
            decision: 'local_cache',
        });
        expect(sanitized).toEqual({
            tab: 12,
            video: VIDEO_ID,
            job: 'job-' + SESSION_ID,
            decision: 'local_cache',
        });
        expect(sanitizeDebugLogFields(DEBUG_LOG_EVENT.CacheDecision, { tab: -1 })).toEqual({});
        expect(sanitizeDebugLogFields(DEBUG_LOG_EVENT.CacheDecision, { tab: 1.5 })).toEqual({});
    });
});
