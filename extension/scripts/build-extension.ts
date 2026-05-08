import { spawn } from 'node:child_process';
import process from 'node:process';

import { Argument, Command } from 'commander';

import {
    TopSkipBuild,
    TOPSKIP_BUILD_MODES,
    type TopSkipBuildMode,
} from '../build-modes.ts';

const program = new Command();

program
    .name('build-extension')
    .description(
        'Run Rspack with TOPSKIP_BUILD (dev adds localhost for E2E; beta/release ' +
            'do not).',
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
            'rspack.config.ts',
        ];
        if (watch) {
            args.push('--watch');
        }
        const child = spawn('pnpm', args, {
            env: { ...process.env, TOPSKIP_BUILD: mode },
            stdio: 'inherit',
            shell: true,
        });
        child.on('exit', (code) => {
            process.exit(code ?? 0);
        });
    });

program.parse(process.argv);
