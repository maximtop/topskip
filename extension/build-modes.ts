import process from 'node:process';

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

/**
 * Reads and validates the configured backend origin.
 *
 * Throws rather than defaulting: a silently wrong origin would ship an
 * extension that talks to the wrong backend, which is worse than a failed
 * build. The value must be a bare origin because callers append paths to it.
 *
 * @returns Scheme and host with no trailing slash, e.g. `https://api.example`.
 */
function readServerOrigin(): string {
    const raw = process.env[SERVER_ORIGIN_ENV_VAR]?.trim() ?? '';
    if (raw === '') {
        throw new Error(
            `${SERVER_ORIGIN_ENV_VAR} is not set. Copy .env.example to .env and ` +
                'set it to your backend origin, or export it in the build ' +
                'environment.',
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
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        throw new Error(
            `${SERVER_ORIGIN_ENV_VAR} must use http or https, got '${raw}'.`,
        );
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
 * Every profile currently targets the same backend; the shape is kept so a
 * profile can diverge without reworking callers.
 *
 * @returns Backend origin per build profile.
 */
function serverAnalysisBaseUrlByBuild(): Record<TopSkipBuildMode, string> {
    const origin = readServerOrigin();
    return {
        [TopSkipBuild.Dev]: origin,
        [TopSkipBuild.Beta]: origin,
        [TopSkipBuild.Release]: origin,
    };
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
    return serverAnalysisBaseUrlByBuild()[build];
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
