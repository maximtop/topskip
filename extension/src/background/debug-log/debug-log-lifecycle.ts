import { DebugLog } from '@/background/debug-log/debug-log';
import { DebugLogBroadcast } from '@/background/debug-log/debug-log-broadcast';
import { EnvironmentProbe } from '@/background/debug-log/debug-log-export';
import { DebugLogStore } from '@/background/debug-log/debug-log-store';
import { TabAttributionRegistry } from '@/background/debug-log/tab-attribution-registry';
import browser from '@/shared/browser';
import { SESSION_STORAGE_KEY_DEBUG_LOG_WORKER } from '@/shared/constants';
import { DEBUG_LOG_EVENT, type DebugLogFields } from '@/shared/debug-log-events';
import type { DebugLogStatusPayload } from '@/shared/messages';

/**
 * Written as `previousBuild` when no label was persisted by an earlier start.
 */
const UNKNOWN_BUILD_LABEL = 'unknown';

/**
 * Install reasons that mark an extension restart; browser-update and
 * shared-module reasons produce no marker of their own.
 */
const EXTENSION_RESTART_REASONS: ReadonlySet<string> = new Set(['install', 'update']);

/**
 * A browser signal observed before or after the worker-started marker.
 */
type RestartCause =
    | { kind: 'browser' }
    | { kind: 'extension'; reason: string };

/**
 * Owns the worker/browser/extension lifecycle markers and the logger's own
 * enable/disable markers. Listeners are registered synchronously at worker
 * start; markers are logged by observable cause only, never inferred from the
 * build label. Static API only.
 */
export class DebugLogLifecycle {
    /**
     * Whether the worker-started marker has been logged in this lifetime.
     */
    private static started = false;

    /**
     * Current build label once the worker start completed.
     */
    private static buildLabel: string | null = null;

    /**
     * Label persisted by the previous worker start, read before overwriting.
     */
    private static previousBuild: string | null = null;

    /**
     * Signals that arrived before the worker-started marker.
     */
    private static readonly pendingCauses: RestartCause[] = [];

    /**
     * Adds the profile-startup and install/update listeners; must run
     * synchronously inside `Background.init` before any await.
     */
    static register(): void {
        browser.runtime.onStartup.addListener(() => {
            DebugLogLifecycle.onCause({ kind: 'browser' });
        });
        browser.runtime.onInstalled.addListener((details) => {
            if (!EXTENSION_RESTART_REASONS.has(details.reason)) {
                return;
            }
            DebugLogLifecycle.onCause({ kind: 'extension', reason: details.reason });
        });
    }

    /**
     * Completes a worker start: detects a lost session (first start in this
     * browser session), applies the dev default exactly like a user "on",
     * logs worker-started, flushes early signals, persists the label and
     * opens the facade. Never rejects.
     *
     * @param buildLabel - Current build label.
     * @returns Promise settled when the start markers are recorded.
     */
    static async markWorkerStarted(buildLabel: string): Promise<void> {
        try {
            await DebugLogStore.ready();
            await TabAttributionRegistry.ready();
            const first = await DebugLogLifecycle.claimSessionMarker();
            if (first) {
                DebugLogLifecycle.markSessionStateLost();
            }
            if (DebugLogStore.consumePendingDefaultEnable()) {
                await DebugLogLifecycle.enableByDefault();
            }
            DebugLogLifecycle.previousBuild = DebugLogStore.getLastBuildLabel();
            DebugLogLifecycle.buildLabel = buildLabel;
            DebugLog.record(DEBUG_LOG_EVENT.WorkerStarted, { build: buildLabel, first });
            DebugLogLifecycle.started = true;
            for (const cause of DebugLogLifecycle.pendingCauses.splice(0)) {
                DebugLogLifecycle.logCause(cause);
            }
            await DebugLogStore.setLastBuildLabel(buildLabel);
        } catch {
            // Startup diagnostics never break the worker.
        } finally {
            DebugLog.open();
        }
    }

    /**
     * Tells the facade that no session-scoped state survived.
     */
    static markSessionStateLost(): void {
        DebugLog.markSessionStateLost();
    }

