/**
 * @file CLI wrapper that runs Rspack with the TOPSKIP_BUILD env var set, so the
 * build profile (dev/beta/release) is picked with a single required argument
 * instead of remembering the underlying rspack invocation.
 */

import { spawn } from 'node:child_process';
import process from 'node:process';

import { Argument, Command } from 'commander';

import {
    TopSkipBuild,
    TOPSKIP_BUILD_MODES,
    type TopSkipBuildMode,
} from '@topskip/extension/build-modes';

const program = new Command();

program
    .name('build-extension')
    .description(
        'Run Rspack with TOPSKIP_BUILD (dev permits the exact loopback '
            + 'backend and E2E fixture; beta/release require public HTTPS DNS).',
    )
    .addArgument(
        new Argument('<mode>', 'TOPSKIP_BUILD profile').choices([
            ...TOPSKIP_BUILD_MODES,
        ]),
    )
    .action((mode: TopSkipBuildMode) => {
        const watch = mode === TopSkipBuild.Dev;
        const args = [
            'exec',
            'rspack',
            'build',
            '--config',
            'extension/rspack.config.ts',
        ];
        if (watch) {
            args.push('--watch');
        }
        const child = spawn('pnpm', args, {
            env: { ...process.env, TOPSKIP_BUILD: mode },
            stdio: 'inherit',
        });
        child.on('exit', (code) => {
            process.exit(code ?? 0);
        });
    });

program.parse(process.argv);
