import type { Scripting } from 'webextension-polyfill/namespaces/scripting';
import * as v from 'valibot';

import browser from '@/shared/browser';
import { getWatchContentScriptMatches } from '@/shared/content-script-matches';
import {
    contentScriptReadyResponseSchema,
    TOPSKIP_MESSAGE,
} from '@/shared/messages';

import { PrefsSyncStorage } from '@/background/storage/prefs-sync';
import { BackgroundServerAnalysisLog } from '@/background/server-analysis-log';
import {
    areDefaultedValuesEqual,
    areOptionalOrderedValuesEqual,
} from '@/background/lifecycle/registration-value-comparison';

const READINESS_PROBE_ATTEMPTS = 2;
const READINESS_PROBE_TIMEOUT_MS = 150;
const READINESS_PROBE_RETRY_DELAY_MS = 50;

/**
 * Bundled files injected into the MAIN and isolated worlds.
 */
const WATCH_SCRIPT_ASSET = {
    Isolated: 'content.js',
    MainBridge: 'caption-page-bridge.js',
} as const;

/**
 * Explicit Chromium values shared by registration and probing.
 */
const CONTENT_SCRIPT_REGISTRATION_VALUE = {
    DocumentStart: 'document_start',
    MainWorld: 'MAIN',
} as const;

/**
 * Chromium defaults used when returned registration fields are omitted.
 */
const CONTENT_SCRIPT_REGISTRATION_DEFAULT = {
    World: 'ISOLATED',
    CssOrigin: 'AUTHOR',
    AllFrames: false,
    MatchOriginAsFallback: false,
    PersistAcrossSessions: true,
} as const;

/**
 * Registers or unregisters the watch `content.js` bundle based on prefs.
 */
export class ContentScriptsRegistration {
    /**
     * Stable `scripting.registerContentScripts` id for the watch bundle.
     */
    private static readonly WATCH_SCRIPT_ID = 'topskip-watch';

    /**
     * MAIN-world bridge id; separate from content.js because worlds differ.
     */
    private static readonly CAPTION_PAGE_BRIDGE_SCRIPT_ID =
        'topskip-caption-page-bridge';

    /**
     * Serializes browser scripting mutations while keeping failures isolated
     * so a later preference change can still repair registration state.
     */
    private static syncTail: Promise<void> = Promise.resolve();

    /**
     * Monotonic request identity lets in-flight startup work observe a newer
     * preference sync before it registers or injects stale bundles.
     */
    private static latestSyncId = 0;

    /**
     * Applies `enabled`: when `true`, registers YouTube (+ dev localhost)
     * matches; when `false`, unregisters.
     *
     * @returns Promise that settles when scripting APIs finish
     */
    static syncFromPrefs(): Promise<void> {
        const syncId = ContentScriptsRegistration.latestSyncId + 1;
        ContentScriptsRegistration.latestSyncId = syncId;
        const operation = ContentScriptsRegistration.syncTail
            .catch(() => {
                // A later sync must repair state even if the prior one failed.
            })
            .then(() => ContentScriptsRegistration.applyPrefs(syncId));
        ContentScriptsRegistration.syncTail = operation;
        return operation;
    }

    /**
     * Reads preferences only after earlier scripting mutations finish, then
     * applies them if no newer sync request superseded this operation.
     *
     * @param syncId - Identity captured synchronously by the public entrypoint.
     * @returns Promise settled after the latest applicable scripting work.
     */
    private static async applyPrefs(syncId: number): Promise<void> {
        await PrefsSyncStorage.ready();
        const prefs = await PrefsSyncStorage.load();
        if (!ContentScriptsRegistration.isLatestSync(syncId)) {
            return;
        }
        BackgroundServerAnalysisLog.info('content-script-sync', {
            enabled: prefs.enabled,
            analysisMode: prefs.analysisMode,
        });
        if (prefs.enabled) {
            await ContentScriptsRegistration.registerWatchScript(syncId);
        } else {
            await ContentScriptsRegistration.unregisterWatchScript(syncId);
        }
    }

