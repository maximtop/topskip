import { ContentScriptWakeup } from '@/background/lifecycle/content-script-wakeup';
import { BackgroundServerAnalysisLog } from '@/background/server-analysis-log';
import browser from '@/shared/browser';
import { CAPTION_PAGE_BRIDGE_INSTALL_FLAG } from '@/shared/caption-page-bridge-flags';
import { CONTENT_SCRIPT_BUNDLE } from '@/shared/content-script-bundles';
import { getErrorMessage } from '@/shared/error';
import { MS_PER_SECOND } from '@/shared/constants';
import {
    CONTENT_SCRIPT_REATTACH_OUTCOME,
    type ReattachContentScriptResponse,
} from '@/shared/messages';
import { isTopSkipContentDocumentUrl } from '@/shared/watch-route';

/**
 * A live watch script answers within milliseconds; the bound only matters
 * when a tab is frozen, and a false "dead" verdict would replace a healthy
 * context mid-analysis, so it is far looser than the startup wake bound.
 */
export const CONTENT_SCRIPT_REATTACH_PROBE_TIMEOUT_MS = MS_PER_SECOND;

/**
 * An orphaned bundle notices its severed runtime within one poll tick and then
 * retires its own MAIN bridge. Injecting a replacement bridge before that lands
 * would let the orphan's `teardown` retire the new bridge instead, so the
 * background waits for the orphan to finish, bounded so a pre-teardown bundle
 * (which never clears the flag) cannot block re-attach forever.
 */
export const CONTENT_SCRIPT_REATTACH_SETTLE_TIMEOUT_MS = 3 * MS_PER_SECOND;

/**
 * Settle polls are cheap MAIN-world reads, so a short gap keeps the visible
 * re-attach delay close to the orphan's own teardown latency.
 */
export const CONTENT_SCRIPT_REATTACH_SETTLE_POLL_MS = 100;

/**
 * Active tab identity plus whatever URL Chrome chose to expose for it.
 */
type ActiveTabTarget = {
    tabId: number;
    url: string | undefined;
};

/**
 * Re-injects the two watch bundles into the active tab on the user's request.
 *
 * Declarative content scripts run only at document load, so a YouTube tab
 * opened before an install/update/reload has no live content context until
 * it is reloaded. Opening the popup is a user gesture that grants `activeTab`
 * for that tab alone, which is what makes its URL readable and programmatic
 * injection allowed without a required YouTube host. Static API only.
 */
export class ContentScriptReattach {
    /**
     * Two popup opens in quick succession must not inject twice.
     */
    private static readonly inFlight = new Map<
        number,
        Promise<ReattachContentScriptResponse>
    >();

    /**
     * Resolves the active tab and re-attaches only when it is a supported
     * document without a live current-bundle context.
     *
     * A hidden URL means Chrome did not grant `activeTab` for this tab; the
     * background never injects blind, because the grant is the only proof
     * that the user invoked TopSkip on that tab.
     *
     * @returns Outcome for the popup; `ok: false` only for an API failure.
     */
    static async handleRequest(): Promise<ReattachContentScriptResponse> {
        let target: ActiveTabTarget | null;
        try {
            target = await ContentScriptReattach.resolveActiveTab();
        } catch (e) {
            return { ok: false, error: getErrorMessage(e) };
        }
        if (target === null) {
            return {
                ok: true,
                tabId: null,
                outcome: CONTENT_SCRIPT_REATTACH_OUTCOME.NoActiveTab,
            };
        }
        const { tabId, url } = target;
        if (url === undefined) {
            return {
                ok: true,
                tabId,
                outcome: CONTENT_SCRIPT_REATTACH_OUTCOME.UrlUnavailable,
            };
        }
        if (!isTopSkipContentDocumentUrl(url)) {
            return {
                ok: true,
                tabId,
                outcome: CONTENT_SCRIPT_REATTACH_OUTCOME.UnsupportedPage,
            };
        }
        const pending = ContentScriptReattach.inFlight.get(tabId);
        if (pending !== undefined) {
            return pending;
        }
        const run = ContentScriptReattach.reattachTab(tabId).finally(() => {
            ContentScriptReattach.inFlight.delete(tabId);
        });
        ContentScriptReattach.inFlight.set(tabId, run);
        return run;
    }

