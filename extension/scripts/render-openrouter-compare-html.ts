#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';

import {
  parseOpenRouterComparePresetsLog,
  renderOpenRouterCompareHtml,
} from './lib/openrouter-compare-report';

type RenderCliOpts = {
  out?: string;
  title?: string;
};

function normalizeForwardedCliArgs(argv: readonly string[]): string[] {
  let index = 0;
  while (index < argv.length && argv[index] === '--') {
    index += 1;
  }
  return argv.slice(index);
}

function defaultOutputPath(inputPath: string): string {
  const parsed = path.parse(inputPath);
  return path.join(parsed.dir, `${parsed.name}.html`);
}

function renderCliAction(logPath: string, opts: RenderCliOpts): void {
  const rawText = readFileSync(logPath, 'utf8');
  const report = parseOpenRouterComparePresetsLog(rawText);
  const html = renderOpenRouterCompareHtml(report, {
    title: opts.title,
    sourceLabel: path.relative(process.cwd(), logPath),
  });
  const outPath = opts.out ?? defaultOutputPath(logPath);
  writeFileSync(outPath, html, 'utf8');
  console.error(`Wrote HTML report -> ${outPath}`);
}

async function runCli(): Promise<void> {
  const program = new Command();
  program
    .name('render-openrouter-compare-html')
    .description('Render a compare-openrouter-presets log as HTML.')
    .argument('<log-file>', 'Path to the raw compare log or JSON file')
    .option('-o, --out <path>', 'Write the HTML report to this path')
    .option('--title <text>', 'Optional report title override')
    .action(renderCliAction);
  await program.parseAsync(normalizeForwardedCliArgs(process.argv.slice(2)), {
    from: 'user',
  });
}

const entryPath = path.resolve(process.argv[1] ?? '');
const thisFile = fileURLToPath(import.meta.url);
if (entryPath === thisFile) {
  void runCli();
}