    /**
     * Checks the generation without I/O so no newer event can interleave
     * between the check and the following synchronous browser API invocation.
     *
     * @param syncId - Operation identity being evaluated.
     * @returns Whether this operation still represents the newest prefs sync.
     */
    private static isLatestSync(syncId: number): boolean {
        return syncId === ContentScriptsRegistration.latestSyncId;
    }

    /**
     * Retains the current registrations, or replaces a stale or partial pair
     * before checking already-open tabs.
     *
     * @param syncId - Preference sync that authorized registration.
     * @returns Promise that settles when the script is registered
     */
    private static async registerWatchScript(syncId: number): Promise<void> {
        const matches = getWatchContentScriptMatches();
        const desired = ContentScriptsRegistration.desiredScripts(matches);
        const registered = await browser.scripting.getRegisteredContentScripts(
            { ids: ContentScriptsRegistration.scriptIds() },
        );
        if (!ContentScriptsRegistration.isLatestSync(syncId)) {
            return;
        }
        const registrationCurrent =
            registered.length === desired.length &&
            desired.every((script) =>
                registered.some((candidate) =>
                    ContentScriptsRegistration.registrationsEqual(
                        candidate,
                        script,
                    ),
                ),
            );
        if (!registrationCurrent) {
            if (registered.length > 0) {
                await ContentScriptsRegistration.removeRegisteredScripts();
                if (!ContentScriptsRegistration.isLatestSync(syncId)) {
                    return;
                }
            }
            await browser.scripting.registerContentScripts(desired);
            if (!ContentScriptsRegistration.isLatestSync(syncId)) {
                await ContentScriptsRegistration.removeRegisteredScripts();
                return;
            }
            BackgroundServerAnalysisLog.info('content-scripts-registered', {
                matchCount: matches.length,
            });
        }
        if (!ContentScriptsRegistration.isLatestSync(syncId)) {
            return;
        }
        await ContentScriptsRegistration.injectIntoExistingTabs(
            matches,
            syncId,
        );
    }

    /**
     * Defines the paired MAIN bridge and isolated watch registration from one
     * match list so drift can be detected before attempting to re-register.
     *
     * @param matches - Watch URLs accepted by both bundles.
     * @returns Current dynamic script definitions.
     */
    private static desiredScripts(
        matches: string[],
    ): Scripting.RegisteredContentScript[] {
        return [
            {
                id: ContentScriptsRegistration.CAPTION_PAGE_BRIDGE_SCRIPT_ID,
                matches,
                js: [WATCH_SCRIPT_ASSET.MainBridge],
                runAt: CONTENT_SCRIPT_REGISTRATION_VALUE.DocumentStart,
                world: CONTENT_SCRIPT_REGISTRATION_VALUE.MainWorld,
                allFrames:
                    CONTENT_SCRIPT_REGISTRATION_DEFAULT.AllFrames,
                matchOriginAsFallback:
                    CONTENT_SCRIPT_REGISTRATION_DEFAULT.MatchOriginAsFallback,
                persistAcrossSessions:
                    CONTENT_SCRIPT_REGISTRATION_DEFAULT.PersistAcrossSessions,
            },
            {
                id: ContentScriptsRegistration.WATCH_SCRIPT_ID,
                matches,
                js: [WATCH_SCRIPT_ASSET.Isolated],
                runAt: CONTENT_SCRIPT_REGISTRATION_VALUE.DocumentStart,
                allFrames:
                    CONTENT_SCRIPT_REGISTRATION_DEFAULT.AllFrames,
                matchOriginAsFallback:
                    CONTENT_SCRIPT_REGISTRATION_DEFAULT.MatchOriginAsFallback,
                persistAcrossSessions:
                    CONTENT_SCRIPT_REGISTRATION_DEFAULT.PersistAcrossSessions,
            },
        ];
    }

    /**
     * Collects the owned ids for filtered reads and removals without touching
     * unrelated dynamic registrations.
     *
     * @returns Both TopSkip watch registration ids.
     */
    private static scriptIds(): string[] {
        return [
            ContentScriptsRegistration.WATCH_SCRIPT_ID,
            ContentScriptsRegistration.CAPTION_PAGE_BRIDGE_SCRIPT_ID,
        ];
    }

