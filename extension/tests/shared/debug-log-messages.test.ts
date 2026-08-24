import { describe, expect, it } from 'vitest';
import * as v from 'valibot';

import {
    DEBUG_LOG_APPEND_MAX_EVENTS,
    DEBUG_LOG_CAP_BYTES,
    DEBUG_LOG_MAX_FIELD_KEY_LENGTH,
    DEBUG_LOG_MAX_FIELD_STRING_LENGTH,
} from '@/shared/debug-log-constants';
import { DEBUG_LOG_EVENT } from '@/shared/debug-log-events';
import {
    DEV_DEBUG_LOG_SEED_STATE,
    DEV_SEED_DISABLED_ERROR,
    TOPSKIP_MESSAGE,
    UNTRUSTED_SENDER_ERROR,
    debugLogAppendPayloadSchema,
    debugLogAppendRuntimeMessageSchema,
    debugLogStatusPayloadSchema,
    devSeedDebugLogPayloadSchema,
    getDebugLogStatusResponseSchema,
    isDebugLogStateUpdatedMessage,
    setDebugLoggingMessageSchema,
    type DebugLogAppendPayload,
    type DebugLogStatusPayload,
    type GetDetectionStatusResponse,
    type GetPrefsResponse,
    type TopSkipRuntimeMessage,
} from '@/shared/messages';

const SESSION_ID = '00000000-0000-4000-8000-000000000001';
const VIDEO_ID = 'dQw4w9WgXcQ';

/**
 * Minimal valid content event.
 */
function event(fields: Record<string, unknown> = {}): Record<string, unknown> {
    return { event: DEBUG_LOG_EVENT.SkipApplied, ageMs: 0, fields };
}

/**
 * Minimal valid append payload around the given events.
 */
function payload(events: unknown[]): unknown {
    return { events };
}

describe('TOPSKIP_MESSAGE debug-log entries', () => {
    it('defines the seven message types with the TOPSKIP_ prefix', () => {
        expect(TOPSKIP_MESSAGE.DEBUG_LOG_APPEND).toBe('TOPSKIP_DEBUG_LOG_APPEND');
        expect(TOPSKIP_MESSAGE.GET_DEBUG_LOG_STATUS).toBe('TOPSKIP_GET_DEBUG_LOG_STATUS');
        expect(TOPSKIP_MESSAGE.GET_DEBUG_LOG_PREVIEW).toBe('TOPSKIP_GET_DEBUG_LOG_PREVIEW');
        expect(TOPSKIP_MESSAGE.GET_DEBUG_LOG_BUNDLE).toBe('TOPSKIP_GET_DEBUG_LOG_BUNDLE');
        expect(TOPSKIP_MESSAGE.SET_DEBUG_LOGGING).toBe('TOPSKIP_SET_DEBUG_LOGGING');
        expect(TOPSKIP_MESSAGE.DEBUG_LOG_STATE_UPDATED).toBe('TOPSKIP_DEBUG_LOG_STATE_UPDATED');
        expect(TOPSKIP_MESSAGE.DEV_SEED_DEBUG_LOG).toBe('TOPSKIP_DEV_SEED_DEBUG_LOG');
        expect(UNTRUSTED_SENDER_ERROR).toBe('Untrusted sender.');
        expect(DEV_SEED_DISABLED_ERROR).toBe('Dev debug log seeding is disabled.');
    });
});

describe('debugLogAppendPayloadSchema', () => {
    it('accepts scalar fields, optional ids and drop counters', () => {
        const parsed = v.safeParse(debugLogAppendPayloadSchema, {
            events: [
                {
                    event: DEBUG_LOG_EVENT.PollSummary,
                    ageMs: 120,
                    video: VIDEO_ID,
                    session: SESSION_ID,
                    job: 'job-' + SESSION_ID,
                    fields: { polls: 3, lastStatus: 'ready', terminal: true, reason: null },
                },
            ],
            dropped: { coalesced: 1, ceiling: 0, unreachable: 2 },
        });
        expect(parsed.success).toBe(true);
    });

    it.each([
        ['a nested field', payload([event({ a: { x: 1 } })])],
        ['an array field', payload([event({ a: [1] })])],
        ['a non-finite number', payload([event({ a: Number.NaN })])],
        ['an over-long string', payload([event({ a: 'x'.repeat(DEBUG_LOG_MAX_FIELD_STRING_LENGTH + 1) })])],
        ['an over-long key', payload([event({ ['k'.repeat(DEBUG_LOG_MAX_FIELD_KEY_LENGTH + 1)]: 1 })])],
        ['an unknown event name', payload([{ event: 'nope', ageMs: 0, fields: {} }])],
        ['a negative age', payload([{ event: DEBUG_LOG_EVENT.SkipApplied, ageMs: -1, fields: {} }])],
        ['an extra event key (e.g. url)', payload([{ ...event(), url: 'https://x' }])],
        ['a src field (the wire carries no source)', payload([{ ...event(), src: 'bridge' }])],
        ['a malformed video id', payload([{ ...event(), video: 'short' }])],
        ['a malformed session id', payload([{ ...event(), session: 'not-a-uuid' }])],
        ['a job id with spaces', payload([{ ...event(), job: 'job x' }])],
        ['too many events', payload(Array.from({ length: DEBUG_LOG_APPEND_MAX_EVENTS + 1 }, () => event()))],
        ['an unknown drop counter', { events: [], dropped: { coalesced: 0, ceiling: 0, unreachable: 0, lost: 1 } }],
        ['an extra payload key', { events: [], tabId: 4 }],
    ])('rejects %s', (_name, candidate) => {
        expect(v.safeParse(debugLogAppendPayloadSchema, candidate).success).toBe(false);
    });

    it('validates the strict runtime envelope', () => {
        const ok = v.safeParse(debugLogAppendRuntimeMessageSchema, {
            type: TOPSKIP_MESSAGE.DEBUG_LOG_APPEND,
            payload: { events: [event()] },
        });
        expect(ok.success).toBe(true);
        const wrongType = v.safeParse(debugLogAppendRuntimeMessageSchema, {
            type: TOPSKIP_MESSAGE.GET_PREFS,
            payload: { events: [] },
        });
        expect(wrongType.success).toBe(false);
    });
});

