import { createHash } from 'node:crypto';

/**
 * Describes a verified standalone artifact from the pinned nightly release.
 */
export type YtDlpReleaseAsset = {
    assetName: string;
    sha256: string;
};

/**
 * Pinned upstream build keeps bootstrap installs reproducible in CI.
 */
export const YT_DLP_RELEASE_TAG = '2026.07.09.234832';

/**
 * Official release project used for standalone bootstrap artifacts.
 */
export const YT_DLP_RELEASE_REPOSITORY = 'yt-dlp/yt-dlp-nightly-builds';

const MACOS_ASSET: YtDlpReleaseAsset = {
    assetName: 'yt-dlp_macos',
    sha256: '08b43d9258e01c1295899d193c5ac2cec670f4245efdc651ef06643f92bc6608',
};
const LINUX_X64_ASSET: YtDlpReleaseAsset = {
    assetName: 'yt-dlp_linux',
    sha256: '266b7b8e3323883e38c789cc4e9d5433a9b30f9b24bf2d38d8da2216dd7530b5',
};

/**
 * Chooses the official standalone artifact supported by repository tooling.
 *
 * @param platform - Node platform identifier.
 * @param architecture - Node architecture identifier.
 * @returns Pinned asset name and expected digest.
 */
export function selectYtDlpReleaseAsset(
    platform: NodeJS.Platform,
    architecture: string,
): YtDlpReleaseAsset {
    if (platform === 'darwin' && ['arm64', 'x64'].includes(architecture)) {
        return MACOS_ASSET;
    }
    if (platform === 'linux' && architecture === 'x64') {
        return LINUX_X64_ASSET;
    }

    throw new Error(
        `No managed yt-dlp binary for ${platform}/${architecture}. Set TOPSKIP_YT_DLP_PATH to a compatible executable.`,
    );
}

/**
 * Verifies downloaded bytes before they can become an executable.
 *
 * @param contents - Downloaded release artifact.
 * @param expectedSha256 - Trusted digest stored in this repository.
 * @returns Whether the artifact matches the pinned digest.
 */
export function verifyYtDlpAssetChecksum(
    contents: Uint8Array,
    expectedSha256: string,
): boolean {
    const actualSha256 = createHash('sha256').update(contents).digest('hex');
    return actualSha256 === expectedSha256.toLowerCase();
}
