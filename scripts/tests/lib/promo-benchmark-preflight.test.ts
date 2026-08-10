import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    buildBenchmarkMessages,
    buildBenchmarkRequestBody,
    loadCorpusManifest,
    runBenchmarkPreflight,
} from '../../lib/promo-benchmark-core';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

describe('promo benchmark preflight', () => {
    it('validates the pinned bilingual corpus and default matrix', () => {
        const preflight = runBenchmarkPreflight({
            repoRoot: REPO_ROOT,
            requestedModelIds: [],
            reasoning: 'default',
        });

        expect(preflight.manifest.itemCount).toBe(10);
        expect(preflight.models).toHaveLength(12);
        expect(preflight.requestCount).toBe(360);
        expect(
            preflight.manifest.items.filter(
                (item) => item.languageCode === 'en',
            ),
        ).toHaveLength(5);
        expect(
            preflight.manifest.items.filter(
                (item) => item.languageCode === 'ru',
            ),
        ).toHaveLength(5);
        expect(
            preflight.manifest.items.find(
                (item) => item.videoId === 'YP73B9D20V4',
            )?.transcriptHash,
        ).toBe(
            '651541d0a57b4bb341427ee6445c71c4c83bf8eb584c218c680ac99a95ccc1ae',
        );
        expect(
            preflight.manifest.items.find(
                (item) => item.videoId === 'OUunDHYY-xk',
            )?.transcriptHash,
        ).toBe(
            '2b07323ae62651cc17ba56b22a50879c0da35862ae50be23845978febd3302a6',
        );

        const historical = loadCorpusManifest(
            path.resolve(
                REPO_ROOT,
                'benchmarks/promo-detection/corpus/manifest-v1.json',
            ),
        );
        expect(historical.itemCount).toBe(10);
        expect(
            new Set(
                [...preflight.manifest.items, ...historical.items].map(
                    (item) => item.fixturePath,
                ),
            ).size,
        ).toBe(12);
    });

    it('sends identical messages and omits default reasoning', () => {
        const preflight = runBenchmarkPreflight({
            repoRoot: REPO_ROOT,
            requestedModelIds: ['glm-5.2', 'gpt-5.6-sol'],
            reasoning: 'default',
        });
        const item = preflight.manifest.items[0];
        const messages = buildBenchmarkMessages(preflight.corpusRoot, item);
        const first = buildBenchmarkRequestBody({
            model: 'glm-5.2',
            messages,
            reasoning: 'default',
        });
        const second = buildBenchmarkRequestBody({
            model: 'gpt-5.6-sol',
            messages,
            reasoning: 'default',
        });

        expect(first.messages).toEqual(second.messages);
        expect(Object.hasOwn(first, 'reasoning_effort')).toBe(false);
        expect(Object.hasOwn(second, 'reasoning_effort')).toBe(false);
        expect(Object.hasOwn(first, 'max_tokens')).toBe(false);
        expect(Object.hasOwn(second, 'max_tokens')).toBe(false);
    });

    it('rejects an unsupported effort before inference', () => {
        expect(() =>
            runBenchmarkPreflight({
                repoRoot: REPO_ROOT,
                requestedModelIds: ['kimi-k3'],
                reasoning: 'none',
            }),
        ).toThrow('Requested reasoning is unsupported.');
    });
});
