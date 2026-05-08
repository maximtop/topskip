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
