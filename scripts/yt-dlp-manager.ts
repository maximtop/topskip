import {
    chmod,
    mkdir,
    readFile,
    rename,
    rm,
    writeFile,
} from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

import {
    selectYtDlpReleaseAsset,
    verifyYtDlpAssetChecksum,
    YT_DLP_RELEASE_REPOSITORY,
    YT_DLP_RELEASE_TAG,
} from './lib/yt-dlp-release';

const MANAGED_EXECUTABLE_PATH = path.join(process.cwd(), '.tools', 'yt-dlp');
const EXECUTABLE_MODE = 0o755;
const DOWNLOAD_BASE_URL = `https://github.com/${YT_DLP_RELEASE_REPOSITORY}/releases/download`;

/**
 * Owns reproducible installation of the repository-pinned binary; static API only.
 */
class YtDlpManager {
    /**
     * Runs the requested manager command and converts failures into a clear exit.
     *
     * @returns Promise resolved after the command completes.
     */
    static async main(): Promise<void> {
        const command = process.argv[2];
        if (command === 'install') {
            await YtDlpManager.install();
            return;
        }
        throw new Error('Usage: yt-dlp-manager.ts install');
    }

    /**
     * Installs the pinned artifact only when no working executable is present.
     *
     * @returns Promise resolved after verification or installation.
     */
    private static async install(): Promise<void> {
        const executablePath = YtDlpManager.executablePath();
        if (process.env.TOPSKIP_YT_DLP_PATH !== undefined) {
            if (YtDlpManager.isWorking(executablePath)) {
                console.info(`yt-dlp is ready at ${executablePath}`);
                return;
            }
            throw new Error(
                `TOPSKIP_YT_DLP_PATH does not point to a working executable: ${executablePath}`,
            );
        }

        const asset = selectYtDlpReleaseAsset(process.platform, process.arch);
        if (await YtDlpManager.isPinnedWorking(executablePath, asset.sha256)) {
            console.info(`Pinned yt-dlp is ready at ${executablePath}`);
            return;
        }
        const url = `${DOWNLOAD_BASE_URL}/${YT_DLP_RELEASE_TAG}/${asset.assetName}`;
        console.info(`Installing pinned yt-dlp ${YT_DLP_RELEASE_TAG}...`);
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(
                `yt-dlp download failed with HTTP ${response.status}`,
            );
        }
        const contents = new Uint8Array(await response.arrayBuffer());
        if (!verifyYtDlpAssetChecksum(contents, asset.sha256)) {
            throw new Error('yt-dlp download failed SHA-256 verification');
        }

        const temporaryPath = `${executablePath}.download`;
        await mkdir(path.dirname(executablePath), { recursive: true });
        await rm(temporaryPath, { force: true });
        try {
            await writeFile(temporaryPath, contents, { mode: EXECUTABLE_MODE });
            await chmod(temporaryPath, EXECUTABLE_MODE);
            await rename(temporaryPath, executablePath);
        } finally {
            await rm(temporaryPath, { force: true });
        }
        if (!YtDlpManager.isWorking(executablePath)) {
            throw new Error('Installed yt-dlp executable did not start');
        }
        console.info(`Installed yt-dlp at ${executablePath}`);
    }

    /**
     * Resolves an explicit executable without allowing tooling to overwrite it.
     *
     * @returns Absolute or caller-provided executable path.
     */
    private static executablePath(): string {
        return process.env.TOPSKIP_YT_DLP_PATH ?? MANAGED_EXECUTABLE_PATH;
    }

    /**
     * Uses the executable's version command as the readiness boundary.
     *
     * @param executablePath - Candidate executable path.
     * @returns Whether the command starts and exits successfully.
     */
    private static isWorking(executablePath: string): boolean {
        const result = spawnSync(
            executablePath,
            ['--ignore-config', '--version'],
            {
                stdio: 'ignore',
            },
        );
        return result.status === 0;
    }

    /**
     * Accepts a managed executable only when its bytes still match the reviewed pin.
     *
     * @param executablePath - Managed binary path.
     * @param expectedSha256 - Repository-reviewed digest for this platform.
     * @returns Whether checksum and executable readiness both pass.
     */
    private static async isPinnedWorking(
        executablePath: string,
        expectedSha256: string,
    ): Promise<boolean> {
        try {
            const contents = await readFile(executablePath);
            return (
                verifyYtDlpAssetChecksum(contents, expectedSha256) &&
                YtDlpManager.isWorking(executablePath)
            );
        } catch {
            return false;
        }
    }
}

void YtDlpManager.main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`yt-dlp setup failed: ${message}`);
    process.exitCode = 1;
});
