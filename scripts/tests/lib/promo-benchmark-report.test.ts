import {
    cpSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runBenchmarkPreflight } from '../../lib/promo-benchmark-core';
import { writeBenchmarkReadme } from '../../lib/promo-benchmark-report';
import { runBenchmarkMatrix } from '../../lib/promo-benchmark-run';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const temporaryRoots: string[] = [];

function responseStream(): Response {
    const text = [
        'data: {"choices":[{"delta":{"reasoning_content":"SECRET_REASONING_SENTINEL"}}]}\n',
        'data: {"id":"REQUEST_ID_SENTINEL","model":"PROVIDER_SENTINEL","choices":[{"delta":{"content":"{\\"hasPromo\\":false}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}}\n',
        'data: [DONE]\n',
    ].join('');
    return new Response(text, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
    });
}

function readJsonArtifacts(directory: string): string {
    const contents: string[] = [];
    for (const name of readdirSync(directory)) {
        const child = path.join(directory, name);
        if (statSync(child).isDirectory()) {
            contents.push(readJsonArtifacts(child));
        } else if (name.endsWith('.json')) {
            contents.push(readFileSync(child, 'utf8'));
        }
    }
    return contents.join('\n');
}

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('promo benchmark resume and report', () => {
    it('preserves samples and keeps secrets and errors out of artifacts', async () => {
        const temporaryRoot = mkdtempSync(
            path.join(tmpdir(), 'topskip-promo-benchmark-'),
        );
        temporaryRoots.push(temporaryRoot);
        cpSync(
            path.resolve(REPO_ROOT, 'benchmarks'),
            path.resolve(temporaryRoot, 'benchmarks'),
            { recursive: true },
        );
        rmSync(
            path.resolve(
                temporaryRoot,
                'benchmarks/promo-detection/runs/',
                'direct-api-v3-prompt-v4-default-model-default',
            ),
            { recursive: true, force: true },
        );
        const preflight = runBenchmarkPreflight({
            repoRoot: temporaryRoot,
            requestedModelIds: ['glm-5.2'],
            reasoning: 'default',
        });
        let requestCount = 0;
        const first = await runBenchmarkMatrix({
            repoRoot: temporaryRoot,
            preflight,
            baseUrl: 'https://SECRET_HOST_SENTINEL.invalid/api/v1',
            apiKey: 'SECRET_KEY_SENTINEL',
            fetchFunction: () => {
                requestCount += 1;
                if (requestCount === 1) {
                    return Promise.resolve(
                        new Response('SENSITIVE_FAILURE_TEXT', {
                            status: 500,
                        }),
                    );
                }
                return Promise.resolve(responseStream());
            },
        });
        expect(first).toEqual({ completed: 30, resumed: 0, total: 30 });

        const samplePath = path.resolve(
            temporaryRoot,
            'benchmarks/promo-detection/runs/',
            'direct-api-v3-prompt-v4-default-model-default/samples/glm-5.2/',
            'repeat-1/mc9WVVAUQGE.json',
        );
        const firstSample = readFileSync(samplePath, 'utf8');
        const resumed = await runBenchmarkMatrix({
            repoRoot: temporaryRoot,
            preflight,
            baseUrl: 'https://SECRET_HOST_SENTINEL.invalid/api/v1',
            apiKey: 'SECRET_KEY_SENTINEL',
            fetchFunction: () =>
                Promise.reject(
                    new Error('Resume unexpectedly performed inference.'),
                ),
        });
        expect(resumed).toEqual({ completed: 30, resumed: 30, total: 30 });
        expect(readFileSync(samplePath, 'utf8')).toBe(firstSample);

        const readmePath = writeBenchmarkReadme(temporaryRoot);
        const readme = readFileSync(readmePath, 'utf8');
        const artifacts = readJsonArtifacts(
            path.resolve(temporaryRoot, 'benchmarks/promo-detection'),
        );
        for (const forbidden of [
            'SECRET_HOST_SENTINEL',
            'SECRET_KEY_SENTINEL',
            'REQUEST_ID_SENTINEL',
            'PROVIDER_SENTINEL',
            'SECRET_REASONING_SENTINEL',
            'SENSITIVE_FAILURE_TEXT',
        ]) {
            expect(artifacts).not.toContain(forbidden);
            expect(readme).not.toContain(forbidden);
        }
        expect(readme).toContain('| Quality rank | Model | Harness | Corpus |');
        expect(readme).toContain('| Detection F1 | Time overlap |');
        expect(readme).not.toContain('Video macro-F1');
        expect(readme).not.toContain('## Historical archive');
        expect(readme).toContain(
            '| — | glm-5.2 | Direct API | promo-paid-v2 | default | 29/30 |',
        );
        expect(readme).toContain(
            '| archive | gpt-5.6-sol | Codex agent | promo-paid-v1 | max |',
        );
        expect(readme).toContain('| $0.0002 | 110 |');

        const mismatchedPromptSample = path.resolve(
            temporaryRoot,
            'benchmarks/promo-detection/runs/',
            'direct-api-v3-prompt-v4-default-model-default/samples/glm-5.2/',
            'repeat-1/daXaTug8rL4.json',
        );
        writeFileSync(
            mismatchedPromptSample,
            readFileSync(mismatchedPromptSample, 'utf8').replace(
                preflight.promptSha256,
                '0'.repeat(64),
            ),
            'utf8',
        );
        let requestsAfterMismatch = 0;
        await expect(
            runBenchmarkMatrix({
                repoRoot: temporaryRoot,
                preflight,
                baseUrl: 'https://SECRET_HOST_SENTINEL.invalid/api/v1',
                apiKey: 'SECRET_KEY_SENTINEL',
                fetchFunction: () => {
                    requestsAfterMismatch += 1;
                    return Promise.resolve(responseStream());
                },
            }),
        ).rejects.toThrow('Existing benchmark sample does not match the run.');
        expect(requestsAfterMismatch).toBe(0);
        expect(() => writeBenchmarkReadme(temporaryRoot)).toThrow(
            'Active sample does not match the leaderboard group.',
        );
    });
});
