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

/** Loopback backend used by local development and browser fixtures. */
const TOPSKIP_DEV_SERVER_BASE_URL = 'http://127.0.0.1:8787';

/** Public backend shared by beta and release extension builds. */
const TOPSKIP_PUBLIC_SERVER_BASE_URL = 'https://topskip.maximtop.dev';

/**
 * Resolves the backend origin compiled into a build profile.
 *
 * @param build - Extension build profile.
 * @returns Backend origin without a trailing slash.
 */
export function getServerAnalysisBaseUrl(build: TopSkipBuildMode): string {
    return build === TopSkipBuild.Dev
        ? TOPSKIP_DEV_SERVER_BASE_URL
        : TOPSKIP_PUBLIC_SERVER_BASE_URL;
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
