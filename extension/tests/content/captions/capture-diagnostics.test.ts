import { describe, expect, it } from 'vitest';

import {
    CAPTION_PAGE_DIAGNOSTIC_STAGES,
    CaptureDiagnostics,
    MAX_PAGE_DIAGNOSTIC_STRING_LENGTH,
    PAGE_DIAGNOSTIC_STAGE_PREFIX,
} from '@/content/captions/capture-diagnostics';
import { DEBUG_LOG_BRIDGE_DIAGNOSTICS_PER_SESSION } from '@/shared/debug-log-constants';
import { DEBUG_LOG_EVENT } from '@/shared/debug-log-events';

const URL_SHAPE = {
    pathname: '/api/timedtext',
    paramNames: ['fmt', 'lang', 'pot', 'v'],
    fmt: 'json3',
    hasPot: true,
};
const SENTINEL_ERROR =
    'SENTINEL-ERROR https://www.youtube.com/api/timedtext?v=x&sig=SECRET-SIG';

describe('CaptureDiagnostics.toDebugLogEvent', () => {
    it('maps schedule-start to capture-scheduled with the trigger', () => {
        expect(
            CaptureDiagnostics.toDebugLogEvent('schedule-start', {
                videoId: 'dQw4w9WgXcQ',
                source: 'video-id-change',
            }),
        ).toEqual({
            event: DEBUG_LOG_EVENT.CaptureScheduled,
            fields: { trigger: 'video-id-change' },
        });
    });

    it('maps schedule-clear to a capture-stage carrying the cancel reason', () => {
        expect(
            CaptureDiagnostics.toDebugLogEvent('schedule-clear', { source: 'navigation' }),
        ).toEqual({
            event: DEBUG_LOG_EVENT.CaptureStage,
            fields: { stage: 'schedule-clear', reason: 'navigation' },
        });
    });

    it('maps activation-accepted to capture-activation with an action count', () => {
        expect(
            CaptureDiagnostics.toDebugLogEvent('activation-accepted', {
                videoId: 'dQw4w9WgXcQ',
                attempt: 1,
                ok: true,
                wasOn: false,
                userIntervened: false,
                hasTracks: 2,
                actions: ['hide-style-added', 'loadModule:captions', 'toggleSubtitlesOn'],
            }),
        ).toEqual({
            event: DEBUG_LOG_EVENT.CaptureActivation,
            fields: {
                ok: true,
                wasOn: false,
                userIntervened: false,
                hasTracks: 2,
                actions: 3,
            },
        });
    });

    it('keeps a retried activation failure out of the log and records the final one', () => {
        const details = {
            videoId: 'dQw4w9WgXcQ',
            attempt: 2,
            ok: false,
            reason: 'player-not-ready',
            error: SENTINEL_ERROR,
        };
        expect(
            CaptureDiagnostics.toDebugLogEvent('activation-failed', {
                ...details,
                retrying: true,
            }),
        ).toBeNull();
        const final = CaptureDiagnostics.toDebugLogEvent('activation-failed', {
            ...details,
            retrying: false,
        });
        expect(final).toEqual({
            event: DEBUG_LOG_EVENT.CaptureActivation,
            fields: { ok: false, reason: 'player-not-ready' },
        });
        expect(JSON.stringify(final)).not.toContain('SENTINEL');
    });

    it('maps the hidden-tab activation pause and its resume to capture-stage', () => {
        expect(
            CaptureDiagnostics.toDebugLogEvent('activation-deferred', {
                videoId: 'dQw4w9WgXcQ',
                reason: 'hidden',
            }),
        ).toEqual({
            event: DEBUG_LOG_EVENT.CaptureStage,
            fields: { stage: 'activation-deferred', reason: 'hidden' },
        });
        expect(
            CaptureDiagnostics.toDebugLogEvent('activation-resumed', {
                videoId: 'dQw4w9WgXcQ',
            }),
        ).toEqual({
            event: DEBUG_LOG_EVENT.CaptureStage,
            fields: { stage: 'activation-resumed' },
        });
    });

    it('keeps the activation attempt count on capture-failed', () => {
        expect(
            CaptureDiagnostics.toDebugLogEvent('capture-failed', {
                videoId: 'dQw4w9WgXcQ',
                reason: 'player-not-ready',
                stage: 'activating',
                error: SENTINEL_ERROR,
                attempts: 481,
            }),
        ).toEqual({
            event: DEBUG_LOG_EVENT.CaptureFailed,
            fields: {
                reason: 'player-not-ready',
                stage: 'activating',
                attempts: 481,
            },
        });
        expect(
            CaptureDiagnostics.toDebugLogEvent('capture-failed', {
                reason: 'capture-timeout',
                stage: 'waiting-capture',
                attempts: Number.NaN,
            }),
        ).toEqual({
            event: DEBUG_LOG_EVENT.CaptureFailed,
            fields: { reason: 'capture-timeout', stage: 'waiting-capture' },
        });
    });

    it('maps reload-scheduled to capture-stage with the backoff and budget', () => {
        expect(
            CaptureDiagnostics.toDebugLogEvent('reload-scheduled', {
                videoId: 'dQw4w9WgXcQ',
                delayMs: 500,
                hasPot: false,
                budgetLeft: 3,
            }),
        ).toEqual({
            event: DEBUG_LOG_EVENT.CaptureStage,
            fields: {
                stage: 'reload-scheduled',
                delayMs: 500,
                hasPot: false,
                budgetLeft: 3,
            },
        });
    });

    it('maps reload-skipped to capture-stage with the exhausted-budget reason', () => {
        expect(
            CaptureDiagnostics.toDebugLogEvent('reload-skipped', {
                videoId: 'dQw4w9WgXcQ',
                reason: 'budget',
            }),
        ).toEqual({
            event: DEBUG_LOG_EVENT.CaptureStage,
            fields: { stage: 'reload-skipped', reason: 'budget' },
        });
    });

    it('keeps the empty-body split by pot presence on capture-failed', () => {
        expect(
            CaptureDiagnostics.toDebugLogEvent('capture-failed', {
                videoId: 'dQw4w9WgXcQ',
                reason: 'capture-timeout',
                stage: 'waiting-capture',
                error: SENTINEL_ERROR,
                attempts: 4,
                emptyNoPot: 2,
                emptyPot: 4,
            }),
        ).toEqual({
            event: DEBUG_LOG_EVENT.CaptureFailed,
            fields: {
                reason: 'capture-timeout',
                stage: 'waiting-capture',
                attempts: 4,
                emptyNoPot: 2,
                emptyPot: 4,
            },
        });
    });

    it('maps capture-event-received to capture-stage with the URL shape split', () => {
        expect(
            CaptureDiagnostics.toDebugLogEvent('capture-event-received', {
                videoId: 'dQw4w9WgXcQ',
                activeVideoId: 'dQw4w9WgXcQ',
                languageCode: 'en',
                bodyLength: 1234,
                contentType: 'application/json; charset=UTF-8',
                urlShape: URL_SHAPE,
            }),
        ).toEqual({
            event: DEBUG_LOG_EVENT.CaptureStage,
            fields: {
                stage: 'capture-event-received',
                lang: 'en',
                bodyLength: 1234,
                contentType: 'application/json; charset=UTF-8',
                urlPath: '/api/timedtext',
                urlParams: 'fmt,lang,pot,v',
                fmt: 'json3',
                hasPot: true,
            },
        });
    });

    it('maps capture-parsed to capture-succeeded with the segment count', () => {
        expect(
            CaptureDiagnostics.toDebugLogEvent('capture-parsed', {
                videoId: 'dQw4w9WgXcQ',
                languageCode: 'en',
                bodyLength: 1234,
                segmentCount: 42,
                urlShape: URL_SHAPE,
            }),
        ).toEqual({
            event: DEBUG_LOG_EVENT.CaptureSucceeded,
            fields: {
                lang: 'en',
                bodyLength: 1234,
                segments: 42,
                urlPath: '/api/timedtext',
                urlParams: 'fmt,lang,pot,v',
                fmt: 'json3',
                hasPot: true,
            },
        });
    });

    it('maps capture-failed to the stable reason and phase without free-form text', () => {
        const mapped = CaptureDiagnostics.toDebugLogEvent('capture-failed', {
            videoId: 'dQw4w9WgXcQ',
            reason: 'parse-failed',
            stage: 'parsing',
            error: SENTINEL_ERROR,
        });
        expect(mapped).toEqual({
            event: DEBUG_LOG_EVENT.CaptureFailed,
            fields: { reason: 'parse-failed', stage: 'parsing' },
        });
        expect(JSON.stringify(mapped)).not.toContain('SENTINEL');
        expect(JSON.stringify(mapped)).not.toContain('SECRET');
    });

    it('maps bridge stages with the page prefix', () => {
        expect(
            CaptureDiagnostics.toDebugLogEvent(
                `${PAGE_DIAGNOSTIC_STAGE_PREFIX}timedtext-observed`,
                {
                    transport: 'xhr',
                    status: 200,
                    bodyLength: 0,
                    contentType: null,
                    videoId: 'abc',
                    languageCode: 'en',
                    urlShape: URL_SHAPE,
                },
            ),
        ).toEqual({
            event: DEBUG_LOG_EVENT.CaptureStage,
            fields: {
                stage: 'page:timedtext-observed',
                transport: 'xhr',
                status: 200,
                bodyLength: 0,
                lang: 'en',
                urlPath: '/api/timedtext',
                urlParams: 'fmt,lang,pot,v',
                fmt: 'json3',
                hasPot: true,
            },
        });
        expect(
            CaptureDiagnostics.toDebugLogEvent(
                `${PAGE_DIAGNOSTIC_STAGE_PREFIX}activation-finished`,
                {
                    ok: true,
                    wasOn: false,
                    userIntervened: false,
                    buttonPressed: 'true',
                    hideStylePresent: true,
                    hasTracks: 1,
                    actions: ['loadModule:captions', 'toggleSubtitlesOn'],
                },
            ),
        ).toEqual({
            event: DEBUG_LOG_EVENT.CaptureActivation,
            fields: {
                ok: true,
                wasOn: false,
                userIntervened: false,
                hasTracks: 1,
                actions: 2,
            },
        });
    });

    it('maps the translated response and its untranslated refetch with bounded fields only', () => {
        const translatedShape = {
            ...URL_SHAPE,
            paramNames: ['fmt', 'lang', 'pot', 'tlang', 'v'],
        };
        expect(
            CaptureDiagnostics.toDebugLogEvent(
                `${PAGE_DIAGNOSTIC_STAGE_PREFIX}timedtext-translated`,
                {
                    transport: 'fetch',
                    status: 200,
                    bodyLength: 2878880,
                    contentType: 'application/json',
                    videoId: 'abc',
                    languageCode: 'ru',
                    urlShape: translatedShape,
                },
            ),
        ).toEqual({
            event: DEBUG_LOG_EVENT.CaptureStage,
            fields: {
                stage: 'page:timedtext-translated',
                transport: 'fetch',
                status: 200,
                bodyLength: 2878880,
                contentType: 'application/json',
                lang: 'ru',
                urlPath: '/api/timedtext',
                urlParams: 'fmt,lang,pot,tlang,v',
                fmt: 'json3',
                hasPot: true,
            },
        });
        expect(
            CaptureDiagnostics.toDebugLogEvent(
                `${PAGE_DIAGNOSTIC_STAGE_PREFIX}timedtext-original-refetched`,
                {
                    transport: 'refetch',
                    ok: true,
                    status: 200,
                    bodyLength: 2544413,
                    videoId: 'abc',
                    languageCode: 'ru',
                    urlShape: URL_SHAPE,
                },
            ),
        ).toEqual({
            event: DEBUG_LOG_EVENT.CaptureStage,
            fields: {
                stage: 'page:timedtext-original-refetched',
                transport: 'refetch',
                ok: true,
                status: 200,
                bodyLength: 2544413,
                lang: 'ru',
                urlPath: '/api/timedtext',
                urlParams: 'fmt,lang,pot,v',
                fmt: 'json3',
                hasPot: true,
            },
        });
    });

    it.each([
        'schedule-duplicate',
        'schedule-replace',
        'bridge-readiness-requested',
        'activation-attempt',
        'capture-event-ignored',
        'capture-event-rejected',
        'capture-timeout',
        'capture-parse-failed',
        'bridge-readiness-failed',
        'failure-sent',
        'page:bridge-installed',
        'page:cleanup-finished',
        'unknown-stage',
    ])('keeps %s out of the debug log', (stage) => {
        expect(CaptureDiagnostics.toDebugLogEvent(stage, { reason: 'x' })).toBeNull();
    });

    it('drops null, undefined, non-finite and structured values', () => {
        expect(
            CaptureDiagnostics.toDebugLogEvent('cleanup-finished', {
                videoId: null,
                ok: true,
                wasOn: null,
                hasTracks: null,
                status: Number.NaN,
                nested: { body: 'SENTINEL-BODY' },
                actions: ['hide-style-removed'],
            }),
        ).toEqual({
            event: DEBUG_LOG_EVENT.CaptureStage,
            fields: { stage: 'cleanup-finished', ok: true, actions: 1 },
        });
    });
});

