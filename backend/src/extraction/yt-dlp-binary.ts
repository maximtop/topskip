import path from 'node:path';
import { spawnSync } from 'node:child_process';

const YT_DLP_PATH_ENV = 'TOPSKIP_YT_DLP_PATH';
const YT_DLP_TOOL_DIRECTORY = '.tools';
const YT_DLP_EXECUTABLE_NAME = 'yt-dlp';
const YT_DLP_STARTUP_TIMEOUT_MS = 30_000;

/**
 * Resolves and validates the external extractor without coupling callers to
 * the repository layout; static API only.
 */
export class YtDlpBinary {
    /**
     * Uses an operator override when present, otherwise the repo-managed tool.
     *
     * @returns Absolute or operator-provided executable path.
     */
    static resolvePath(): string {
        const override = process.env[YT_DLP_PATH_ENV]?.trim();
        if (override !== undefined && override.length > 0) {
            return override;
        }
        return path.resolve(
            process.cwd(),
            YT_DLP_TOOL_DIRECTORY,
            YT_DLP_EXECUTABLE_NAME,
        );
    }

    /**
     * Fails startup early because server-mode extraction cannot work without
     * its only production extractor.
     *
     * @returns Detected yt-dlp version.
     */
    static assertAvailable(): string {
        const result = spawnSync(YtDlpBinary.resolvePath(), ['--version'], {
            encoding: 'utf8',
            shell: false,
            timeout: YT_DLP_STARTUP_TIMEOUT_MS,
        });
        const version = result.stdout.trim();
        if (result.status !== 0 || result.error !== undefined || !version) {
            throw new Error(
                'yt-dlp is unavailable. Run `make yt-dlp-install` or set TOPSKIP_YT_DLP_PATH.',
            );
        }
        return version;
    }
}