    /**
     * Compares runtime-relevant registration fields while tolerating omitted
     * defaults returned by different Chromium versions.
     *
     * @param registered - Script currently known to Chromium.
     * @param desired - Script definition required by this bundle.
     * @returns Whether reinjection configuration is current.
     */
    private static registrationsEqual(
        registered: Scripting.RegisteredContentScript,
        desired: Scripting.RegisteredContentScript,
    ): boolean {
        const sameId = registered.id === desired.id;
        const sameMatches = areOptionalOrderedValuesEqual(
            registered.matches,
            desired.matches,
        );
        const sameJavaScript = areOptionalOrderedValuesEqual(
            registered.js,
            desired.js,
        );
        const sameRunAt = registered.runAt === desired.runAt;
        const sameWorld = areDefaultedValuesEqual(
            registered.world,
            desired.world,
            CONTENT_SCRIPT_REGISTRATION_DEFAULT.World,
        );
        const sameFrameScope = areDefaultedValuesEqual(
            registered.allFrames,
            desired.allFrames,
            CONTENT_SCRIPT_REGISTRATION_DEFAULT.AllFrames,
        );
        const sameOriginFallback = areDefaultedValuesEqual(
            registered.matchOriginAsFallback,
            desired.matchOriginAsFallback,
            CONTENT_SCRIPT_REGISTRATION_DEFAULT.MatchOriginAsFallback,
        );
        const samePersistence = areDefaultedValuesEqual(
            registered.persistAcrossSessions,
            desired.persistAcrossSessions,
            CONTENT_SCRIPT_REGISTRATION_DEFAULT.PersistAcrossSessions,
        );
        const sameExclusions = areOptionalOrderedValuesEqual(
            registered.excludeMatches,
            desired.excludeMatches,
        );
        const sameCss = areOptionalOrderedValuesEqual(
            registered.css,
            desired.css,
        );
        const sameCssOrigin = areDefaultedValuesEqual(
            registered.cssOrigin,
            desired.cssOrigin,
            CONTENT_SCRIPT_REGISTRATION_DEFAULT.CssOrigin,
        );

        return (
            sameId &&
            sameMatches &&
            sameJavaScript &&
            sameRunAt &&
            sameWorld &&
            sameFrameScope &&
            sameOriginFallback &&
            samePersistence &&
            sameExclusions &&
            sameCss &&
            sameCssOrigin
        );
    }

    /**
     * Injects the bundles into tabs opened before registration —
     * `registerContentScripts` only covers pages loaded afterwards. A live
     * content bundle acknowledges the probe; an invalidated or older bundle
     * is replaced through its disposable lifecycle.
     *
     * @param matches Match patterns the watch script was registered for.
     * @param syncId Preference sync that still authorizes injection.
     * @returns Promise that settles when injection attempts finish
     * (best-effort per tab).
     */
    private static async injectIntoExistingTabs(
        matches: string[],
        syncId: number,
    ): Promise<void> {
        const tabs = await browser.tabs.query({ url: matches });
        if (!ContentScriptsRegistration.isLatestSync(syncId)) {
            return;
        }
        const results = await Promise.all(
            tabs.map(async (tab) => {
                if (
                    tab.id === undefined ||
                    !ContentScriptsRegistration.isLatestSync(syncId)
                ) {
                    return false;
                }
                if (
                    await ContentScriptsRegistration.isWatchScriptReady(
                        tab.id,
                        syncId,
                    )
                ) {
                    return false;
                }
                if (!ContentScriptsRegistration.isLatestSync(syncId)) {
                    return false;
                }
                try {
                    await browser.scripting.executeScript({
                        target: { tabId: tab.id, frameIds: [0] },
                        world: CONTENT_SCRIPT_REGISTRATION_VALUE.MainWorld,
                        files: [WATCH_SCRIPT_ASSET.MainBridge],
                    });
                    if (!ContentScriptsRegistration.isLatestSync(syncId)) {
                        return false;
                    }
                    await browser.scripting.executeScript({
                        target: { tabId: tab.id, frameIds: [0] },
                        files: [WATCH_SCRIPT_ASSET.Isolated],
                    });
                    return true;
                } catch {
                    // Discarded tabs, closed tabs, etc.
                    return false;
                }
            }),
        );
        if (!ContentScriptsRegistration.isLatestSync(syncId)) {
            return;
        }
        BackgroundServerAnalysisLog.info(
            'content-scripts-injected-existing-tabs',
            {
                matchedTabCount: tabs.length,
                injectedTabCount: results.filter(Boolean).length,
            },
        );
    }

