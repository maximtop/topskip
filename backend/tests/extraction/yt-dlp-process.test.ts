import { describe, expect, it } from 'vitest';

import { YtDlpProcess } from '@topskip/backend/extraction/yt-dlp-process';
import { YtDlpBinary } from '@topskip/backend/extraction/yt-dlp-binary';

describe('yt-dlp process boundary', () => {
    it('validates an operator-provided executable during startup', () => {
        const previous = process.env.TOPSKIP_YT_DLP_PATH;
        process.env.TOPSKIP_YT_DLP_PATH = process.execPath;
        try {
            expect(YtDlpBinary.assertAvailable()).toMatch(/^v/u);
        } finally {
            if (previous === undefined) {
                delete process.env.TOPSKIP_YT_DLP_PATH;
            } else {
                process.env.TOPSKIP_YT_DLP_PATH = previous;
            }
        }
    });

    it('reports a missing executable without leaking spawn errors', async () => {
        await expect(
            YtDlpProcess.run({
                binaryPath: '/definitely/missing/yt-dlp',
                args: ['--version'],
                maxOutputBytes: 1_024,
                timeoutMs: 1_000,
            }),
        ).resolves.toEqual({
            status: 'failed',
            code: 'binary_missing',
        });
    });

    it('bounds stdout and kills timed out subprocesses', async () => {
        await expect(
            YtDlpProcess.run({
                binaryPath: process.execPath,
                args: ['-e', "process.stdout.write('x'.repeat(2048))"],
                maxOutputBytes: 32,
                timeoutMs: 1_000,
            }),
        ).resolves.toEqual({
            status: 'failed',
            code: 'oversized_response',
        });

        await expect(
            YtDlpProcess.run({
                binaryPath: process.execPath,
                args: ['-e', 'setInterval(() => {}, 1000)'],
                maxOutputBytes: 32,
                timeoutMs: 20,
            }),
        ).resolves.toEqual({
            status: 'timed_out',
            code: 'timeout',
        });
    });

    it('normalizes a non-zero process exit without retaining output', async () => {
        await expect(
            YtDlpProcess.run({
                binaryPath: process.execPath,
                args: [
                    '-e',
                    "process.stderr.write('signed-url=secret'); process.exit(7)",
                ],
                maxOutputBytes: 1_024,
                timeoutMs: 1_000,
            }),
        ).resolves.toEqual({
            status: 'failed',
            code: 'process_failed',
        });
    });
});
