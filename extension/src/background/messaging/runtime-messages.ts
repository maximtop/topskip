import { getErrorMessage } from '@/shared/error';
import {
    type GetPrefsResponse,
    type SetAnalysisModeResponse,
    type SetPrefsResponse,
} from '@/shared/messages';
import {
    ANALYSIS_MODE,
    type AnalysisMode,
    type UserPreferences,
} from '@/shared/constants';
import { DEBUG_LOG_EVENT } from '@/shared/debug-log-events';
import { toDebugLogModelId } from '@/shared/detection-models';

import { DebugLog } from '@/background/debug-log/debug-log';
import { DebugLogStore } from '@/background/debug-log/debug-log-store';
import { PrefsBroadcast } from '@/background/messaging/broadcast-prefs-updated';
import { PrefsPortHub } from '@/background/messaging/prefs-port-hub';
import { PromoAnalysis } from '@/background/messaging/promo-analysis';
import { PrefsSyncStorage } from '@/background/storage/prefs-sync';

/**
 * Namespace for `runtime.onMessage` prefs handling; not instantiable.
 */
export class PrefsRuntimeMessages {
    /**
     * Loads validated prefs from storage for the popup and content bootstrap;
     * the debug-log switch state rides along so a content context learns it
     * before its first loggable decision.
     *
     * @returns Current preferences plus the debug-log switch state
     */
    static async handleGet(): Promise<GetPrefsResponse> {
        await PrefsSyncStorage.ready();
        try {
            const prefs = await PrefsSyncStorage.load();
            await DebugLogStore.ready();
            return { ok: true, prefs, debugLogEnabled: DebugLogStore.isEnabled() };
        } catch (e) {
            return { ok: false, error: getErrorMessage(e) };
        }
    }

    /**
     * Writes prefs and broadcasts updates to declarative content contexts.
     *
     * @param enabled - New enabled state from the SET payload.
     * @returns Save result
     */
    static async handleSet(enabled: boolean): Promise<SetPrefsResponse> {
        await PrefsSyncStorage.ready();
        try {
            const current = await PrefsSyncStorage.load();
            const prefs = { ...current, enabled };
            PrefsRuntimeMessages.abortSupersededLocalAnalysis(current, prefs);
            await PrefsRuntimeMessages.saveAndBroadcast(prefs);

            return { ok: true };
        } catch (e) {
            return { ok: false, error: getErrorMessage(e) };
        }
    }

    /**
     * Changes the analysis route while retaining the user's provider setup.
     *
     * @param analysisMode - Route selected in extension settings.
     * @returns Saved preference snapshot or a normalized persistence error.
     */
    static async handleSetAnalysisMode(
        analysisMode: AnalysisMode,
    ): Promise<SetAnalysisModeResponse> {
        await PrefsSyncStorage.ready();
        try {
            const current = await PrefsSyncStorage.load();
            const prefs = { ...current, analysisMode };
            PrefsRuntimeMessages.abortSupersededLocalAnalysis(current, prefs);
            await PrefsRuntimeMessages.saveAndBroadcast(prefs);
            return { ok: true, prefs };
        } catch (e) {
            return { ok: false, error: getErrorMessage(e) };
        }
    }

    /**
     * Preserves the required storage and dual-broadcast fan-out after every
     * preference write and records the saved values (never keys) for support.
     *
     * @param prefs - Validated preferences that replace the current snapshot.
     * @returns Promise resolved when storage and both notification paths complete.
     */
    private static async saveAndBroadcast(
        prefs: UserPreferences,
    ): Promise<void> {
        await PrefsSyncStorage.save(prefs);
        DebugLog.record(DEBUG_LOG_EVENT.PrefsSaved, {
            enabled: prefs.enabled,
            mode: prefs.analysisMode,
            provider: prefs.providerId,
            model: toDebugLogModelId(prefs.providerId, prefs.activeModelId),
        });
        await PrefsBroadcast.sendUpdatedToAllTabs(prefs);
        PrefsPortHub.broadcastPrefsUpdate(prefs);
    }

    /**
     * Aborts the old BYOK owner before persistence and fan-out can later
     * re-enable the same video under an indistinguishable content payload.
     *
     * @param current - Persisted route that may own provider work.
     * @param next - Preference snapshot about to replace it.
     */
    private static abortSupersededLocalAnalysis(
        current: UserPreferences,
        next: UserPreferences,
    ): void {
        const localAnalysisWasActive =
            current.enabled && current.analysisMode === ANALYSIS_MODE.Byok;
        const localAnalysisRemainsActive =
            next.enabled && next.analysisMode === ANALYSIS_MODE.Byok;
        if (localAnalysisWasActive && !localAnalysisRemainsActive) {
            PromoAnalysis.abortAll();
        }
    }
}
