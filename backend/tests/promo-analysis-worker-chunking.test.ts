import { describe, expect, it } from 'vitest';

import { BackendPromoAnalysisWorker } from '@topskip/backend/analysis/promo-analysis-worker';
import type {
    BackendLlmAnalysisAdapter,
    BackendLlmAnalysisAdapterInput,
} from '@topskip/backend/analysis/promo-analysis-types';
import type { TranscriptArtifact } from '@topskip/backend/extraction/subtitle-extraction-types';

const TOTAL_SEC = 13_600;

/**
 * Uniform long transcript: one segment every 4 s (multi-chunk at 60k chars).
 *
 * @returns Cast transcript artifact for worker tests
 */
function makeArtifact(): TranscriptArtifact {
    const segments = [];
    for (let sec = 0; sec < TOTAL_SEC; sec += 4) {
        segments.push({
            startSec: sec,
            durationSec: 4,
            text: 'promo talk sample words here',
        });
    }
    return {
        artifactId: 'transcript-test',
        videoId: 'dQw4w9WgXcQ',
        algorithmVersion: 'server-v6',
        strategy: 'extension_caption_upload',
        videoDurationSec: TOTAL_SEC,
        acquiredAtMs: 1,
        segments,
        transcriptText: 'promo talk sample words here',
        sourceType: 'extension_caption_upload',
        languageCode: 'en',
        transcriptHash: 'a'.repeat(64),
    } as TranscriptArtifact;
}

/**
 * Fake adapter recording per-call chunk ranges and returning canned JSON.
 *
 * @param respond - Maps a chunk input to a raw response or a thrown error
 * @returns Adapter plus a per-call range log
 */
function makeAdapter(
    respond: (
        input: BackendLlmAnalysisAdapterInput,
        call: number,
    ) => string | Error,
): BackendLlmAnalysisAdapter & {
    calls: Array<{ firstSec: number; lastSec: number }>;
} {
    const calls: Array<{ firstSec: number; lastSec: number }> = [];
    let n = 0;
    return {
        providerId: 'openrouter',
        model: 'test/model',
        promptVersion: '4',
        calls,
        analyze(input: BackendLlmAnalysisAdapterInput) {
            const segs = input.transcriptArtifact.segments;
            calls.push({
                firstSec: segs[0].startSec,
                lastSec: segs[segs.length - 1].startSec,
            });
            n += 1;
            const out = respond(input, n);
            if (out instanceof Error) {
                throw out;
            }
            return Promise.resolve({
                rawModelResponse: out,
                model: 'test/model',
                usage: { inputTokens: 100, outputTokens: 10, costUsd: 0.01 },
            });
        },
    };
}

