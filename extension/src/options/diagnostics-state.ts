import type { DebugLogStatusPayload } from '@/shared/messages';

/**
 * Rows of the Diagnostics state matrix. The switch, counters, preview and
 * export buttons all key off this one value so no two controls can disagree
 * about the background state.
 */
export const DIAGNOSTICS_PHASE = {
    Loading: 'loading',
    Unavailable: 'unavailable',
    OffEmpty: 'off-empty',
    On: 'on',
    OffStored: 'off-stored',
} as const;

/**
 * One row of the Diagnostics state matrix.
 */
export type DiagnosticsPhase =
    (typeof DIAGNOSTICS_PHASE)[keyof typeof DIAGNOSTICS_PHASE];

/**
 * Resolves the section phase from the last status read and transport
 * health. A failed read wins over a stale status so the switch is disabled
 * instead of acting on state the background may no longer hold.
 *
 * @param status - Last validated status, or `null` before the first read.
 * @param unavailable - Whether the latest read failed or timed out.
 * @returns Phase to render.
 */
export function toDiagnosticsPhase(
    status: DebugLogStatusPayload | null,
    unavailable: boolean,
): DiagnosticsPhase {
    if (unavailable) {
        return DIAGNOSTICS_PHASE.Unavailable;
    }
    if (status === null) {
        return DIAGNOSTICS_PHASE.Loading;
    }
    if (status.enabled) {
        return DIAGNOSTICS_PHASE.On;
    }
    return status.hasLog
        ? DIAGNOSTICS_PHASE.OffStored
        : DIAGNOSTICS_PHASE.OffEmpty;
}

/**
 * The preview tail is re-read only when the store revision moved, so the
 * status cadence never carries the tail (or the bundle).
 *
 * @param prevRevision - Revision of the last preview shown, or `null`.
 * @param nextRevision - Revision reported by the latest status read.
 * @returns Whether to request the preview tail.
 */
export function shouldRefetchPreview(
    prevRevision: number | null,
    nextRevision: number,
): boolean {
    return prevRevision === null || prevRevision !== nextRevision;
}

/**
 * The switch is interactive only when a status is known and the background is
 * reachable; otherwise a flip could act on stale state.
 *
 * @param phase - Current phase.
 * @returns Whether the switch may be toggled.
 */
export function canToggleDebugLogging(phase: DiagnosticsPhase): boolean {
    return (
        phase === DIAGNOSTICS_PHASE.On ||
        phase === DIAGNOSTICS_PHASE.OffStored ||
        phase === DIAGNOSTICS_PHASE.OffEmpty
    );
}

/**
 * Copy/Download, counters and the preview exist only while a log is stored.
 *
 * @param phase - Current phase.
 * @returns Whether export controls are available.
 */
export function canExportDebugLog(phase: DiagnosticsPhase): boolean {
    return (
        phase === DIAGNOSTICS_PHASE.On || phase === DIAGNOSTICS_PHASE.OffStored
    );
}
