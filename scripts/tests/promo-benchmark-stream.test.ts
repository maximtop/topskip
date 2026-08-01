import { describe, expect, it } from 'vitest';

import {
    buildBenchmarkRequestBody,
    callBenchmarkModel,
} from '../lib/promo-benchmark-core';

function streamingResponse(lines: readonly string[]): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const line of lines) {
                controller.enqueue(encoder.encode(line));
            }
            controller.close();
        },
    });
    return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
    });
}

function requestBody() {
    return buildBenchmarkRequestBody({
        model: 'glm-5.2',
        reasoning: 'default',
        messages: [
            { role: 'system', content: 'system' },
            { role: 'user', content: 'user' },
        ],
    });
}

describe('promo benchmark streaming client', () => {
    it('collects content, TTFT and detailed usage without reasoning text', async () => {
        const response = streamingResponse([
            'data: {"choices":[{"delta":{"reasoning_content":"secret"}}]}\n',
            'data: {"choices":[{"delta":{"content":"{\\"hasPromo\\":"}}]}\n',
            'data: {"choices":[{"delta":{"content":"false}"},"finish_reason":"stop"}]}\n',
            'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110,"prompt_tokens_details":{"cached_tokens":20,"cache_write_tokens":5},"completion_tokens_details":{"reasoning_tokens":4}}}\n',
            'data: [DONE]\n',
        ]);
        const times = [0, 100, 600];
        const result = await callBenchmarkModel({
            baseUrl: 'https://benchmark.invalid/api/v1',
            apiKey: 'secret',
            body: requestBody(),
            fetchFunction: () => Promise.resolve(response),
            now: () => times.shift() ?? 600,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) {
            return;
        }
        expect(result.rawAssistant).toBe('{"hasPromo":false}');
        expect(result.rawAssistant).not.toContain('secret');
        expect(result.ttftMs).toBe(100);
        expect(result.latencyMs).toBe(600);
        expect(result.outputTokensPerSecond).toBe(20);
        expect(result.usage).toEqual({
            promptTokens: 100,
            completionTokens: 10,
            totalTokens: 110,
            cachedTokens: 20,
            cacheWriteTokens: 5,
            reasoningTokens: 4,
        });
    });

    it('classifies a stream without DONE as truncated', async () => {
        const response = streamingResponse([
            'data: {"choices":[{"delta":{"content":"partial"}}]}\n',
        ]);
        const times = [0, 50, 100];
        const result = await callBenchmarkModel({
            baseUrl: 'https://benchmark.invalid/api/v1',
            apiKey: 'secret',
            body: requestBody(),
            fetchFunction: () => Promise.resolve(response),
            now: () => times.shift() ?? 100,
        });

        expect(result).toMatchObject({
            ok: false,
            errorKind: 'stream_truncated',
            rawAssistant: 'partial',
            ttftMs: 50,
            latencyMs: 100,
        });
    });
});