describe('status, switch and seed schemas', () => {
    const status: DebugLogStatusPayload = {
        enabled: true,
        hasLog: true,
        enabledAtMs: 1_900_000_000_000,
        disabledAtMs: null,
        eventCount: 3,
        sizeBytes: 300,
        capBytes: DEBUG_LOG_CAP_BYTES,
        evictedCount: 0,
        oldestRetainedMs: 1_900_000_000_000,
        dropped: { incognito: 0, coalesced: 0, ceiling: 0, unreachable: 0, lost: 0 },
        revision: 7,
    };

    it('accepts a complete status payload and rejects unknown keys', () => {
        expect(v.safeParse(debugLogStatusPayloadSchema, status).success).toBe(true);
        expect(
            v.safeParse(debugLogStatusPayloadSchema, { ...status, extra: 1 }).success,
        ).toBe(false);
        expect(
            v.safeParse(getDebugLogStatusResponseSchema, { ok: true, status }).success,
        ).toBe(true);
        expect(
            v.safeParse(getDebugLogStatusResponseSchema, { ok: false, error: 'x' }).success,
        ).toBe(true);
    });

    it('guards the state push and the switch command', () => {
        expect(
            isDebugLogStateUpdatedMessage({
                type: TOPSKIP_MESSAGE.DEBUG_LOG_STATE_UPDATED,
                enabled: true,
            }),
        ).toBe(true);
        expect(
            isDebugLogStateUpdatedMessage({
                type: TOPSKIP_MESSAGE.DEBUG_LOG_STATE_UPDATED,
                enabled: 'yes',
            }),
        ).toBe(false);
        expect(
            v.safeParse(setDebugLoggingMessageSchema, {
                type: TOPSKIP_MESSAGE.SET_DEBUG_LOGGING,
                enabled: false,
            }).success,
        ).toBe(true);
    });

    it('bounds the dev seed payload by the cap', () => {
        expect(
            v.safeParse(devSeedDebugLogPayloadSchema, {
                state: DEV_DEBUG_LOG_SEED_STATE.OffStored,
                approxBytes: 2048,
            }).success,
        ).toBe(true);
        expect(
            v.safeParse(devSeedDebugLogPayloadSchema, {
                state: DEV_DEBUG_LOG_SEED_STATE.On,
                approxBytes: DEBUG_LOG_CAP_BYTES + 1,
            }).success,
        ).toBe(false);
        expect(v.safeParse(devSeedDebugLogPayloadSchema, { state: 'nope' }).success).toBe(false);
    });
});

describe('type-level additions', () => {
    it('compiles the new union members and response fields', () => {
        const append: TopSkipRuntimeMessage = {
            type: TOPSKIP_MESSAGE.DEBUG_LOG_APPEND,
            payload: { events: [] } satisfies DebugLogAppendPayload,
        };
        const setSwitch: TopSkipRuntimeMessage = {
            type: TOPSKIP_MESSAGE.SET_DEBUG_LOGGING,
            enabled: true,
        };
        // These assignments only compile when the ok variants carry the new
        // fields (the literal key must be a key of the narrowed type).
        const prefsField: keyof Extract<GetPrefsResponse, { ok: true }> = 'debugLogEnabled';
        const detectionField: keyof Extract<GetDetectionStatusResponse, { ok: true }> =
            'debugLoggingEnabled';
        const detection: GetDetectionStatusResponse = {
            ok: true,
            tabId: null,
            state: null,
            debugLoggingEnabled: true,
        };
        expect([append.type, setSwitch.type]).toEqual([
            TOPSKIP_MESSAGE.DEBUG_LOG_APPEND,
            TOPSKIP_MESSAGE.SET_DEBUG_LOGGING,
        ]);
        expect([prefsField, detectionField]).toEqual(['debugLogEnabled', 'debugLoggingEnabled']);
        expect(detection.ok && detection.debugLoggingEnabled).toBe(true);
    });
});
