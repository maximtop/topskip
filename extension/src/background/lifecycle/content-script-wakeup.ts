import * as v from 'valibot';

import { BackgroundServerAnalysisLog } from '@/background/server-analysis-log';
import browser from '@/shared/browser';
import {
    TOPSKIP_MESSAGE,
    contentScriptReadyResponseSchema,
} from '@/shared/messages';

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
     * expected for ordinary tabs and after extension updates.
     *
     * @returns Promise settled after all best-effort probes complete.
     */
    static async notifyExistingTabs(): Promise<void> {
        let tabs: Awaited<ReturnType<typeof browser.tabs.query>>;
        try {
            tabs = await browser.tabs.query({});
        } catch {
            BackgroundServerAnalysisLog.warn(
                'content-script-wakeup-query-failed',
                { reason: 'tabs-query-failed' },
            );
            return;
        }

        const tabIds = tabs.flatMap((tab) =>
            tab.id === undefined ? [] : [tab.id],
        );
        const readiness = await Promise.all(
            tabIds.map((tabId) => ContentScriptWakeup.notifyTab(tabId)),
        );
        const readyTabCount = readiness.filter(Boolean).length;
        BackgroundServerAnalysisLog.info('content-script-wakeup-complete', {
            tabCount: tabs.length,
            identifiedTabCount: tabIds.length,
            readyTabCount,
            unavailableTabCount: tabIds.length - readyTabCount,
        });
    }

    /**
     * Gives one live content context two bounded opportunities to acknowledge.
     *
     * @param tabId - Browser tab identity; its URL is deliberately not read.
     * @returns Whether the current bundle acknowledged the wake notification.
     */
    private static async notifyTab(tabId: number): Promise<boolean> {
        for (
            let attempt = 0;
            attempt < CONTENT_SCRIPT_WAKE_ATTEMPTS;
            attempt += 1
        ) {
            if (await ContentScriptWakeup.probeTab(tabId)) {
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
