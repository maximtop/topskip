import type { Tabs } from 'webextension-polyfill/namespaces/tabs';
import * as v from 'valibot';

import { DebugLog } from '@/background/debug-log/debug-log';
import { TabAttributionRegistry } from '@/background/debug-log/tab-attribution-registry';
import { BackgroundServerAnalysisLog } from '@/background/server-analysis-log';
import browser from '@/shared/browser';
import { DEBUG_LOG_EVENT } from '@/shared/debug-log-events';
import {
    TOPSKIP_MESSAGE,
    contentScriptReadyResponseSchema,
    type ContentScriptReadyResponse,
} from '@/shared/messages';

/**
 * Tab whose id the browser exposed; only those can be probed.
 */
type IdentifiedTab = Tabs.Tab & { id: number };

/**
 * Keeps tabs without an id out of the probe list with a narrowing filter.
 *
 * @param tab - Tab from `tabs.query`.
 * @returns Whether the tab carries an id.
 */
function hasTabId(tab: Tabs.Tab): tab is IdentifiedTab {
    return tab.id !== undefined;
}

/**
 * Two attempts tolerate document-start listeners attaching around worker wake.
 */
const CONTENT_SCRIPT_WAKE_ATTEMPTS = 2;

/**
 * One unresponsive tab cannot delay service-worker startup indefinitely.
 */
export const CONTENT_SCRIPT_WAKE_TIMEOUT_MS = 150;

/**
 * Short yield lets a newly restored content context register its listener.
 */
const CONTENT_SCRIPT_WAKE_RETRY_DELAY_MS = 50;

/**
 * Wakes already-live declarative content scripts without dynamic injection.
 */
export class ContentScriptWakeup {
    /**
     * Sends a bounded readiness notification to every identified tab.
     *
     * Failures stay inside this startup boundary because absent receivers are
     * expected for ordinary tabs and after extension updates. The aggregate
     * result is the only probe fact that reaches the debug log.
     *
     * @returns Promise settled after all best-effort probes complete.
     */
    static async notifyExistingTabs(): Promise<void> {
        let tabs: Tabs.Tab[];
        try {
            tabs = await browser.tabs.query({});
        } catch {
            BackgroundServerAnalysisLog.warn(
                'content-script-wakeup-query-failed',
                { reason: 'tabs-query-failed' },
            );
            return;
        }

        const identified = tabs.filter(hasTabId);
        const readiness = await Promise.all(
            identified.map((tab) => ContentScriptWakeup.notifyTab(tab)),
        );
        const readyTabCount = readiness.filter(Boolean).length;
        const unavailableTabCount = identified.length - readyTabCount;
        BackgroundServerAnalysisLog.info('content-script-wakeup-complete', {
            tabCount: tabs.length,
            identifiedTabCount: identified.length,
            readyTabCount,
            unavailableTabCount,
        });
        DebugLog.record(DEBUG_LOG_EVENT.WakeupProbe, {
            readyTabs: readyTabCount,
            unavailableTabs: unavailableTabCount,
        });
    }

    /**
     * Gives one live content context two bounded opportunities to acknowledge.
     * An acknowledgement is the only proof of a live content context, so only
     * then is the tab noted for attribution and its readiness logged.
     *
     * @param tab - Identified browser tab; its URL is deliberately not read.
     * @returns Whether the current bundle acknowledged the wake notification.
     */
    private static async notifyTab(tab: IdentifiedTab): Promise<boolean> {
        for (
            let attempt = 0;
            attempt < CONTENT_SCRIPT_WAKE_ATTEMPTS;
            attempt += 1
        ) {
            const ack = await ContentScriptWakeup.probeTabAck(
                tab.id,
                CONTENT_SCRIPT_WAKE_TIMEOUT_MS,
            );
            if (ack !== null) {
                // A tab whose first runtime message already reached the
                // dispatcher is known here; it logged content-ready there,
                // so the wake ack must not log it a second time.
                const firstSeen =
                    TabAttributionRegistry.isIncognitoSync(tab.id) === null;
                TabAttributionRegistry.noteTab(tab);
                if (firstSeen) {
                    DebugLog.record(
                        DEBUG_LOG_EVENT.ContentReady,
                        {
                            protocol: ack.protocolVersion,
                            extensionVersion: ack.extensionVersion,
                        },
                        { tab: tab.id },
                    );
                }
                return true;
            }
            const hasAnotherAttempt =
                attempt + 1 < CONTENT_SCRIPT_WAKE_ATTEMPTS;
            if (hasAnotherAttempt) {
                await ContentScriptWakeup.waitBeforeRetry();
            }
        }
        return false;
    }

    /**
     * Accepts acknowledgements only from this exact protocol and bundle, so an
     * orphaned context from a previous install (which Chrome cannot even
     * deliver to) and a stale bundle both read as "not live".
     *
     * @param tabId - Tab receiving the readiness notification.
     * @param timeoutMs - Bound for this single attempt; startup wakes use a
     * tight bound, while a user-driven re-attach can afford to wait longer
     * before deciding the tab needs a fresh bundle.
     * @returns Whether this single bounded attempt was acknowledged.
     */
    static async probeTab(
        tabId: number,
        timeoutMs: number = CONTENT_SCRIPT_WAKE_TIMEOUT_MS,
    ): Promise<boolean> {
        const ack = await ContentScriptWakeup.probeTabAck(tabId, timeoutMs);
        return ack !== null;
    }

    /**
     * One bounded probe returning the validated acknowledgement so the caller
     * can log the protocol it saw.
     *
     * @param tabId - Tab receiving the readiness notification.
     * @param timeoutMs - Bound for this single attempt.
     * @returns Validated current-bundle acknowledgement, or `null`.
     */
    private static async probeTabAck(
        tabId: number,
        timeoutMs: number,
    ): Promise<ContentScriptReadyResponse | null> {
        let timeoutId: ReturnType<typeof globalThis.setTimeout> | undefined;
        try {
            const timeout = new Promise<null>((resolve) => {
                timeoutId = globalThis.setTimeout(
                    () => resolve(null),
                    timeoutMs,
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
            if (!parsed.success) {
                return null;
            }
            const isCurrentBundle =
                parsed.output.extensionVersion ===
                browser.runtime.getManifest().version;
            return isCurrentBundle ? parsed.output : null;
        } catch {
            return null;
        } finally {
            if (timeoutId !== undefined) {
                globalThis.clearTimeout(timeoutId);
            }
        }
    }

    /**
     * Creates a scheduling gap without holding the worker beyond the retry.
     *
     * @returns Promise resolved when the final attempt may begin.
     */
    private static waitBeforeRetry(): Promise<void> {
        return new Promise((resolve) => {
            globalThis.setTimeout(
                resolve,
                CONTENT_SCRIPT_WAKE_RETRY_DELAY_MS,
            );
        });
    }
}
