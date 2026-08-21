import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/**
 * Backend origin the specs mock with a local `createServer` on this port.
 *
 * Only the dev profile accepts this exact loopback backend; beta/release reject
 * it. The suite therefore composes its own dev artifact instead of reusing an
 * arbitrary prior build whose origin and content-script matches are unknown.
 */
export const E2E_BACKEND_ORIGIN = 'http://127.0.0.1:8787';

const repositoryRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
);

/**
 * Rebuilds `extension/dist/` against the mocked backend before any spec runs.
 *
 * `TOPSKIP_SERVER_ORIGIN` is passed through the environment, which takes
 * precedence over the root `.env` because dotenv does not override values that
 * are already set.
 *
 * @returns Nothing; throws when the build fails.
 */
export default function globalSetup(): void {
    const result = spawnSync(
        'pnpm',
        ['exec', 'rspack', 'build', '--config', 'extension/rspack.config.ts'],
        {
            cwd: repositoryRoot,
            env: {
                ...process.env,
                TOPSKIP_BUILD: 'dev',
                TOPSKIP_SERVER_ORIGIN: E2E_BACKEND_ORIGIN,
            },
            stdio: 'inherit',
        },
    );

    if (result.status !== 0) {
        throw new Error(
            `Failed to build the extension for E2E against ${E2E_BACKEND_ORIGIN} ` +
                `(exit code ${String(result.status)}).`,
        );
    }

    const validation = spawnSync(
        'pnpm',
        [
            'run',
            'validate:extension-manifest',
            '--',
            '--build',
            'dev',
            '--server-origin',
            E2E_BACKEND_ORIGIN,
            '--manifest',
            'extension/dist/manifest.json',
        ],
        {
            cwd: repositoryRoot,
            stdio: 'inherit',
        },
    );
    if (validation.status !== 0) {
        throw new Error(
            'The extension built for E2E failed manifest policy validation ' +
                `(exit code ${String(validation.status)}).`,
        );
    }
}