    /**
     * Gives a just-starting current bundle two bounded chances before falling
     * back to explicit injection.
     *
     * @param tabId Matching top-level tab to probe.
     * @param syncId Preference sync that still authorizes the probe.
     * @returns Whether the current content bundle acknowledged the probe.
     */
    private static async isWatchScriptReady(
        tabId: number,
        syncId: number,
    ): Promise<boolean> {
        for (let attempt = 0; attempt < READINESS_PROBE_ATTEMPTS; attempt++) {
            if (!ContentScriptsRegistration.isLatestSync(syncId)) {
                return false;
            }
            if (await ContentScriptsRegistration.probeWatchScript(tabId)) {
                return true;
            }
            if (attempt < READINESS_PROBE_ATTEMPTS - 1) {
                await ContentScriptsRegistration.waitBeforeProbeRetry();
            }
        }
        return false;
    }

    /**
     * Accepts only an acknowledgement from this extension build and protocol;
     * each message is timed out so a broken listener cannot stall startup.
     *
     * @param tabId - Matching top-level tab to probe.
     * @returns Whether the current content bundle acknowledged this attempt.
     */
    private static async probeWatchScript(tabId: number): Promise<boolean> {
        let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
        try {
            const timeout = new Promise<null>((resolve) => {
                timeoutId = globalThis.setTimeout(
                    () => resolve(null),
                    READINESS_PROBE_TIMEOUT_MS,
                );
            });
            const response: unknown = await Promise.race([
                browser.tabs.sendMessage(tabId, {
                    type: TOPSKIP_MESSAGE.CONTENT_SCRIPT_READY,
                }),
                timeout,
            ]);
            const parsed = v.safeParse(
                contentScriptReadyResponseSchema,
                response,
            );
            return (
                parsed.success &&
                parsed.output.extensionVersion ===
                    browser.runtime.getManifest().version
            );
        } catch {
            return false;
        } finally {
            if (timeoutId !== undefined) {
                globalThis.clearTimeout(timeoutId);
            }
        }
    }

    /**
     * Leaves a short scheduling gap for document-start listeners to attach
     * after a cold service-worker wake-up.
     *
     * @returns Promise resolved before the final readiness attempt.
     */
    private static waitBeforeProbeRetry(): Promise<void> {
        return new Promise((resolve) => {
            globalThis.setTimeout(resolve, READINESS_PROBE_RETRY_DELAY_MS);
        });
    }

    /**
     * Removes the watch content script id so prefs-off or reload stays clean.
     *
     * @param syncId - Preference sync that authorized removal.
     * @returns Promise that settles when unregister completes (errors ignored)
     */
    private static async unregisterWatchScript(syncId: number): Promise<void> {
        const registered = await browser.scripting.getRegisteredContentScripts({
            ids: ContentScriptsRegistration.scriptIds(),
        });
        if (
            registered.length === 0 ||
            !ContentScriptsRegistration.isLatestSync(syncId)
        ) {
            return;
        }
        await ContentScriptsRegistration.removeRegisteredScripts();
    }

    /**
     * Removes only TopSkip-owned registrations while treating concurrent
     * removal as an already-satisfied outcome.
     *
     * @returns Promise settled after the best-effort removal.
     */
    private static async removeRegisteredScripts(): Promise<void> {
        try {
            await browser.scripting.unregisterContentScripts({
                ids: ContentScriptsRegistration.scriptIds(),
            });
            BackgroundServerAnalysisLog.info('content-scripts-unregistered');
        } catch {
            // not registered
        }
    }
}
