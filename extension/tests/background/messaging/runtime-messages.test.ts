import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    prefsReady: vi.fn().mockResolvedValue(undefined),
    prefsLoad: vi.fn(),
    prefsSave: vi.fn().mockResolvedValue(undefined),
    sendUpdatedToAllTabs: vi.fn().mockResolvedValue(undefined),
    broadcastPrefsUpdate: vi.fn(),
    abortAll: vi.fn(),
    storeReady: vi.fn().mockResolvedValue(undefined),
    storeIsEnabled: vi.fn(() => false),
    record: vi.fn(),
}));

vi.mock('@/shared/browser', () => ({ default: { runtime: {} } }));

vi.mock('@/background/storage/prefs-sync', () => ({
    PrefsSyncStorage: {
        ready: mocks.prefsReady,
        load: mocks.prefsLoad,
        save: mocks.prefsSave,
    },
}));

vi.mock('@/background/messaging/broadcast-prefs-updated', () => ({
    PrefsBroadcast: { sendUpdatedToAllTabs: mocks.sendUpdatedToAllTabs },
}));

vi.mock('@/background/messaging/prefs-port-hub', () => ({
    PrefsPortHub: { broadcastPrefsUpdate: mocks.broadcastPrefsUpdate },
}));

vi.mock('@/background/messaging/promo-analysis', () => ({
    PromoAnalysis: { abortAll: mocks.abortAll },
}));

vi.mock('@/background/debug-log/debug-log-store', () => ({
    DebugLogStore: { ready: mocks.storeReady, isEnabled: mocks.storeIsEnabled },
}));

vi.mock('@/background/debug-log/debug-log', () => ({
    DebugLog: { record: mocks.record },
}));

import { PrefsRuntimeMessages } from '@/background/messaging/runtime-messages';
import { ANALYSIS_MODE } from '@/shared/constants';
import { DEBUG_LOG_EVENT } from '@/shared/debug-log-events';
import {
    DEFAULT_DETECTION_MODEL_ID,
    buildOpenRouterModelId,
} from '@/shared/detection-models';
import { PROVIDER_ID } from '@/shared/providers';

const PREFS = {
    enabled: true,
    providerId: PROVIDER_ID.OpenRouter,
    activeModelId: DEFAULT_DETECTION_MODEL_ID,
    analysisMode: ANALYSIS_MODE.Server,
};

describe('PrefsRuntimeMessages', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.prefsLoad.mockResolvedValue(PREFS);
        mocks.storeIsEnabled.mockReturnValue(false);
    });

    it('GET_PREFS carries the debug-log switch state beside the prefs', async () => {
        mocks.storeIsEnabled.mockReturnValue(true);
        await expect(PrefsRuntimeMessages.handleGet()).resolves.toEqual({
            ok: true,
            prefs: PREFS,
            debugLogEnabled: true,
        });
        expect(mocks.storeReady).toHaveBeenCalled();
        expect(mocks.record).not.toHaveBeenCalled();
    });

    it('GET_PREFS reports the switch off and keeps the existing failure shape', async () => {
        await expect(PrefsRuntimeMessages.handleGet()).resolves.toEqual({
            ok: true,
            prefs: PREFS,
            debugLogEnabled: false,
        });
        mocks.prefsLoad.mockRejectedValueOnce(new Error('storage'));
        await expect(PrefsRuntimeMessages.handleGet()).resolves.toEqual({
            ok: false,
            error: 'storage',
        });
    });

    it('records prefs-saved with values only after a save', async () => {
        await expect(PrefsRuntimeMessages.handleSet(false)).resolves.toEqual({ ok: true });

        expect(mocks.prefsSave).toHaveBeenCalledWith({ ...PREFS, enabled: false });
        expect(mocks.record).toHaveBeenCalledWith(DEBUG_LOG_EVENT.PrefsSaved, {
            enabled: false,
            mode: ANALYSIS_MODE.Server,
            provider: PROVIDER_ID.OpenRouter,
            model: DEFAULT_DETECTION_MODEL_ID,
        });
        expect(mocks.sendUpdatedToAllTabs).toHaveBeenCalled();
        expect(mocks.broadcastPrefsUpdate).toHaveBeenCalled();
    });

    it('never logs a custom model slug', async () => {
        mocks.prefsLoad.mockResolvedValue({
            ...PREFS,
            activeModelId: buildOpenRouterModelId('acme-corp/secret-finetune'),
        });

        await PrefsRuntimeMessages.handleSetAnalysisMode(ANALYSIS_MODE.Byok);

        expect(mocks.record).toHaveBeenCalledWith(
            DEBUG_LOG_EVENT.PrefsSaved,
            expect.objectContaining({ mode: ANALYSIS_MODE.Byok, model: 'custom' }),
        );
        expect(JSON.stringify(mocks.record.mock.calls)).not.toContain('secret-finetune');
    });
});
