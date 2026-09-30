/**
 * @file Collects the bounded environment facts (build, browser major, OS
 * family, UI locale, analysis prefs) used in the debug log export header and
 * the enable snapshot.
 */

import * as v from 'valibot';

import { UNKNOWN_VALUE, type DebugLogEnvironment } from '@/background/debug-log/debug-log-export';
import { PrefsSyncStorage } from '@/background/storage/prefs-sync';
import browser from '@/shared/browser';
import { type UserPreferences } from '@/shared/constants';
import { toDebugLogModelId } from '@/shared/detection-models';
import { getExtensionBuildLabel } from '@/shared/extension-build';

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
        return match === null ? null : Number.parseInt(match[1]!, 10); // pattern has one mandatory capture group
    }

    /**
     * Picks the Chromium brand's major from `userAgentData.brands`.
     *
     * @param userAgentData - Raw `navigator.userAgentData` value.
     *
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
