import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const RELEASE_API_URL =
    'https://api.github.com/repos/yt-dlp/yt-dlp-nightly-builds/releases/latest';
const RELEASE_DOWNLOAD_BASE_URL =
    'https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/download';
const RELEASE_SOURCE_PATH = path.join(
    process.cwd(),
    'scripts',
    'lib',
    'yt-dlp-release.ts',
);
const CHECKSUM_ASSET_NAME = 'SHA2-256SUMS';
const MACOS_ASSET_NAME = 'yt-dlp_macos';
const LINUX_ASSET_NAME = 'yt-dlp_linux';
const SHA256_PATTERN = /^[a-f\d]{64}$/u;

/**
 * Refreshes repository bootstrap constants from official nightly metadata;
 * static API only.
 */
class YtDlpPinRefresher {
    /**
     * Fetches the latest release and updates the tracked source constants.
     *
     * @returns Promise resolved after the source file is updated.
     */
    static async main(): Promise<void> {
        const releaseResponse = await fetch(RELEASE_API_URL, {
            headers: { Accept: 'application/vnd.github+json' },
        });
        if (!releaseResponse.ok) {
            throw new Error(
                `GitHub release lookup failed with HTTP ${releaseResponse.status}`,
            );
        }
        const release = (await releaseResponse.json()) as unknown;
        const tag = YtDlpPinRefresher.readTag(release);
        const checksumResponse = await fetch(
            `${RELEASE_DOWNLOAD_BASE_URL}/${tag}/${CHECKSUM_ASSET_NAME}`,
        );
        if (!checksumResponse.ok) {
            throw new Error(
                `yt-dlp checksum download failed with HTTP ${checksumResponse.status}`,
            );
        }
        const checksums = YtDlpPinRefresher.parseChecksums(
            await checksumResponse.text(),
        );
        const macosSha256 = YtDlpPinRefresher.requireChecksum(
            checksums,
            MACOS_ASSET_NAME,
        );
        const linuxSha256 = YtDlpPinRefresher.requireChecksum(
            checksums,
            LINUX_ASSET_NAME,
        );
        const source = await readFile(RELEASE_SOURCE_PATH, 'utf8');
        const tagUpdated = source.replace(
            /export const YT_DLP_RELEASE_TAG = '[^']+';/u,
            `export const YT_DLP_RELEASE_TAG = '${tag}';`,
        );
        const macosUpdated = tagUpdated.replace(
            /(assetName: 'yt-dlp_macos',\n\s+sha256: ')[a-f\d]{64}(';)/u,
            (_match, prefix: string, suffix: string) =>
                `${prefix}${macosSha256}${suffix}`,
        );
        const updated = macosUpdated.replace(
            /(assetName: 'yt-dlp_linux',\n\s+sha256: ')[a-f\d]{64}(';)/u,
            (_match, prefix: string, suffix: string) =>
                `${prefix}${linuxSha256}${suffix}`,
        );
        if (updated === source) {
            console.info(`yt-dlp bootstrap pin is already ${tag}.`);
            return;
        }
        await writeFile(RELEASE_SOURCE_PATH, updated, 'utf8');
        console.info(`Updated yt-dlp bootstrap pin to ${tag}.`);
    }

    /**
     * Validates the small GitHub response field needed by this maintenance task.
     *
     * @param input - Untrusted GitHub JSON response.
     * @returns Nightly release tag.
     */
    private static readTag(input: unknown): string {
        if (
            typeof input !== 'object' ||
            input === null ||
            !('tag_name' in input) ||
            typeof input.tag_name !== 'string' ||
            input.tag_name.length === 0
        ) {
            throw new Error('GitHub release metadata did not include a tag');
        }
        return input.tag_name;
    }

    /**
     * Converts the official checksum manifest into an asset lookup.
     *
     * @param contents - SHA2-256SUMS response body.
     * @returns Asset names mapped to validated lowercase digests.
     */
    private static parseChecksums(contents: string): Map<string, string> {
        const checksums = new Map<string, string>();
        for (const line of contents.split('\n')) {
            const [sha256, assetName] = line.trim().split(/\s+/u);
            if (
                sha256 !== undefined &&
                assetName !== undefined &&
                SHA256_PATTERN.test(sha256)
            ) {
                checksums.set(assetName, sha256);
            }
        }
        return checksums;
    }

    /**
     * Rejects incomplete manifests before modifying the trusted pin source.
     *
     * @param checksums - Parsed official checksum manifest.
     * @param assetName - Required standalone artifact name.
     * @returns Verified-format SHA-256 digest.
     */
    private static requireChecksum(
        checksums: ReadonlyMap<string, string>,
        assetName: string,
    ): string {
        const checksum = checksums.get(assetName);
        if (checksum === undefined) {
            throw new Error(`Checksum manifest omitted ${assetName}`);
        }
        return checksum;
    }
}

void YtDlpPinRefresher.main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`yt-dlp pin refresh failed: ${message}`);
    process.exitCode = 1;
});
