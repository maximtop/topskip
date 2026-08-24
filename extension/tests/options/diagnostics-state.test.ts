import { describe, expect, it } from 'vitest';

import {
    DIAGNOSTICS_PHASE,
    canExportDebugLog,
    canToggleDebugLogging,
    shouldRefetchPreview,
    toDiagnosticsPhase,
} from '@/options/diagnostics-state';
import type { DebugLogStatusPayload } from '@/shared/messages';

const STATUS_ON: DebugLogStatusPayload = {
    enabled: true,
    hasLog: true,
    enabledAtMs: 1_755_856_800_000,
    disabledAtMs: null,
    eventCount: 42,
    sizeBytes: 6_144,
    capBytes: 5 * 1024 * 1024,
    evictedCount: 0,
    oldestRetainedMs: 1_755_856_800_000,
    dropped: { incognito: 0, coalesced: 0, ceiling: 0, unreachable: 0, lost: 0 },
    revision: 3,
};
const STATUS_OFF_STORED: DebugLogStatusPayload = {
    ...STATUS_ON,
    enabled: false,
    disabledAtMs: 1_755_857_000_000,
};
const STATUS_OFF_EMPTY: DebugLogStatusPayload = {
    ...STATUS_OFF_STORED,
    hasLog: false,
    enabledAtMs: null,
    disabledAtMs: null,
    eventCount: 0,
    sizeBytes: 0,
    oldestRetainedMs: null,
};

describe('toDiagnosticsPhase', () => {
    it('maps the status matrix rows', () => {
        expect(toDiagnosticsPhase(null, false)).toBe(DIAGNOSTICS_PHASE.Loading);
        expect(toDiagnosticsPhase(STATUS_ON, false)).toBe(DIAGNOSTICS_PHASE.On);
        expect(toDiagnosticsPhase(STATUS_OFF_STORED, false)).toBe(
            DIAGNOSTICS_PHASE.OffStored,
        );
        expect(toDiagnosticsPhase(STATUS_OFF_EMPTY, false)).toBe(
            DIAGNOSTICS_PHASE.OffEmpty,
        );
    });

    it('lets a failed read win over a stale status', () => {
        expect(toDiagnosticsPhase(null, true)).toBe(
            DIAGNOSTICS_PHASE.Unavailable,
        );
        expect(toDiagnosticsPhase(STATUS_ON, true)).toBe(
            DIAGNOSTICS_PHASE.Unavailable,
        );
    });
});

describe('shouldRefetchPreview', () => {
    it('fetches the first time and whenever the revision moved', () => {
        expect(shouldRefetchPreview(null, 3)).toBe(true);
        expect(shouldRefetchPreview(3, 3)).toBe(false);
        expect(shouldRefetchPreview(3, 4)).toBe(true);
    });
});

describe('phase capabilities', () => {
    it('enables the switch only in the ready rows', () => {
        expect(canToggleDebugLogging(DIAGNOSTICS_PHASE.Loading)).toBe(false);
        expect(canToggleDebugLogging(DIAGNOSTICS_PHASE.Unavailable)).toBe(false);
        expect(canToggleDebugLogging(DIAGNOSTICS_PHASE.OffEmpty)).toBe(true);
        expect(canToggleDebugLogging(DIAGNOSTICS_PHASE.On)).toBe(true);
        expect(canToggleDebugLogging(DIAGNOSTICS_PHASE.OffStored)).toBe(true);
    });

    it('offers Copy/Download only while a log is stored', () => {
        expect(canExportDebugLog(DIAGNOSTICS_PHASE.Loading)).toBe(false);
        expect(canExportDebugLog(DIAGNOSTICS_PHASE.Unavailable)).toBe(false);
        expect(canExportDebugLog(DIAGNOSTICS_PHASE.OffEmpty)).toBe(false);
        expect(canExportDebugLog(DIAGNOSTICS_PHASE.On)).toBe(true);
        expect(canExportDebugLog(DIAGNOSTICS_PHASE.OffStored)).toBe(true);
    });
});
