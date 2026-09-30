#!/usr/bin/env node

/**
 * @file CLI that runs or resumes the tracked paid-promo benchmark matrix
 * against the configured LLM endpoint, or rebuilds the README report from
 * already-recorded samples without making network calls.
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Command, Option } from 'commander';
import { config as loadDotEnv } from 'dotenv';

import {
    runBenchmarkPreflight,
    validateBenchmarkApiEnvironment,
} from './lib/promo-benchmark-core';
import {
    BENCHMARK_REASONING_LEVELS,
    type BenchmarkReasoning,
} from './lib/promo-benchmark-models';
import { writeBenchmarkReadme } from './lib/promo-benchmark-report';
import { runBenchmarkMatrix, type BenchmarkRunProgress } from './lib/promo-benchmark-run';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, '..');
const extensionDotEnvPath = path.resolve(repoRoot, 'extension/.env');

loadDotEnv({ path: extensionDotEnvPath, quiet: true });

/**
 * Strips the `--` argument npm/pnpm inject before forwarded script
 * arguments, so Commander does not treat it as a positional argument.
 *
 * @param argv - Typically `process.argv.slice(2)`
 *
 * @returns Arguments for Commander after stripping wrapper-injected `--`
 */
function normalizeForwardedArgs(argv: readonly string[]): string[] {
    let index = 0;
    while (index < argv.length && argv[index] === '--') {
        index += 1;
    }
    return argv.slice(index);
}

/**
 * Commander option handler that accumulates repeated `--model` flags.
 *
 * @param value - Latest `--model` value.
 * @param previous - Values collected from earlier `--model` flags.
 *
 * @returns Accumulated model ids.
 */
function collectModel(value: string, previous: string[]): string[] {
    return [...previous, value];
}

/**
 * One-word status for a progress line, without nesting the resumed/valid
 * checks into a single ternary expression.
 *
 * @param progress - Progress event for one completed request.
 *
 * @returns `resumed`, `valid`, or `invalid`.
 */
function formatProgressOutcome(progress: BenchmarkRunProgress): string {
    if (progress.resumed) {
        return 'resumed';
    }
    return progress.valid === true ? 'valid' : 'invalid';
}

const program = new Command();

program
    .name('benchmark:promo')
    .description('Run or resume the tracked paid-promo benchmark matrix.')
    .option('--dry-run', 'Validate the matrix without network calls or writes')
    .option('--report-only', 'Rebuild README from existing samples')
    .option(
        '--model <id>',
        'Run only one selected model; repeat the option for more models',
        collectModel,
        [],
    )
    .addOption(
        new Option('--reasoning <level>', 'Requested reasoning level')
            .choices([...BENCHMARK_REASONING_LEVELS])
            .default('default'),
    );

/**
 * Runs the benchmark matrix (or the dry-run/report-only variants) using the
 * options collected on the `program` command above.
 *
 * @returns Promise that settles when the CLI finishes.
 */
async function runCli(): Promise<void> {
    const options = program.opts<{
        dryRun: boolean;
        reportOnly: boolean;
        model: string[];
        reasoning: BenchmarkReasoning;
    }>();
    if (options.dryRun && options.reportOnly) {
        throw new Error('--dry-run and --report-only cannot be combined.');
    }
    const preflight = runBenchmarkPreflight({
        repoRoot,
        requestedModelIds: options.model,
        reasoning: options.reasoning,
    });
    if (options.reportOnly) {
        writeBenchmarkReadme(repoRoot);
        console.log('Benchmark report updated.');
        return;
    }
    if (options.dryRun) {
        console.log(
            [
                'Benchmark preflight passed.',
                `Corpus: ${preflight.manifest.corpusId} `
                    + `(${String(preflight.manifest.itemCount)} videos, 5 EN / 5 RU)`,
                `Models: ${String(preflight.models.length)}`,
                `Reasoning: ${preflight.reasoning}`,
                'Output limit: model default',
                `Requests: ${String(preflight.requestCount)}`,
                `Prompt: v${preflight.promptVersion} ${preflight.promptSha256}`,
            ].join('\n'),
        );
        return;
    }
    const environment = validateBenchmarkApiEnvironment({
        baseUrl: process.env.BENCHMARK_LLM_BASE_URL,
        apiKey: process.env.BENCHMARK_LLM_API_KEY,
    });
    const result = await runBenchmarkMatrix({
        repoRoot,
        preflight,
        baseUrl: environment.baseUrl,
        apiKey: environment.apiKey,
        onProgress: (progress) => {
            const outcome = formatProgressOutcome(progress);
            console.log(
                `[${String(progress.completed)}/${String(progress.total)}] `
                    + `${progress.model} ${progress.videoId} `
                    + `repeat-${String(progress.repeat)} ${outcome}`,
            );
        },
    });
    writeBenchmarkReadme(repoRoot);
    console.log(
        `Benchmark complete: ${String(result.completed)}/`
            + `${String(result.total)}, resumed ${String(result.resumed)}.`,
    );
}

program.action(runCli);

void program
    .parseAsync(normalizeForwardedArgs(process.argv.slice(2)), { from: 'user' })
    .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : 'Unknown benchmark error.';
        console.error(`Benchmark failed: ${message}`);
        process.exitCode = 1;
    });
