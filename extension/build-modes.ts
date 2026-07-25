import { TOPSKIP_PUBLIC_SERVER_BASE_URL } from './src/shared/server-analysis-origin.ts';

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

const SERVER_ANALYSIS_BASE_URL_BY_BUILD = {
    [TopSkipBuild.Dev]: TOPSKIP_PUBLIC_SERVER_BASE_URL,
    [TopSkipBuild.Beta]: TOPSKIP_PUBLIC_SERVER_BASE_URL,
    [TopSkipBuild.Release]: TOPSKIP_PUBLIC_SERVER_BASE_URL,
} satisfies Record<TopSkipBuildMode, string>;

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
    return SERVER_ANALYSIS_BASE_URL_BY_BUILD[build];
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
