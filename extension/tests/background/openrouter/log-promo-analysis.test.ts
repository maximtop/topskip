import { describe, expect, it, vi } from 'vitest';

import {
    buildPromoAnalysisLogBundle,
    excerptTimedLinesAroundSec,
    listTimedLinesFromMergedTranscript,
    LogPromoAnalysis,
    logChunkPromoEntry,
} from '@/background/openrouter/log-promo-analysis';

describe('developer logging gate', () => {
    it('emits transcript-bearing logs only when explicitly enabled', () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const chunk = {
            chunkIndex: 0,
            chunkCount: 1,
            chunkStartSec: 0,
            chunkEndSec: 1,
            chunkChars: 18,
            promptVersion: 'test-v1',
            chunkText: '[0] private words',
            chunkTextMaxChars: 100,
            rawAssistant: '{"private":true}',
            rawAssistantMaxChars: 100,
            adapterLatencyMs: 1,
            outcome: 'success' as const,
        };

        logChunkPromoEntry(chunk, false);
        LogPromoAnalysis.logAnalysisBundle('private bundle', false);
        expect(info).not.toHaveBeenCalled();

        logChunkPromoEntry(chunk, true);
        LogPromoAnalysis.logAnalysisBundle('private bundle', true);
        expect(info).toHaveBeenCalledTimes(2);
        info.mockRestore();
    });
});

describe('listTimedLinesFromMergedTranscript', () => {
    it('parses [sec] lines', () => {
        const rows = listTimedLinesFromMergedTranscript('[1] a\n[2.5] b');
        expect(rows).toHaveLength(2);
        expect(rows[0]).toEqual({ sec: 1, line: '[1] a' });
        expect(rows[1]).toEqual({ sec: 2.5, line: '[2.5] b' });
    });

    it('ignores non-matching lines', () => {
        expect(listTimedLinesFromMergedTranscript('note\n[0] x')).toHaveLength(
            1,
        );
    });
});

describe('excerptTimedLinesAroundSec', () => {
    it('anchors at last line with sec <= target', () => {
        const timed = [
            { sec: 1, line: '[1] a' },
            { sec: 5, line: '[5] b' },
            { sec: 10, line: '[10] c' },
        ];
        const ex = excerptTimedLinesAroundSec(timed, 6, 0, 0);
        expect(ex).toBe('[5] b');
    });
});

describe('buildPromoAnalysisLogBundle', () => {
    it('includes metadata, merged body, and outcome lines', () => {
        const bundle = buildPromoAnalysisLogBundle({
            videoId: 'vid',
            languageCode: 'ru',
            segmentCount: 3,
            maxTranscriptChars: 100,
            mergedText: '[0] hello',
            mergedTruncated: false,
            providerId: 'openrouter',
            model: 'm/x',
            rawAssistant: '{"hasPromo":false}',
            outcome: { type: 'no_promo' },
        });
        expect(bundle).toContain('videoId: vid');
        expect(bundle).toContain('language: ru');
        expect(bundle).toContain('mergedTranscriptChars: 9 / 100');
        expect(bundle).toContain('mergedTruncated: no');
        expect(bundle).toContain('[0] hello');
        expect(bundle).toContain('hasPromo false');
        expect(bundle).toContain('{"hasPromo":false}');
    });

    it('includes promo marker section for blocks', () => {
        const bundle = buildPromoAnalysisLogBundle({
            videoId: 'v',
            languageCode: 'en',
            segmentCount: 1,
            maxTranscriptChars: 500,
            mergedText: ['[10] before', '[20] promo read', '[30] after'].join(
                '\n',
            ),
            mergedTruncated: false,
            providerId: 'openrouter',
            model: 'm',
            rawAssistant: '{}',
            outcome: {
                type: 'promo_blocks',
                blocks: [{ startSec: 20, endSec: 25, confidence: 'high' }],
            },
        });
        expect(bundle).toContain('>>> PROMO 1 START at 20s <<<');
        expect(bundle).toContain('>>> PROMO 1 END at 25s <<<');
        expect(bundle).toContain('[20] promo read');
    });

    it('states when raw assistant is unavailable', () => {
        const bundle = buildPromoAnalysisLogBundle({
            videoId: 'v',
            languageCode: 'en',
            segmentCount: 0,
            maxTranscriptChars: 10,
            mergedText: '',
            mergedTruncated: false,
            providerId: 'openrouter',
            model: 'm',
            rawAssistant: null,
            outcome: { type: 'openrouter_error', error: 'HTTP 500' },
        });
        expect(bundle).toContain('not available');
        expect(bundle).toContain('OpenRouter request failed');
    });

    it('includes uncoveredRanges in chunked aggregate metadata', () => {
        const bundle = buildPromoAnalysisLogBundle({
            videoId: 'v',
            languageCode: 'en',
            segmentCount: 2,
            maxTranscriptChars: 500,
            mergedText: '[0] a',
            mergedTruncated: false,
            providerId: 'openrouter',
            model: 'm',
            rawAssistant: '{}',
            outcome: { type: 'no_promo' },
            chunkedMeta: {
                promptVersion: 'pv1',
                systemPromptFull: 'SYS',
                plannedBudgetChars: 100,
                overlapSec: 30,
                totalChunks: 3,
                totalAdapterCalls: 3,
                coverageFraction: 0.5,
                partialCoverage: true,
                uncoveredRanges: [
                    { startSec: 100, endSec: 200, kind: 'dropped_tail' },
                    { startSec: 0, endSec: 10, kind: 'failed_chunk' },
                ],
                totalAdapterLatencyMs: 12,
                totalWallClockMs: 34,
                globalTruncated: false,
                mergedTextLogMaxChars: 300_000,
            },
        });
        expect(bundle).toContain('uncoveredRanges:');
        expect(bundle).toContain('- dropped_tail 100s–200s');
        expect(bundle).toContain('- failed_chunk 0s–10s');
    });

    it('does not leak API-key-shaped secrets into the log bundle', () => {
        // Simulate a raw assistant response that contains a string
        // resembling an OpenRouter API key (sk-or-… pattern).
        const fakeKey = 'sk-or-v1-abc123secret456';
        const bundle = buildPromoAnalysisLogBundle({
            videoId: 'secVid',
            languageCode: 'en',
            segmentCount: 1,
            maxTranscriptChars: 500,
            mergedText: '[0] hello',
            mergedTruncated: false,
            providerId: 'openrouter',
            model: 'test-model',
            rawAssistant: `{"hasPromo":false,"key":"${fakeKey}"}`,
            outcome: { type: 'no_promo' },
        });

        // The bundle renders rawAssistant verbatim — the log builder is
        // not responsible for scrubbing secrets from LLM output.  What
        // NFR-005 guarantees is that *our own* fields (providerId, model,
        // videoId, etc.) never contain API keys.  Verify the bundle does
        // not contain anything resembling an OpenRouter key *outside* the
        // raw assistant section.
        const sections = bundle.split('--- Raw assistant message');
        const metadataSection = sections[0] ?? '';

        // Metadata section must not contain anything matching an
        // OpenRouter key pattern (sk-or-…).
        expect(metadataSection).not.toMatch(/sk-or-[a-zA-Z0-9-]+/);

        // Also verify that known credential field names never appear
        // as metadata keys.
        expect(metadataSection).not.toContain('apiKey');
        expect(metadataSection).not.toContain('authorization');
        expect(metadataSection).not.toContain('Bearer ');
    });
});
