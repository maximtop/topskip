import process from 'node:process';
import { isIP } from 'node:net';

/**
 * Environment variable holding the public backend origin.
 *
 * The deployment host is configuration, not source: it is read at build time
 * so the repository carries no particular hostname. Local builds pick it up
 * from the root `.env` (see `.env.example`); CI and release pipelines set it
 * as an environment variable.
 */
export const SERVER_ORIGIN_ENV_VAR = 'TOPSKIP_SERVER_ORIGIN';

/**
 * Environment variable selecting the extension build profile.
 */
export const BUILD_MODE_ENV_VAR = 'TOPSKIP_BUILD';

/**
 * Shared `TOPSKIP_BUILD` profile names (Rspack manifest + build script).
 */
export const TopSkipBuild = {
    Dev: 'dev',
    Beta: 'beta',
    Release: 'release',
} as const;

export type TopSkipBuildMode = (typeof TopSkipBuild)[keyof typeof TopSkipBuild];

/** Ordered list for CLI validation (`scripts/build-extension.ts`). */
export const TOPSKIP_BUILD_MODES: readonly TopSkipBuildMode[] = [
    TopSkipBuild.Dev,
    TopSkipBuild.Beta,
    TopSkipBuild.Release,
];

const DEV_LOOPBACK_SERVER_ORIGIN = 'http://127.0.0.1:8787';
const HTTP_PROTOCOL = 'http:';
const HTTPS_PROTOCOL = 'https:';
const IPV6_OPENING_BRACKET = '[';
const IPV6_CLOSING_BRACKET = ']';
const MAX_DNS_HOSTNAME_LENGTH = 253;
const MAX_DNS_LABEL_LENGTH = 63;
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const SPECIAL_USE_DNS_SUFFIXES = new Set([
    'localhost',
    'local',
    'localdomain',
    'localnet',
    'internal',
    'home',
    'lan',
    'test',
    'example',
    'invalid',
    'onion',
    'arpa',
    'alt',
]);

/**
 * Defaults only a missing profile so malformed release inputs cannot silently
 * produce a development bundle.
 *
 * @param raw - Untrusted `TOPSKIP_BUILD` environment value.
 * @returns Validated extension build profile.
 */
export function resolveTopSkipBuild(
    raw: string | undefined,
): TopSkipBuildMode {
    if (raw === undefined) {
        return TopSkipBuild.Dev;
    }
    if (
        raw === TopSkipBuild.Dev ||
        raw === TopSkipBuild.Beta ||
        raw === TopSkipBuild.Release
    ) {
        return raw;
    }
    throw new Error(
        `${BUILD_MODE_ENV_VAR} must be one of ${TOPSKIP_BUILD_MODES.join(', ')}, ` +
            `got '${raw}'.`,
    );
}

/**
 * Removes URL syntax around IPv6 before passing a hostname to Node's IP
 * classifier.
 *
 * @param hostname - Canonical hostname returned by `URL`.
 * @returns Hostname without IPv6 brackets.
 */
function removeIpv6Brackets(hostname: string): string {
    const hasOpeningBracket = hostname.startsWith(IPV6_OPENING_BRACKET);
    const hasClosingBracket = hostname.endsWith(IPV6_CLOSING_BRACKET);
    if (!hasOpeningBracket || !hasClosingBracket) {
        return hostname;
    }
    return hostname.slice(1, -1);
}

/**
 * Applies a deterministic DNS-shape policy without pretending to resolve the
 * hostname or classify the address it may resolve to at runtime.
 *
 * @param hostname - Canonical, unrooted hostname returned by `URL`.
 * @returns Whether the hostname looks suitable for a public HTTPS endpoint.
 */
function isPublicLookingDnsHostname(hostname: string): boolean {
    if (hostname.length > MAX_DNS_HOSTNAME_LENGTH) {
        return false;
    }
    const labels = hostname.split('.');
    if (labels.length < 2) {
        return false;
    }
    const suffix = labels.at(-1);
    if (suffix === undefined || SPECIAL_USE_DNS_SUFFIXES.has(suffix)) {
        return false;
    }
    return labels.every(
        (label) =>
            label.length <= MAX_DNS_LABEL_LENGTH &&
            DNS_LABEL_PATTERN.test(label),
    );
}

/**
 * Reports one stable policy error for cleartext, IP, private-looking, and
 * malformed DNS endpoints without exposing a misleading partial allowlist.
 *
 * @param raw - Rejected backend origin.
 * @returns Never returns because an invalid origin stops the build.
 */
function rejectNonPublicOrigin(raw: string): never {
    throw new Error(
        `${SERVER_ORIGIN_ENV_VAR} must be a public HTTPS DNS origin, got ` +
            `'${raw}'.`,
    );
}

/**
 * Enforces the backend boundary before manifest composition can grant host
 * access to an unsafe or accidentally development-only endpoint.
 *
 * @param build - Extension build profile receiving the backend origin.
 * @param raw - Untrusted build-time backend origin.
 * @returns Canonical bare origin accepted for the selected profile.
 */