describe('BackendPromoAnalysisWorker chunked analysis', () => {
    it('calls the adapter once per chunk and merges blocks across chunks', async () => {
        const adapter = makeAdapter((input) => {
            const firstSec =
                input.transcriptArtifact.segments[0]?.startSec ?? 0;
            // Only the first chunk reports a block, in its own window.
            if (firstSec === 0) {
                return JSON.stringify({
                    hasPromo: true,
                    promoBlocks: [
                        { startSec: 20, endSec: 60, confidence: 'high' },
                    ],
                });
            }
            return JSON.stringify({ hasPromo: false });
        });
        const result = await BackendPromoAnalysisWorker.analyze({
            transcriptArtifact: makeArtifact(),
            durationSec: TOTAL_SEC,
            nowMs: 1_000,
            adapter,
            clock: () => 2_000,
        });
        expect(adapter.calls.length).toBeGreaterThan(1);
        // Adjacent chunk calls overlap by ~240s.
        for (let i = 1; i < adapter.calls.length; i++) {
            expect(adapter.calls[i].firstSec).toBeLessThanOrEqual(
                adapter.calls[i - 1].lastSec - 239,
            );
        }
        expect(result.terminalResponse.status).toBe('ready');
        if (result.terminalResponse.status !== 'ready') {
            return;
        }
        expect(result.terminalResponse.promoBlocks).toEqual([
            { startSec: 20, endSec: 60, confidence: 'high' },
        ]);
        // Usage is summed across chunk calls.
        expect(result.analysisRun.usage?.inputTokens).toBe(
            100 * adapter.calls.length,
        );
        expect(result.analysisRun.usage?.costUsd).toBeCloseTo(
            0.01 * adapter.calls.length,
        );
    });

    it('stitches one block reported by two overlapping chunks', async () => {
        // Probe run first: discover where the first chunk ends with this
        // transcript shape, so the real adapter can place a promo block that
        // straddles that boundary.
        const probe = makeAdapter(() => JSON.stringify({ hasPromo: false }));
        await BackendPromoAnalysisWorker.analyze({
            transcriptArtifact: makeArtifact(),
            durationSec: TOTAL_SEC,
            nowMs: 1_000,
            adapter: probe,
            clock: () => 2_000,
        });
        expect(probe.calls.length).toBeGreaterThan(1);
        const boundary = probe.calls[0].lastSec;

        // Chunk 1 sees only the first half of the promo and reports
        // [boundary-120 .. boundary]; chunk 2 (whose 240s overlap covers the
        // promo start) reports the full [boundary-120 .. boundary+120].
        const adapter = makeAdapter((input) => {
            const segs = input.transcriptArtifact.segments;
            const firstSec = segs[0].startSec;
            const lastSec = segs[segs.length - 1].startSec;
            if (firstSec === 0) {
                return JSON.stringify({
                    hasPromo: true,
                    promoBlocks: [
                        {
                            startSec: boundary - 120,
                            endSec: boundary,
                            confidence: 'high',
                        },
                    ],
                });
            }
            const seesPromoStart =
                firstSec <= boundary - 120 && lastSec >= boundary + 120;
            if (seesPromoStart) {
                return JSON.stringify({
                    hasPromo: true,
                    promoBlocks: [
                        {
                            startSec: boundary - 120,
                            endSec: boundary + 120,
                            confidence: 'high',
                        },
                    ],
                });
            }
            return JSON.stringify({ hasPromo: false });
        });

        const result = await BackendPromoAnalysisWorker.analyze({
            transcriptArtifact: makeArtifact(),
            durationSec: TOTAL_SEC,
            nowMs: 1_000,
            adapter,
            clock: () => 2_000,
        });
        expect(result.terminalResponse.status).toBe('ready');
        if (result.terminalResponse.status !== 'ready') {
            return;
        }
        expect(result.terminalResponse.promoBlocks).toHaveLength(1);
        const block = result.terminalResponse.promoBlocks[0];
        expect(block.startSec).toBe(boundary - 120);
        expect(block.endSec).toBe(boundary + 120);
    });

    it('retries a failed chunk once, then fails the whole job', async () => {
        let failures = 0;
        const adapter = makeAdapter((input) => {
            const firstSec =
                input.transcriptArtifact.segments[0]?.startSec ?? 0;
            if (firstSec > 0) {
                failures += 1;
                return new Error('provider down');
            }
            return JSON.stringify({ hasPromo: false });
        });
        const result = await BackendPromoAnalysisWorker.analyze({
            transcriptArtifact: makeArtifact(),
            durationSec: TOTAL_SEC,
            nowMs: 1_000,
            adapter,
            clock: () => 2_000,
        });
        expect(failures).toBe(2);
        expect(result.terminalResponse.status).toBe('error');
        if (result.terminalResponse.status !== 'error') {
            return;
        }
        expect(result.terminalResponse.error.code).toBe('model_provider_error');
        expect(result.analysisRun.failureReason).toBe('model_provider_error');
    });

    it('returns no_promo when every chunk is empty', async () => {
        const adapter = makeAdapter(() => JSON.stringify({ hasPromo: false }));
        const result = await BackendPromoAnalysisWorker.analyze({
            transcriptArtifact: makeArtifact(),
            durationSec: TOTAL_SEC,
            nowMs: 1_000,
            adapter,
            clock: () => 2_000,
        });
        expect(result.terminalResponse.status).toBe('no_promo');
        expect(result.analysisRun.rawModelResponse).toContain('[chunk 0');
    });
});
