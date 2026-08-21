import browser from '@/shared/browser';

/**
 * Prefers the stamped `version_name` because unpacked and beta installs are
 * rebuilt under one manifest `version`, so only the build stamp tells a stale
 * Chrome load from the latest artifact; release falls back to the bare version.
 *
 * @returns Human-readable build identity for startup diagnostics.
 */
export function getExtensionBuildLabel(): string {
    const manifest = browser.runtime.getManifest();
    return manifest.version_name ?? manifest.version;
}