describe('CaptureDiagnostics.acceptBridgeDiagnostic', () => {
    const accepted = {
        stage: 'timedtext-empty-body',
        transport: 'xhr',
        status: 200,
        bodyLength: 0,
        videoId: 'abc',
        languageCode: 'en',
        urlShape: URL_SHAPE,
    };

    it('publishes the allow-list of MAIN-world stages', () => {
        expect([...CAPTION_PAGE_DIAGNOSTIC_STAGES].sort()).toEqual([
            'activation-finished',
            'timedtext-empty-body',
            'timedtext-forwarded',
            'timedtext-non-json',
            'timedtext-observed',
            'timedtext-original-refetched',
            'timedtext-translated',
        ]);
    });

    it('accepts allow-listed stages under the session limit', () => {
        expect(CaptureDiagnostics.acceptBridgeDiagnostic(accepted, 0)).toBe(true);
        expect(
            CaptureDiagnostics.acceptBridgeDiagnostic(
                accepted,
                DEBUG_LOG_BRIDGE_DIAGNOSTICS_PER_SESSION - 1,
            ),
        ).toBe(true);
    });

    it.each(['bridge-installed', 'cleanup-finished', 'activation-blocked', 'forged'])(
        'rejects the %s stage',
        (stage) => {
            expect(
                CaptureDiagnostics.acceptBridgeDiagnostic({ ...accepted, stage }, 0),
            ).toBe(false);
        },
    );

    it('rejects oversized strings anywhere in the details', () => {
        const long = 'x'.repeat(MAX_PAGE_DIAGNOSTIC_STRING_LENGTH + 1);
        expect(
            CaptureDiagnostics.acceptBridgeDiagnostic({ ...accepted, transport: long }, 0),
        ).toBe(false);
        expect(
            CaptureDiagnostics.acceptBridgeDiagnostic(
                { ...accepted, urlShape: { ...URL_SHAPE, pathname: long } },
                0,
            ),
        ).toBe(false);
        expect(
            CaptureDiagnostics.acceptBridgeDiagnostic(
                { ...accepted, urlShape: { ...URL_SHAPE, paramNames: ['fmt', long] } },
                0,
            ),
        ).toBe(false);
        expect(
            CaptureDiagnostics.acceptBridgeDiagnostic(
                { ...accepted, transport: 'x'.repeat(MAX_PAGE_DIAGNOSTIC_STRING_LENGTH) },
                0,
            ),
        ).toBe(true);
    });

    it('rejects once the per-session limit is reached', () => {
        expect(
            CaptureDiagnostics.acceptBridgeDiagnostic(
                accepted,
                DEBUG_LOG_BRIDGE_DIAGNOSTICS_PER_SESSION,
            ),
        ).toBe(false);
    });
});
