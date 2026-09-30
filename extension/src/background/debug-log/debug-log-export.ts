/**
 * @file Renders the plain-text debug log export bundle from a store
 * snapshot; environment facts are collected by `EnvironmentProbe`.
 */

import { ANALYSIS_MODE } from '@/shared/constants';
import { formatLogFields } from '@/shared/log-fields';

import type { DebugLogSnapshot } from '@/background/debug-log/debug-log-store';

/**
 * Written when a fact could not be read; never a free-form error.
 */
export const UNKNOWN_VALUE = 'unknown';

/**
 * Written for an absent timestamp.
 */
const NONE_VALUE = 'none';

/**
 * First header line of every bundle.
 */
export const DEBUG_LOG_BUNDLE_TITLE = 'TopSkip debug log';

/**
 * Content notice carried by every export (English, not localized).
 */
export const DEBUG_LOG_BUNDLE_NOTICE = 'Notice: this log lists the YouTube video IDs you watched while Debug '
    + 'logging was on, with times and tab numbers, plus your extension and '
    + 'browser version, OS family, UI language, analysis mode and model. It '
    + 'never contains captions, transcripts, keys, tokens, cookies or URLs. '
    + 'Incognito windows are not logged. Review it before sharing.';

/**
 * Separates the header from the event lines.
 */
export const DEBUG_LOG_BUNDLE_EVENTS_MARKER = '--- events ---';

/**
 * Facts written into the export header and the enable snapshot.
 */
export interface DebugLogEnvironment {
    /**
     * Extension build label, or `unknown` when the manifest cannot be read.
     */
    extensionBuild: string;

    /**
     * Browser major version, or `null` when it could not be determined.
     */
    browserMajor: number | null;

    /**
     * OS family reported by the platform-info API, or `unknown`.
     */
    osFamily: string;

    /**
     * Browser UI language tag, or `unknown` when unreadable or malformed.
     */
    locale: string;

    /**
     * Active analysis route (`server` or `byok`), or `unknown`.
     */
    analysisMode: string;

    /**
     * Active provider id, or `unknown` when preferences could not be read.
     */
    providerId: string;

    /**
     * Debug-log-safe model id, or `unknown` when preferences could not be read.
     */
    modelId: string;
}

/**
 * Builds the plain-text bundle: header lines in `key=value` style, the
 * notice, a marker and one event per line. Static API only.
 */
export class DebugLogExport {
    /**
     * Renders one consistent snapshot; the event count in the header equals
     * the number of event lines and the snapshot timestamp is the caller's.
     *
     * @param snapshot - Immutable store snapshot.
     * @param env - Environment facts.
     * @param exportedAtMs - Snapshot timestamp (also the file-name instant).
     *
     * @returns Bundle text ending with a newline.
     */
    static buildBundle(
        snapshot: DebugLogSnapshot,
        env: DebugLogEnvironment,
        exportedAtMs: number,
    ): string {
        const { status } = snapshot;
        const byok = env.analysisMode === ANALYSIS_MODE.Byok;
        const header = [
            DEBUG_LOG_BUNDLE_TITLE,
            formatLogFields({
                exportedAt: new Date(exportedAtMs).toISOString(),
                extension: env.extensionBuild,
                browser: env.browserMajor ?? UNKNOWN_VALUE,
                os: env.osFamily,
                locale: env.locale,
            }),
            formatLogFields({
                analysisMode: env.analysisMode,
                provider: byok ? env.providerId : undefined,
                model: byok ? env.modelId : undefined,
            }),
            formatLogFields({
                loggingEnabled: status.enabled,
                enabledSince: DebugLogExport.isoOrNone(status.enabledAtMs),
                disabledAt: DebugLogExport.isoOrNone(status.disabledAtMs),
            }),
            formatLogFields({
                capBytes: status.capBytes,
                sizeBytes: status.sizeBytes,
                events: snapshot.lines.length,
                evicted: status.evictedCount,
                oldestRetained: DebugLogExport.isoOrNone(status.oldestRetainedMs),
            }),
            formatLogFields({
                droppedCoalesced: status.dropped.coalesced,
                droppedCeiling: status.dropped.ceiling,
                droppedUnreachable: status.dropped.unreachable,
                // Incognito use must not be readable from the export itself.
                droppedOther: status.dropped.incognito + status.dropped.lost,
            }),
            DEBUG_LOG_BUNDLE_NOTICE,
            DEBUG_LOG_BUNDLE_EVENTS_MARKER,
        ];
        return `${[...header, ...snapshot.lines].join('\n')}\n`;
    }

    /**
     * UTC timestamp or the `none` token.
     *
     * @param ms - Epoch milliseconds or `null`.
     *
     * @returns ISO string or `none`.
     */
    private static isoOrNone(ms: number | null): string {
        return ms === null ? NONE_VALUE : new Date(ms).toISOString();
    }
}