    /**
     * Reads the frontmost tab of the current window the same way the popup's
     * detection status does, so both describe the same tab.
     *
     * @returns Tab identity and exposed URL, or `null` without an active tab.
     */
    private static async resolveActiveTab(): Promise<ActiveTabTarget | null> {
        const tabs = await browser.tabs.query({
            active: true,
            currentWindow: true,
        });
        const [first] = tabs;
        if (first?.id === undefined) {
            return null;
        }
        return { tabId: first.id, url: first.url };
    }

    /**
     * Probes for a live current bundle first so a healthy tab is left alone,
     * then injects MAIN before ISOLATED exactly like the static manifest so
     * the watch script finds its bridge when capture begins.
     *
     * @param tabId - Active tab whose URL is a supported content document.
     * @returns Re-attach outcome or the injection failure.
     */
    private static async reattachTab(
        tabId: number,
    ): Promise<ReattachContentScriptResponse> {
        const isLive = await ContentScriptWakeup.probeTab(
            tabId,
            CONTENT_SCRIPT_REATTACH_PROBE_TIMEOUT_MS,
        );
        if (isLive) {
            return {
                ok: true,
                tabId,
                outcome: CONTENT_SCRIPT_REATTACH_OUTCOME.AlreadyAttached,
            };
        }
        try {
            await ContentScriptReattach.waitForOrphanTeardown(tabId);
            await browser.scripting.executeScript({
                target: { tabId },
                files: [CONTENT_SCRIPT_BUNDLE.MainBridge],
                world: 'MAIN',
            });
            await browser.scripting.executeScript({
                target: { tabId },
                files: [CONTENT_SCRIPT_BUNDLE.IsolatedWatch],
                world: 'ISOLATED',
            });
        } catch (e) {
            const error = getErrorMessage(e);
            BackgroundServerAnalysisLog.warn('content-script-reattach-failed', {
                tabId,
                error,
            });
            return { ok: false, error };
        }
        BackgroundServerAnalysisLog.info('content-script-reattached', {
            tabId,
        });
        return {
            ok: true,
            tabId,
            outcome: CONTENT_SCRIPT_REATTACH_OUTCOME.Reattached,
        };
    }

    /**
     * Polls the page's bridge install flag until an orphaned bundle has
     * retired its MAIN bridge, or the bounded settle window elapses.
     *
     * The flag is read with a MAIN-world function because only that world can
     * see the bridge's page globals; the function receives the flag name and
     * returns a boolean, nothing else crosses the boundary.
     *
     * @param tabId - Tab about to receive fresh bundles.
     * @returns Promise settled once injection may proceed.
     */
    private static async waitForOrphanTeardown(tabId: number): Promise<void> {
        const deadline = Date.now() + CONTENT_SCRIPT_REATTACH_SETTLE_TIMEOUT_MS;
        while (await ContentScriptReattach.isBridgeInstalled(tabId)) {
            if (Date.now() >= deadline) {
                BackgroundServerAnalysisLog.warn(
                    'content-script-reattach-settle-timeout',
                    { tabId },
                );
                return;
            }
            await ContentScriptReattach.delay(
                CONTENT_SCRIPT_REATTACH_SETTLE_POLL_MS,
            );
        }
    }

    /**
     * Reads whether any MAIN bridge generation still claims the document.
     *
     * @param tabId - Tab whose main frame is inspected.
     * @returns Whether the bridge install flag is currently `true`.
     */
    private static async isBridgeInstalled(tabId: number): Promise<boolean> {
        const results = await browser.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: (flag: unknown): boolean =>
                typeof flag === 'string' &&
                Reflect.get(globalThis, flag) === true,
            args: [CAPTION_PAGE_BRIDGE_INSTALL_FLAG],
        });
        const [mainFrame] = results;
        return mainFrame?.result === true;
    }

    /**
     * Yields without holding the worker beyond the requested gap.
     *
     * @param ms - Delay before the next settle poll.
     * @returns Promise resolved after the delay.
     */
    private static delay(ms: number): Promise<void> {
        return new Promise((resolve) => {
            globalThis.setTimeout(resolve, ms);
        });
    }
}