    /**
     * Turns logging on and writes the `logging-enabled` snapshot as the first
     * line of the fresh log; idempotent through the store.
     *
     * @param nowMs - Enable time.
     * @returns Status after the change.
     */
    static async enable(nowMs: number): Promise<DebugLogStatusPayload> {
        const fields = await DebugLogLifecycle.collectLoggingEnabledFields();
        return DebugLogStore.enable(nowMs, () => {
            // Events emitted while no log existed are dropped, exactly as a
            // user "on" would not have captured them; with the facade open
            // the queue is already empty.
            DebugLog.discardQueued();
            DebugLog.record(DEBUG_LOG_EVENT.LoggingEnabled, fields);
        });
    }

    /**
     * Writes the `logging-disabled` terminal marker and turns logging off;
     * idempotent through the store.
     *
     * @param nowMs - Disable time.
     * @returns Status after the change.
     */
    static disable(nowMs: number): Promise<DebugLogStatusPayload> {
        return DebugLogStore.disable(nowMs, () => {
            DebugLog.record(DEBUG_LOG_EVENT.LoggingDisabled, { enabled: false });
        });
    }

    /**
     * Clears all static state between tests.
     */
    static resetForTest(): void {
        DebugLogLifecycle.started = false;
        DebugLogLifecycle.buildLabel = null;
        DebugLogLifecycle.previousBuild = null;
        DebugLogLifecycle.pendingCauses.length = 0;
    }

    /**
     * Dev default, applied exactly like a user "on" including the state push
     * (content contexts that bootstrapped before this point learned "off");
     * the store stays off when the snapshot cannot be built and the user can
     * still enable it from Options.
     *
     * @returns Promise that always resolves.
     */
    private static async enableByDefault(): Promise<void> {
        try {
            const status = await DebugLogLifecycle.enable(Date.now());
            if (status.enabled) {
                await DebugLogBroadcast.notifyStateChanged(true);
            }
        } catch {
            // Reported by the Options state, not by the console.
        }
    }

    /**
     * Snapshot fields of the `logging-enabled` marker.
     *
     * @returns Enabled flag, analysis mode, provider, model, locale, live tabs.
     */
    private static async collectLoggingEnabledFields(): Promise<DebugLogFields> {
        const env = await EnvironmentProbe.collect();
        return {
            enabled: true,
            mode: env.analysisMode,
            provider: env.providerId,
            model: env.modelId,
            locale: env.locale,
            liveTabs: TabAttributionRegistry.countKnownNonIncognito(),
        };
    }

    /**
     * Reads then writes the session marker; an unreadable session counts as
     * "first" because nothing proves a previous worker ran.
     *
     * @returns Whether no marker from a previous worker existed.
     */
    private static async claimSessionMarker(): Promise<boolean> {
        let first: boolean;
        try {
            const raw = await browser.storage.session.get(
                SESSION_STORAGE_KEY_DEBUG_LOG_WORKER,
            );
            first = Reflect.get(raw, SESSION_STORAGE_KEY_DEBUG_LOG_WORKER) === undefined;
        } catch {
            first = true;
        }
        try {
            await browser.storage.session.set({
                [SESSION_STORAGE_KEY_DEBUG_LOG_WORKER]: { startedAtMs: Date.now() },
            });
        } catch {
            // Session storage unavailable: the next start reads "first" again.
        }
        return first;
    }

    /**
     * Logs a signal now or holds it until the worker-started marker is out.
     *
     * @param cause - Observed signal.
     */
    private static onCause(cause: RestartCause): void {
        if (!DebugLogLifecycle.started) {
            DebugLogLifecycle.pendingCauses.push(cause);
            return;
        }
        DebugLogLifecycle.logCause(cause);
    }

    /**
     * Writes the specific marker for one signal; a same-version reload arrives
     * as `update`, and the persisted label keeps `previousBuild → newBuild`
     * meaningful even then.
     *
     * @param cause - Observed signal.
     */
    private static logCause(cause: RestartCause): void {
        const build = DebugLogLifecycle.buildLabel ?? UNKNOWN_BUILD_LABEL;
        if (cause.kind === 'browser') {
            DebugLog.record(DEBUG_LOG_EVENT.BrowserRestarted, { build });
            return;
        }
        DebugLog.record(DEBUG_LOG_EVENT.ExtensionRestarted, {
            previousBuild: DebugLogLifecycle.previousBuild ?? UNKNOWN_BUILD_LABEL,
            newBuild: build,
            cause: cause.reason,
        });
    }
}
