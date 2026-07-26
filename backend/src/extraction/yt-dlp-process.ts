import { spawn } from 'node:child_process';

import { YtDlpBinary } from '@topskip/backend/extraction/yt-dlp-binary';

/**
 * Bounded subprocess request used for every yt-dlp invocation.
 */
export type YtDlpRunRequest = {
    binaryPath?: string;
    args: readonly string[];
    timeoutMs: number;
    maxOutputBytes: number;
};

/**
 * Safe subprocess result that never exposes stderr or raw spawn errors.
 */
export type YtDlpRunResult =
    | { status: 'succeeded'; stdout: string }
    | {
          status: 'failed';
          code: 'binary_missing' | 'oversized_response' | 'process_failed';
      }
    | { status: 'timed_out'; code: 'timeout' };

/**
 * Injectable process boundary keeps extraction tests offline and deterministic.
 */
export type YtDlpRunner = (request: YtDlpRunRequest) => Promise<YtDlpRunResult>;

/**
 * Executes yt-dlp without a shell while bounding runtime and stdout; static
 * API only.
 */
export class YtDlpProcess {
    /**
     * Runs one command and maps all process failures into stable diagnostics.
     *
     * @param request - Executable arguments and resource limits.
     * @returns Safe bounded process result.
     */
    static async run(request: YtDlpRunRequest): Promise<YtDlpRunResult> {
        return new Promise((resolve) => {
            const child = spawn(
                request.binaryPath ?? YtDlpBinary.resolvePath(),
                [...request.args],
                {
                    shell: false,
                    stdio: ['ignore', 'pipe', 'ignore'],
                },
            );
            const chunks: Buffer[] = [];
            let outputBytes = 0;
            let settled = false;

            const finish = (result: YtDlpRunResult): void => {
                if (settled) {
                    return;
                }
                settled = true;
                clearTimeout(timeout);
                resolve(result);
            };
            const timeout = setTimeout(() => {
                child.kill('SIGKILL');
                finish({ status: 'timed_out', code: 'timeout' });
            }, request.timeoutMs);

            child.stdout.on('data', (chunk: Buffer) => {
                outputBytes += chunk.byteLength;
                if (outputBytes > request.maxOutputBytes) {
                    child.kill('SIGKILL');
                    finish({
                        status: 'failed',
                        code: 'oversized_response',
                    });
                    return;
                }
                chunks.push(chunk);
            });
            child.on('error', (error) => {
                const code =
                    'code' in error && error.code === 'ENOENT'
                        ? 'binary_missing'
                        : 'process_failed';
                finish({ status: 'failed', code });
            });
            child.on('close', (code) => {
                if (code !== 0) {
                    finish({ status: 'failed', code: 'process_failed' });
                    return;
                }
                finish({
                    status: 'succeeded',
                    stdout: Buffer.concat(chunks).toString('utf8'),
                });
            });
        });
    }
}
