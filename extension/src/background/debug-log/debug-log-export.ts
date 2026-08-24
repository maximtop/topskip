import * as v from 'valibot';

import type { DebugLogSnapshot } from '@/background/debug-log/debug-log-store';
import { PrefsSyncStorage } from '@/background/storage/prefs-sync';
import browser from '@/shared/browser';
import { ANALYSIS_MODE, type UserPreferences } from '@/shared/constants';
import { toDebugLogModelId } from '@/shared/detection-models';
import { getExtensionBuildLabel } from '@/shared/extension-build';
import { formatLogFields } from '@/shared/log-fields';

/**
 * Written when a fact could not be read; never a free-form error.
 */
const UNKNOWN_VALUE = 'unknown';

/**
 * Written for an absent timestamp.
 */
const NONE_VALUE = 'none';

/**
 * Chromium brand names in structured UA data, most specific first.
 */
const CHROMIUM_BRANDS = ['Google Chrome', 'Chromium'] as const;

/**
 * Fallback when structured UA data is unavailable: only the major is read.
 */
const UA_CHROME_MAJOR_PATTERN = /Chrome\/(\d+)/u;

/**
 * UI language codes are short tags; anything else is not logged.
 */
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(?:[_-][A-Za-z0-9]{2,8})*$/u;

/**
 * Structured user-agent data as exposed by `navigator.userAgentData`.
 */
const userAgentDataSchema = v.object({
    brands: v.array(v.object({ brand: v.string(), version: v.string() })),
});

/**
 * First header line of every bundle.
 */
export const DEBUG_LOG_BUNDLE_TITLE = 'TopSkip debug log';

/**
 * Content notice carried by every export (English, not localized).
 */
export const DEBUG_LOG_BUNDLE_NOTICE =
    'Notice: this log lists the YouTube video IDs you watched while Debug ' +
    'logging was on, with times and tab numbers, plus your extension and ' +
    'browser version, OS family, UI language, analysis mode and model. It ' +
    'never contains captions, transcripts, keys, tokens, cookies or URLs. ' +
    'Incognito windows are not logged. Review it before sharing.';

/**
 * Separates the header from the event lines.
 */
export const DEBUG_LOG_BUNDLE_EVENTS_MARKER = '--- events ---';

/**
 * Facts written into the export header and the enable snapshot.
 */
export type DebugLogEnvironment = {
    extensionBuild: string;
    browserMajor: number | null;
    osFamily: string;
    locale: string;
    analysisMode: string;
    providerId: string;
    modelId: string;
};

/**
 * Collects the bounded environment facts; every read degrades to
 * `unknown`/`null` and the full user-agent string is never retained.
 * Static API only.
 */
export class EnvironmentProbe {
    /**
     * Reads build, browser major, OS family, UI locale and analysis prefs.
     *
     * @returns Environment facts for the header and the enable snapshot.
     */
    static async collect(): Promise<DebugLogEnvironment> {
        const prefs = await EnvironmentProbe.readPrefs();
        return {
            extensionBuild: EnvironmentProbe.readBuildLabel(),
            browserMajor: EnvironmentProbe.readBrowserMajor(),
            osFamily: await EnvironmentProbe.readOsFamily(),
            locale: EnvironmentProbe.readLocale(),
            analysisMode: prefs?.analysisMode ?? UNKNOWN_VALUE,
            providerId: prefs?.providerId ?? UNKNOWN_VALUE,
            modelId:
                prefs === null
                    ? UNKNOWN_VALUE
                    : toDebugLogModelId(prefs.providerId, prefs.activeModelId),
        };
    }

    /**
     * Build label, or `unknown` when the manifest cannot be read.
     *
     * @returns Build label.
     */
    private static readBuildLabel(): string {
        try {
            return getExtensionBuildLabel();
        } catch {
            return UNKNOWN_VALUE;
        }
    }

    /**
     * Validated preferences, or `null` when storage is unavailable.
     *
     * @returns Preferences or `null`.
     */
    private static async readPrefs(): Promise<UserPreferences | null> {
        try {
            await PrefsSyncStorage.ready();
            return await PrefsSyncStorage.load();
        } catch {
            return null;
        }
    }

    /**
     * Browser major from structured UA data, else from the UA string; the
     * string itself is discarded.
     *
     * @returns Major version or `null`.
     */
    private static readBrowserMajor(): number | null {
        const nav: unknown = Reflect.get(globalThis, 'navigator');
        if (nav === null || typeof nav !== 'object') {
            return null;
        }
        const fromBrands = EnvironmentProbe.majorFromBrands(
            Reflect.get(nav, 'userAgentData'),
        );
        if (fromBrands !== null) {
            return fromBrands;
        }
        const userAgent: unknown = Reflect.get(nav, 'userAgent');
        if (typeof userAgent !== 'string') {
            return null;
        }
        const match = UA_CHROME_MAJOR_PATTERN.exec(userAgent);
        return match === null ? null : Number.parseInt(match[1], 10);
    }

    /**
     * Picks the Chromium brand's major from `userAgentData.brands`.
     *
     * @param userAgentData - Raw `navigator.userAgentData` value.
     * @returns Major version or `null`.
     */
    private static majorFromBrands(userAgentData: unknown): number | null {
        const parsed = v.safeParse(userAgentDataSchema, userAgentData);
        if (!parsed.success) {
            return null;
        }
        const majors = parsed.output.brands.flatMap((entry) => {
            const major = Number.parseInt(entry.version, 10);
            return Number.isFinite(major) ? [{ brand: entry.brand, major }] : [];
        });
        for (const preferred of CHROMIUM_BRANDS) {
            const hit = majors.find((entry) => entry.brand === preferred);
            if (hit !== undefined) {
                return hit.major;
            }
        }
        return majors[0]?.major ?? null;
    }

    /**
     * OS family from the platform-info API.
     *
     * @returns Platform `os` value or `unknown`.
     */
    private static async readOsFamily(): Promise<string> {
        try {
            const info = await browser.runtime.getPlatformInfo();
            return info.os;
        } catch {
            return UNKNOWN_VALUE;
        }
    }

    /**
     * Browser UI language, bounded to a language tag shape.
     *
     * @returns Language tag or `unknown`.
     */
    private static readLocale(): string {
        try {
            const locale = browser.i18n.getUILanguage();
            return LOCALE_PATTERN.test(locale) ? locale : UNKNOWN_VALUE;
        } catch {
            return UNKNOWN_VALUE;
        }
    }
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
     * @returns ISO string or `none`.
     */
    private static isoOrNone(ms: number | null): string {
        return ms === null ? NONE_VALUE : new Date(ms).toISOString();
    }
}
