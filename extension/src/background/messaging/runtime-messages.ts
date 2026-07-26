import { getErrorMessage } from '@/shared/error';
import {
    type GetPrefsResponse,
    type SetAnalysisModeResponse,
    type SetPrefsResponse,
} from '@/shared/messages';
import type { AnalysisMode, UserPreferences } from '@/shared/constants';

import { ContentScriptsRegistration } from '@/background/lifecycle/content-scripts-registration';
import { PrefsBroadcast } from '@/background/messaging/broadcast-prefs-updated';
import { PrefsPortHub } from '@/background/messaging/prefs-port-hub';
import { PrefsSyncStorage } from '@/background/storage/prefs-sync';

/**
 * Namespace for `runtime.onMessage` prefs handling; not instantiable.
 */
export class PrefsRuntimeMessages {
    /**
     * Loads validated prefs from storage for the popup GET handler.
     *
     * @returns Current preferences
     */
    static async handleGet(): Promise<GetPrefsResponse> {
        await PrefsSyncStorage.ready();
        try {
            const prefs = await PrefsSyncStorage.load();
            return { ok: true, prefs };
        } catch (e) {
            return { ok: false, error: getErrorMessage(e) };
        }
    }

    /**
     * Writes prefs, resyncs content scripts, and broadcasts updates.
     *
     * @param enabled - New enabled state from the SET payload.
     * @returns Save result
     */
    static async handleSet(enabled: boolean): Promise<SetPrefsResponse> {
        await PrefsSyncStorage.ready();
        try {
            const current = await PrefsSyncStorage.load();
            const prefs = { ...current, enabled };
            await PrefsRuntimeMessages.saveAndBroadcast(prefs);

            await ContentScriptsRegistration.syncFromPrefs();
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
            await PrefsRuntimeMessages.saveAndBroadcast(prefs);
            return { ok: true, prefs };
        } catch (e) {
            return { ok: false, error: getErrorMessage(e) };
        }
    }

    /**
     * Preserves the required storage and dual-broadcast fan-out after every preference write.
     *
     * @param prefs - Validated preferences that replace the current snapshot.
     * @returns Promise resolved when storage and both notification paths complete.
     */
    private static async saveAndBroadcast(
        prefs: UserPreferences,
    ): Promise<void> {
        await PrefsSyncStorage.save(prefs);
        await PrefsBroadcast.sendUpdatedToAllTabs(prefs);
        PrefsPortHub.broadcastPrefsUpdate(prefs);
    }
}
