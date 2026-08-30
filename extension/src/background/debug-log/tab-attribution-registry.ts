import type { Runtime } from 'webextension-polyfill/namespaces/runtime';
import type { Tabs } from 'webextension-polyfill/namespaces/tabs';
import * as v from 'valibot';

import browser from '@/shared/browser';
import { SESSION_STORAGE_KEY_DEBUG_LOG_TABS } from '@/shared/constants';
import {
    DEBUG_LOG_CEILING_WINDOW_MS,
    DEBUG_LOG_CONTENT_EVENTS_PER_TAB_PER_MINUTE,
} from '@/shared/debug-log-constants';

/**
 * Counter updates are coalesced so a busy tab does not rewrite the session
 * mirror on every accepted event; a note shares the same cadence.
 */
const TAB_ATTRIBUTION_PERSIST_DELAY_MS = 250;

const nonNegativeIntSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

/**
 * Structural check for the persisted mirror; trusted because only this
 * background registry writes the key, strict so a foreign shape is dropped.
 */
const persistedTabsSchema = v.array(
    v.tuple([
        nonNegativeIntSchema,
        v.strictObject({
            incognito: v.boolean(),
            windowStartMs: nonNegativeIntSchema,
            count: nonNegativeIntSchema,
        }),
    ]),
);

/**
 * Browser-provided incognito flag plus the content-event ceiling counters of
 * one tab; created on the tab's first message, released on tab removal.
 */
type TabAttribution = {
    incognito: boolean;
    windowStartMs: number;
    count: number;
};

/**
 * Per-tab attribution state for the debug log (incognito exclusion and the
 * per-tab content-event ceiling), mirrored in `storage.session` so it survives
 * service-worker suspension but dies with the browser or an extension reload;
 * static API only.
 */
export class TabAttributionRegistry {
    /**
     * Attribution keyed by tab id; rebuilt from the session mirror per worker.
     */
    private static readonly tabs = new Map<number, TabAttribution>();

    /**
     * Single-flight hydration from `storage.session`; `null` until first use.
     */
    private static hydration: Promise<void> | null = null;

    /**
     * Chained writes keep an older snapshot from landing after a newer one.
     */
    private static persistence: Promise<void> = Promise.resolve();

    /**
     * Pending coalesced write of counter or note changes.
     */
    private static persistTimer: ReturnType<typeof globalThis.setTimeout> | null =
        null;

    /**
     * Restores the attribution persisted before the last worker restart; the
     * removal handler and every ceiling decision await this boundary.
     *
     * @returns Promise that settles once the mirror has been merged.
     */
    static ready(): Promise<void> {
        TabAttributionRegistry.hydration ??= TabAttributionRegistry.hydrate();
        return TabAttributionRegistry.hydration;
    }

    /**
     * Records the browser-authenticated tab of a content message; the sender's
     * own fields are never consulted.
     *
     * @param sender - Browser-provided sender metadata.
     */
    static noteSender(sender: Runtime.MessageSender): void {
        if (sender.tab !== undefined) {
            TabAttributionRegistry.noteTab(sender.tab);
        }
    }

    /**
     * Creates attribution for a tab the browser described; an existing entry
     * keeps its counters because the incognito flag of a tab never changes.
     *
     * @param tab - Browser tab object from a sender or a `tabs.query` result.
     */
    static noteTab(tab: Tabs.Tab): void {
        if (tab.id === undefined || TabAttributionRegistry.tabs.has(tab.id)) {
            return;
        }
        TabAttributionRegistry.tabs.set(tab.id, {
            incognito: tab.incognito,
            windowStartMs: 0,
            count: 0,
        });
        TabAttributionRegistry.schedulePersist();
    }

    /**
     * Reads the incognito flag without I/O so the logger can gate every
     * per-tab event synchronously.
     *
     * @param tabId - Browser tab id.
     * @returns `true`/`false` for a known tab, `null` when the tab is unknown.
     */
    static isIncognitoSync(tabId: number): boolean | null {
        return TabAttributionRegistry.tabs.get(tabId)?.incognito ?? null;
    }

    /**
     * Counts the tabs that may appear in the log, for the enable snapshot.
     *
     * @returns Number of known tabs that are not incognito.
     */
    static countKnownNonIncognito(): number {
        let count = 0;
        for (const entry of TabAttributionRegistry.tabs.values()) {
            if (!entry.incognito) {
                count += 1;
            }
        }
        return count;
    }