export function validateServerOrigin(
    build: TopSkipBuildMode,
    raw: string | undefined,
): string {
    if (raw === undefined || raw.trim() === '') {
        throw new Error(
            `${SERVER_ORIGIN_ENV_VAR} is not set. Copy .env.example to .env and ` +
                'set it to your backend origin, or export it in the build ' +
                'environment.',
        );
    }
    if (raw !== raw.trim()) {
        throw new Error(
            `${SERVER_ORIGIN_ENV_VAR} must not contain surrounding whitespace, ` +
                `got '${raw}'.`,
        );
    }

    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error(
            `${SERVER_ORIGIN_ENV_VAR} must be an absolute URL, got '${raw}'.`,
        );
    }
    if (parsed.protocol !== HTTPS_PROTOCOL && parsed.protocol !== HTTP_PROTOCOL) {
        throw new Error(
            `${SERVER_ORIGIN_ENV_VAR} must use http or https, got '${raw}'.`,
        );
    }

    const canonicalHostname = parsed.hostname;
    if (canonicalHostname.endsWith('.')) {
        return rejectNonPublicOrigin(raw);
    }
    const ipVersion = isIP(removeIpv6Brackets(canonicalHostname));
    const isExactDevException =
        build === TopSkipBuild.Dev &&
        parsed.origin === DEV_LOOPBACK_SERVER_ORIGIN;
    if (isExactDevException) {
        if (raw !== parsed.origin) {
            throw new Error(
                `${SERVER_ORIGIN_ENV_VAR} must be a bare origin with no path or ` +
                    `trailing slash, got '${raw}' (expected '${parsed.origin}').`,
            );
        }
        return parsed.origin;
    }

    const usesHttps = parsed.protocol === HTTPS_PROTOCOL;
    const isDnsHostname = ipVersion === 0;
    const looksPublic = isPublicLookingDnsHostname(canonicalHostname);
    if (!usesHttps || !isDnsHostname || !looksPublic) {
        return rejectNonPublicOrigin(raw);
    }
    if (raw !== parsed.origin) {
        throw new Error(
            `${SERVER_ORIGIN_ENV_VAR} must be a bare origin with no path or ` +
                `trailing slash, got '${raw}' (expected '${parsed.origin}').`,
        );
    }
    return parsed.origin;
}

/**
 * Reads and validates the configured backend origin.
 *
 * Throws rather than defaulting: a silently wrong origin would ship an
 * extension that talks to the wrong backend, which is worse than a failed
 * build. The value must be a bare origin because callers append paths to it.
 *
 * @param build - Extension build profile receiving the configured origin.
 * @returns Scheme and host with no trailing slash, e.g. `https://api.example`.
 */
function readServerOrigin(build: TopSkipBuildMode): string {
    return validateServerOrigin(build, process.env[SERVER_ORIGIN_ENV_VAR]);
}

const EXTENSION_NAME_BY_BUILD = {
    [TopSkipBuild.Dev]: 'TopSkip (Dev)',
    [TopSkipBuild.Beta]: 'TopSkip (Beta)',
    [TopSkipBuild.Release]: '__MSG_name__',
} satisfies Record<TopSkipBuildMode, string>;

/**
 * Makes unpacked and beta installations distinguishable from release.
 *
 * @param build - Extension build profile.
 * @returns Manifest name for the selected profile.
 */
export function getExtensionManifestName(build: TopSkipBuildMode): string {
    return EXTENSION_NAME_BY_BUILD[build];
}

/**
 * Resolves the backend origin compiled into a build profile.
 *
 * @param build - Extension build profile.
 * @returns Backend origin without a trailing slash.
 */
export function getServerAnalysisBaseUrl(build: TopSkipBuildMode): string {
    return readServerOrigin(build);
}

/**
 * Resolves the exact manifest host permission needed by a build profile.
 *
 * @param build - Extension build profile.
 * @returns Chrome match pattern for the selected backend.
 */
export function getServerAnalysisManifestMatch(
    build: TopSkipBuildMode,
): string {
    return `${getServerAnalysisBaseUrl(build)}/*`;
}

/**
 * Keeps detailed caption diagnostics out of user-facing builds while leaving
 * the caption acquisition path enabled.
 *
 * @param build - Extension build profile.
 * @returns Whether stage-by-stage capture logging is compiled in.
 */
export function shouldEnableCaptionCaptureVerboseLogs(
    build: TopSkipBuildMode,
): boolean {
    return build === TopSkipBuild.Dev;
}

/**
 * Compile-time gate for the Chrome built-in AI provider (Gemini Nano).
 *
 * Disabled after measuring it against the human-annotated fixture on
 * Chrome 150 / Gemini Nano `v3Nano` (30.7-minute Russian video, 40,116 chars):
 *
 * - Mean IoU **0.054** against the three annotated promo windows, versus
 *   **0.747** for the cloud model on the same transcript. Two of the three
 *   windows were missed entirely.
 * - It predicted 730s of promo where 232s exist (**3.1x** over-prediction),
 *   including one contiguous 12-minute block covering a third of the video.
 * - The raw responses show the failure mode: it tiles the transcript into
 *   consecutive spans and labels them all promo, rather than discriminating.
 *   One chunk generated so many blocks that Chrome truncated the response
 *   after 48s of inference.
 * - 72–85s per video end to end, byte-identical across repeats — systematic,
 *   not an unlucky sample.
 *
 * Russian is not among the languages the Prompt API accepts (`de, en, es,
 * fr, ja`), so an English-language retest — or translating first through the
 * Translator API — could change this. Re-enable by flipping the constant and
 * re-running the throwaway bench in `extension/tmp/nano-bench/`.
 *
 * Turning this on also requires restoring the orphaned options UI
 * (`ChromeBuiltinPanel`, `ChromeBuiltinInlineStatus`, `ChromeBuiltinOnboarding`,
 * `chrome-download-machine`), which is the only way to trigger the model
 * download, and fixing two adapter defects the bench surfaced: the budget
 * probe calibrates on `'a'.repeat(500)` and overestimates a Cyrillic budget
 * by 3.11x, and `RESPONSE_TOKEN_RESERVE = 512` is too small for the number
 * of blocks the model emits.
 */
export const INCLUDE_CHROME_BUILTIN_PROVIDER = false;
