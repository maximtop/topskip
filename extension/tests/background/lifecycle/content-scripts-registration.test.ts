import { describe, expect, it, vi, beforeEach } from 'vitest';

const {
    tabsQuery,
    tabsSendMessage,
    executeScript,
    getRegisteredContentScripts,
    registerContentScripts,
    unregisterContentScripts,
    prefsLoad,
} = vi.hoisted(() => ({
    tabsQuery: vi.fn().mockResolvedValue([]),
    tabsSendMessage: vi.fn().mockRejectedValue(new Error('no receiver')),
    executeScript: vi.fn().mockResolvedValue(undefined),
    getRegisteredContentScripts: vi.fn().mockResolvedValue([]),
    registerContentScripts: vi.fn().mockResolvedValue(undefined),
    unregisterContentScripts: vi.fn().mockResolvedValue(undefined),
    prefsLoad: vi.fn(),
}));

vi.mock('@/shared/browser', () => ({
    default: {
        runtime: {
            getManifest: vi.fn(() => ({ version: '0.1.0' })),
        },
        tabs: { query: tabsQuery, sendMessage: tabsSendMessage },
        scripting: {
            getRegisteredContentScripts,
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
import { CONTENT_SCRIPT_PROTOCOL_VERSION } from '@/shared/messages';

const EXTENSION_VERSION = '0.1.0';

/**
 * Builds the two registrations expected for the current watch bundles.
 *
 * @returns Current dynamic content-script registrations.
 */
function currentRegistrations(): Array<Record<string, unknown>> {
    const matches = getWatchContentScriptMatches();
    return [
        {
            id: 'topskip-caption-page-bridge',
            matches,
            js: ['caption-page-bridge.js'],
            runAt: 'document_start',
            world: 'MAIN',
        },
        {
            id: 'topskip-watch',
            matches,
            js: ['content.js'],
            runAt: 'document_start',
        },
    ];
}

/**
 * Returns the versioned acknowledgement emitted by the current content bundle.
 *
 * @returns Current readiness response.
 */
function currentReadinessResponse(): Record<string, unknown> {
    return {
        ok: true,
        protocolVersion: CONTENT_SCRIPT_PROTOCOL_VERSION,
        extensionVersion: EXTENSION_VERSION,
    };
}

describe('ContentScriptsRegistration.syncFromPrefs', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        tabsQuery.mockResolvedValue([]);
        tabsSendMessage.mockRejectedValue(new Error('no receiver'));
        executeScript.mockResolvedValue(undefined);
        getRegisteredContentScripts.mockResolvedValue([]);
        registerContentScripts.mockResolvedValue(undefined);
        unregisterContentScripts.mockResolvedValue(undefined);
    });

    it('does not reinject a watch script that acknowledges the readiness probe', async () => {
        prefsLoad.mockResolvedValue({ enabled: true });
        tabsQuery.mockResolvedValue([{ id: 11 }]);
        tabsSendMessage.mockResolvedValue(currentReadinessResponse());

        await ContentScriptsRegistration.syncFromPrefs();

        expect(tabsSendMessage).toHaveBeenCalledWith(11, {
            type: 'TOPSKIP_CONTENT_SCRIPT_READY',
        });
        expect(executeScript).not.toHaveBeenCalled();
    });

    it('keeps current dynamic registrations instead of replacing them', async () => {
        prefsLoad.mockResolvedValue({ enabled: true });
        getRegisteredContentScripts.mockResolvedValue(currentRegistrations());

        await ContentScriptsRegistration.syncFromPrefs();

        expect(unregisterContentScripts).not.toHaveBeenCalled();
        expect(registerContentScripts).not.toHaveBeenCalled();
    });

    it('replaces a stale partial registration once', async () => {
        prefsLoad.mockResolvedValue({ enabled: true });
        getRegisteredContentScripts.mockResolvedValue([
            {
                id: 'topskip-watch',
                matches: ['https://example.com/*'],
                js: ['old-content.js'],
                runAt: 'document_idle',
            },
        ]);

        await ContentScriptsRegistration.syncFromPrefs();

        expect(unregisterContentScripts).toHaveBeenCalledOnce();
        expect(registerContentScripts).toHaveBeenCalledOnce();
    });

    it.each([
        ['all-frame injection', { allFrames: true }],
        ['non-persistent registration', { persistAcrossSessions: false }],
    ])('replaces stale %s settings', async (_label, staleFields) => {
        prefsLoad.mockResolvedValue({ enabled: true });
        const registrations = currentRegistrations();
        const watch = registrations.find(
            (script) => script.id === 'topskip-watch',
        );
        if (watch === undefined) {
            throw new Error('Expected watch registration fixture.');
        }
        Object.assign(watch, staleFields);
        getRegisteredContentScripts.mockResolvedValue(registrations);

        await ContentScriptsRegistration.syncFromPrefs();

        expect(unregisterContentScripts).toHaveBeenCalledOnce();
        expect(registerContentScripts).toHaveBeenCalledOnce();
    });

    it('allows a second bounded readiness probe before injecting', async () => {
        prefsLoad.mockResolvedValue({ enabled: true });
        tabsQuery.mockResolvedValue([{ id: 11 }]);
        tabsSendMessage
            .mockRejectedValueOnce(new Error('worker still starting'))
            .mockResolvedValueOnce(currentReadinessResponse());

        await ContentScriptsRegistration.syncFromPrefs();

        expect(tabsSendMessage).toHaveBeenCalledTimes(2);
        expect(executeScript).not.toHaveBeenCalled();
    });

    it('reinjects after two acknowledgements from an older bundle', async () => {
        prefsLoad.mockResolvedValue({ enabled: true });
        tabsQuery.mockResolvedValue([{ id: 11 }]);
        tabsSendMessage.mockResolvedValue({
            ok: true,
            protocolVersion: CONTENT_SCRIPT_PROTOCOL_VERSION,
            extensionVersion: '0.0.9',
        });

        await ContentScriptsRegistration.syncFromPrefs();

        expect(tabsSendMessage).toHaveBeenCalledTimes(2);
        expect(executeScript).toHaveBeenCalledTimes(2);
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
        getRegisteredContentScripts.mockResolvedValue(currentRegistrations());

        await ContentScriptsRegistration.syncFromPrefs();

        expect(registerContentScripts).not.toHaveBeenCalled();
        expect(unregisterContentScripts).toHaveBeenCalled();
        expect(tabsQuery).not.toHaveBeenCalled();
        expect(executeScript).not.toHaveBeenCalled();
    });

    it('lets a concurrent disable cancel stale startup registration', async () => {
        const registeredScripts: Array<Record<string, unknown>> = [];
        let resolveStartupRead = (
            _scripts: Array<Record<string, unknown>>,
        ): void => undefined;
        const startupRead = new Promise<Array<Record<string, unknown>>>(
            (resolve) => {
                resolveStartupRead = resolve;
            },
        );
        prefsLoad
            .mockResolvedValueOnce({ enabled: true })
            .mockResolvedValue({ enabled: false });
        getRegisteredContentScripts
            .mockReturnValueOnce(startupRead)
            .mockImplementation(() => Promise.resolve(registeredScripts));
        registerContentScripts.mockImplementation(
            (scripts: Array<Record<string, unknown>>) => {
                registeredScripts.splice(
                    0,
                    registeredScripts.length,
                    ...structuredClone(scripts),
                );
                return Promise.resolve();
            },
        );
        unregisterContentScripts.mockImplementation(() => {
            registeredScripts.splice(0, registeredScripts.length);
            return Promise.resolve();
        });
        tabsQuery.mockResolvedValue([{ id: 11 }]);

        const startupSync = ContentScriptsRegistration.syncFromPrefs();
        await vi.waitFor(() => {
            expect(getRegisteredContentScripts).toHaveBeenCalledOnce();
        });
        const disableSync = ContentScriptsRegistration.syncFromPrefs();
        await new Promise<void>((resolve) => {
            globalThis.setTimeout(resolve, 0);
        });
        resolveStartupRead([]);
        await Promise.all([startupSync, disableSync]);

        expect(prefsLoad).toHaveBeenCalledTimes(2);
        expect(getRegisteredContentScripts).toHaveBeenCalledTimes(2);
        expect(registeredScripts).toEqual([]);
        expect(executeScript).not.toHaveBeenCalled();
    });
});