    /**
     * Admits one content-sourced event under the per-tab ceiling of a fixed
     * one-minute window; counters reset when the window changes.
     *
     * @param tabId - Browser tab id the event is attributed to.
     * @param nowMs - Background receipt time.
     * @returns Whether the event may be logged (unknown tabs are refused).
     */
    static allowContentEvent(tabId: number, nowMs: number): boolean {
        const entry = TabAttributionRegistry.tabs.get(tabId);
        if (entry === undefined) {
            return false;
        }
        const windowStartMs = nowMs - (nowMs % DEBUG_LOG_CEILING_WINDOW_MS);
        if (entry.windowStartMs !== windowStartMs) {
            entry.windowStartMs = windowStartMs;
            entry.count = 0;
        }
        if (entry.count >= DEBUG_LOG_CONTENT_EVENTS_PER_TAB_PER_MINUTE) {
            return false;
        }
        entry.count += 1;
        TabAttributionRegistry.schedulePersist();
        return true;
    }

    /**
     * Releases a removed tab after hydration so a dead worker's mirror cannot
     * resurrect it on the next start.
     *
     * @param tabId - Removed browser tab id.
     * @returns Promise settled after the mirror reflects the removal.
     */
    static async forget(tabId: number): Promise<void> {
        await TabAttributionRegistry.ready();
        if (!TabAttributionRegistry.tabs.delete(tabId)) {
            return;
        }
        await TabAttributionRegistry.persist();
    }

    /**
     * Clears all static state between tests.
     */
    static resetForTest(): void {
        TabAttributionRegistry.clearPersistTimer();
        TabAttributionRegistry.tabs.clear();
        TabAttributionRegistry.hydration = null;
        TabAttributionRegistry.persistence = Promise.resolve();
    }

    /**
     * Coalesces rapid changes into one write per delay window.
     */
    private static schedulePersist(): void {
        if (TabAttributionRegistry.persistTimer !== null) {
            return;
        }
        TabAttributionRegistry.persistTimer = globalThis.setTimeout(() => {
            TabAttributionRegistry.persistTimer = null;
            void TabAttributionRegistry.persist();
        }, TAB_ATTRIBUTION_PERSIST_DELAY_MS);
    }

    /**
     * Drops a pending coalesced write (superseded by an explicit persist).
     */
    private static clearPersistTimer(): void {
        if (TabAttributionRegistry.persistTimer !== null) {
            globalThis.clearTimeout(TabAttributionRegistry.persistTimer);
            TabAttributionRegistry.persistTimer = null;
        }
    }

    /**
     * Mirrors the current map through a serialized queue after hydration has
     * merged, so a note made before hydration still wins over the old mirror.
     * Storage is best-effort: memory drives the current worker.
     *
     * @returns Promise that always resolves after this write attempt.
     */
    private static persist(): Promise<void> {
        TabAttributionRegistry.clearPersistTimer();
        const write = TabAttributionRegistry.persistence.then(async () => {
            await TabAttributionRegistry.ready();
            const snapshot = [...TabAttributionRegistry.tabs].map(
                ([tabId, entry]): [number, TabAttribution] => [tabId, { ...entry }],
            );
            try {
                await browser.storage.session.set({
                    [SESSION_STORAGE_KEY_DEBUG_LOG_TABS]: snapshot,
                });
            } catch {
                // Session storage unavailable: attribution stays memory-only.
            }
        });
        TabAttributionRegistry.persistence = write;
        return write;
    }

    /**
     * Loads and validates the mirror; malformed data is dropped and entries
     * already noted in this worker are kept.
     *
     * @returns Promise that settles once the map is merged.
     */
    private static async hydrate(): Promise<void> {
        let stored: unknown;
        try {
            const raw = await browser.storage.session.get(
                SESSION_STORAGE_KEY_DEBUG_LOG_TABS,
            );
            stored = Reflect.get(raw, SESSION_STORAGE_KEY_DEBUG_LOG_TABS);
        } catch {
            return;
        }
        const parsed = v.safeParse(persistedTabsSchema, stored);
        if (!parsed.success) {
            return;
        }
        for (const [tabId, entry] of parsed.output) {
            if (!TabAttributionRegistry.tabs.has(tabId)) {
                TabAttributionRegistry.tabs.set(tabId, { ...entry });
            }
        }
    }
}
