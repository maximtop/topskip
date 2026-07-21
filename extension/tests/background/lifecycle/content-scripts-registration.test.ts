import { describe, expect, it, vi, beforeEach } from 'vitest';

const {
    tabsQuery,
    executeScript,
    registerContentScripts,
    unregisterContentScripts,
    prefsLoad,
} = vi.hoisted(() => ({
    tabsQuery: vi.fn().mockResolvedValue([]),
    executeScript: vi.fn().mockResolvedValue(undefined),
    registerContentScripts: vi.fn().mockResolvedValue(undefined),
    unregisterContentScripts: vi.fn().mockResolvedValue(undefined),
    prefsLoad: vi.fn(),
}));

vi.mock('@/shared/browser', () => ({
    default: {
        tabs: { query: tabsQuery },
        scripting: {
            registerContentScripts,
            unregisterContentScripts,
            executeScript,
        },
    },
}));

vi.mock('@/background/storage/prefs-sync', () => ({
    PrefsSyncStorage: {
        ready: vi.fn().mockResolvedValue(undefined),
        load: prefsLoad,
    },
}));

vi.mock('@/background/server-analysis-log', () => ({
    BackgroundServerAnalysisLog: {
        info: vi.fn(),
    },
}));

import { ContentScriptsRegistration } from '@/background/lifecycle/content-scripts-registration';
import { getWatchContentScriptMatches } from '@/shared/content-script-matches';

describe('ContentScriptsRegistration.syncFromPrefs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        tabsQuery.mockResolvedValue([]);
        executeScript.mockResolvedValue(undefined);
    });

    it('injects both bundles into already-open matching tabs when enabled', async () => {
        prefsLoad.mockResolvedValue({ enabled: true });
        tabsQuery.mockResolvedValue([{ id: 11 }, { id: 22 }]);

        await ContentScriptsRegistration.syncFromPrefs();

        expect(registerContentScripts).toHaveBeenCalledOnce();
        expect(tabsQuery).toHaveBeenCalledWith({
            url: getWatchContentScriptMatches(),
        });
        expect(executeScript).toHaveBeenCalledWith({
            target: { tabId: 11, frameIds: [0] },
            world: 'MAIN',
            files: ['caption-page-bridge.js'],
        });
        expect(executeScript).toHaveBeenCalledWith({
            target: { tabId: 11, frameIds: [0] },
            files: ['content.js'],
        });
        expect(executeScript).toHaveBeenCalledWith({
            target: { tabId: 22, frameIds: [0] },
            world: 'MAIN',
            files: ['caption-page-bridge.js'],
        });
        expect(executeScript).toHaveBeenCalledWith({
            target: { tabId: 22, frameIds: [0] },
            files: ['content.js'],
        });
        expect(executeScript).toHaveBeenCalledTimes(4);
    });

    it('skips tabs without an id and survives per-tab injection failures', async () => {
        prefsLoad.mockResolvedValue({ enabled: true });
        tabsQuery.mockResolvedValue([{ id: undefined }, { id: 1 }, { id: 2 }]);
        executeScript.mockImplementation(
            (injection: { target: { tabId: number } }) => {
                if (injection.target.tabId === 1) {
                    return Promise.reject(new Error('tab discarded'));
                }
                return Promise.resolve(undefined);
            },
        );

        await expect(
            ContentScriptsRegistration.syncFromPrefs(),
        ).resolves.toBeUndefined();

        expect(executeScript).toHaveBeenCalledWith(
            expect.objectContaining({ target: { tabId: 2, frameIds: [0] } }),
        );
    });

    it('does not query tabs or inject when disabled', async () => {
        prefsLoad.mockResolvedValue({ enabled: false });

        await ContentScriptsRegistration.syncFromPrefs();

        expect(registerContentScripts).not.toHaveBeenCalled();
        expect(unregisterContentScripts).toHaveBeenCalled();
        expect(tabsQuery).not.toHaveBeenCalled();
        expect(executeScript).not.toHaveBeenCalled();
    });
});
