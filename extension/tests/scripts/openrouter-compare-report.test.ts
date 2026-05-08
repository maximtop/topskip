import { describe, expect, it } from 'vitest';

import {
    extractJsonObjectFromMixedLog,
    parseOpenRouterComparePresetsLog,
    renderOpenRouterCompareHtml,
} from '../../scripts/lib/openrouter-compare-report';

function buildSampleLog(): string {
    return [
        '> topskip-extension openrouter:compare-presets',
        'prefix line before json',
        JSON.stringify(
            {
                generatedAt: '2026-04-15T10:26:50.110Z',
                source: {
                    fixture: 'scripts/fixtures/demo.txt',
                    reference: 'scripts/fixtures/reference.json',
                    out: 'tmp/demo.json',
                },
                presetCount: 1,
                rows: [
                    {
                        model: 'openai/gpt-5.4',
                        responseModel: 'openai/gpt-5.4-20260305',
                        ms: 1692,
                        ok: true,
                        usage: {
                            promptTokens: 14523,
                            completionTokens: 71,
                            totalTokens: 14594,
                            cost: 0.0373725,
                            completionTokensDetails: {
                                reasoningTokens: 12,
                            },
                        },
                        costAnalysis: {
                            reportedCost: 0.0373725,
                            estimatedCostUsd: 0.0373725,
                            promptCostUsd: 0.0363075,
                            completionCostUsd: 0.001065,
                        },
                        blocks: [
                            {
                                startSec: 10,
                                endSec: 20,
                                confidence: 'high',
                            },
                        ],
                        vsHuman: [
                            {
                                id: 'first',
                                humanStartSec: 9,
                                humanEndSec: 19,
                                predStartSec: 10,
                                predEndSec: 20,
                                predEndAssumed: false,
                                startDeltaSec: 1,
                                endDeltaSec: 1,
                                iouWithHuman: 0.82,
                            },
                        ],
                    },
                ],
                reference: {
                    videoId: 'vid-1',
                    humanBlocks: [
                        {
                            id: 'first',
                            startSec: 9,
                            endSec: 19,
                            startCue: 'start cue',
                            endCue: 'end cue',
                        },
                    ],
                    firstRunModel: {
                        model: 'baseline/model',
                        blocks: [{ startSec: 12, endSec: 20 }],
                    },
                },
                firstRunVsHuman: [
                    {
                        id: 'first',
                        humanStartSec: 9,
                        humanEndSec: 19,
                        predStartSec: 12,
                        predEndSec: 20,
                        predEndAssumed: false,
                        startDeltaSec: 3,
                        endDeltaSec: 1,
                        iouWithHuman: 0.58,
                    },
                ],
            },
            null,
            2,
        ),
    ].join('\n');
}

describe('extractJsonObjectFromMixedLog', () => {
    it('finds the JSON payload after shell noise', () => {
        const jsonText = extractJsonObjectFromMixedLog(buildSampleLog());
        expect(jsonText.trim().startsWith('{')).toBe(true);
        expect(jsonText).toContain('"presetCount": 1');
    });
});

describe('parseOpenRouterComparePresetsLog', () => {
    it('parses rows, reference data, and baseline metrics', () => {
        const report = parseOpenRouterComparePresetsLog(buildSampleLog());
        expect(report.presetCount).toBe(1);
        expect(report.generatedAt).toBe('2026-04-15T10:26:50.110Z');
        expect(report.source?.fixture).toBe('scripts/fixtures/demo.txt');
        expect(report.rows[0]?.model).toBe('openai/gpt-5.4');
        expect(report.rows[0]?.responseModel).toBe('openai/gpt-5.4-20260305');
        expect(report.rows[0]?.usage?.cost).toBe(0.0373725);
        expect(report.rows[0]?.costAnalysis?.reportedCost).toBe(0.0373725);
        expect(report.rows[0]?.blocks?.[0]?.confidence).toBe('high');
        expect(report.reference?.videoId).toBe('vid-1');
        expect(report.firstRunVsHuman?.[0]?.iouWithHuman).toBe(0.58);
    });
});

describe('renderOpenRouterCompareHtml', () => {
    it('renders a complete HTML report with timeline sections', () => {
        const report = parseOpenRouterComparePresetsLog(buildSampleLog());
        const html = renderOpenRouterCompareHtml(report, {
            title: 'Compare Report',
            sourceLabel: 'tmp/sample.json',
        });
        expect(html).toContain('<!doctype html>');
        expect(html).toContain('Cheapest response');
        expect(html).toContain('report-search');
        expect(html).toContain('report-sort');
        expect(html).toContain('Cost Coverage');
        expect(html).toContain('$0.0374');
        expect(html).toContain('Leaderboard');
        expect(html).toContain('Full timeline');
        expect(html).toContain('Zoomed block views');
        expect(html).toContain('Human reference');
        expect(html).toContain('openai/gpt-5.4');
        expect(html).toContain('start cue');
    });
});
