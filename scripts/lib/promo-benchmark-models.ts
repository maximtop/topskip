export const BENCHMARK_REASONING_LEVELS = [
    'default',
    'none',
    'low',
    'medium',
    'high',
    'xhigh',
] as const;

export type BenchmarkReasoning =
    (typeof BENCHMARK_REASONING_LEVELS)[number];

export type ExplicitBenchmarkReasoning = Exclude<
    BenchmarkReasoning,
    'default'
>;

export type BenchmarkPricing = {
    inputPerMillion: number;
    outputPerMillion: number;
    cacheReadPerMillion: number;
    cacheWritePerMillion: number;
    reasoningPerMillion: number;
};

export type BenchmarkModel = {
    id: string;
    supportedReasoning: readonly ExplicitBenchmarkReasoning[];
    pricing: BenchmarkPricing;
};

export const PROMO_BENCHMARK_MODELS: readonly BenchmarkModel[] = [
    {
        id: 'glm-5.2',
        supportedReasoning: ['none', 'medium', 'high'],
        pricing: {
            inputPerMillion: 1.4,
            outputPerMillion: 4.4,
            cacheReadPerMillion: 0.26,
            cacheWritePerMillion: 1.4,
            reasoningPerMillion: 4.4,
        },
    },
    {
        id: 'kimi-k3',
        supportedReasoning: ['low', 'high', 'xhigh'],
        pricing: {
            inputPerMillion: 3,
            outputPerMillion: 15,
            cacheReadPerMillion: 0.3,
            cacheWritePerMillion: 3,
            reasoningPerMillion: 15,
        },
    },
    {
        id: 'deepseek-v4-flash',
        supportedReasoning: ['none', 'high', 'xhigh'],
        pricing: {
            inputPerMillion: 0.14,
            outputPerMillion: 0.28,
            cacheReadPerMillion: 0.0028,
            cacheWritePerMillion: 0.14,
            reasoningPerMillion: 0.28,
        },
    },
    {
        id: 'deepseek-v4-pro',
        supportedReasoning: ['none', 'high', 'xhigh'],
        pricing: {
            inputPerMillion: 0.435,
            outputPerMillion: 0.87,
            cacheReadPerMillion: 0.003625,
            cacheWritePerMillion: 0.435,
            reasoningPerMillion: 0.87,
        },
    },
    {
        id: 'hy3',
        supportedReasoning: ['none', 'low', 'high'],
        pricing: {
            inputPerMillion: 0.14,
            outputPerMillion: 0.58,
            cacheReadPerMillion: 0.035,
            cacheWritePerMillion: 0.14,
            reasoningPerMillion: 0.58,
        },
    },
    {
        id: 'grok-4.5',
        supportedReasoning: ['none', 'low', 'medium', 'high'],
        pricing: {
            inputPerMillion: 2,
            outputPerMillion: 6,
            cacheReadPerMillion: 0.5,
            cacheWritePerMillion: 2,
            reasoningPerMillion: 6,
        },
    },
    {
        id: 'gpt-5.6-sol',
        supportedReasoning: ['none', 'low', 'medium', 'high', 'xhigh'],
        pricing: {
            inputPerMillion: 5,
            outputPerMillion: 30,
            cacheReadPerMillion: 0.5,
            cacheWritePerMillion: 6.25,
            reasoningPerMillion: 30,
        },
    },
    {
        id: 'sonnet-5',
        supportedReasoning: ['none', 'low', 'medium', 'high', 'xhigh'],
        pricing: {
            inputPerMillion: 2,
            outputPerMillion: 10,
            cacheReadPerMillion: 0.2,
            cacheWritePerMillion: 2.5,
            reasoningPerMillion: 10,
        },
    },
    {
        id: 'opus-5',
        supportedReasoning: ['none', 'low', 'medium', 'high', 'xhigh'],
        pricing: {
            inputPerMillion: 5,
            outputPerMillion: 25,
            cacheReadPerMillion: 0.5,
            cacheWritePerMillion: 6.25,
            reasoningPerMillion: 25,
        },
    },
    {
        id: 'gpt-5.6-terra',
        supportedReasoning: ['none', 'low', 'medium', 'high', 'xhigh'],
        pricing: {
            inputPerMillion: 2,
            outputPerMillion: 12,
            cacheReadPerMillion: 0.2,
            cacheWritePerMillion: 2.5,
            reasoningPerMillion: 12,
        },
    },
    {
        id: 'gpt-5.6-luna',
        supportedReasoning: ['none', 'low', 'medium', 'high', 'xhigh'],
        pricing: {
            inputPerMillion: 0.2,
            outputPerMillion: 1.2,
            cacheReadPerMillion: 0.02,
            cacheWritePerMillion: 0.25,
            reasoningPerMillion: 1.2,
        },
    },
    {
        id: 'gemini-3.6-flash',
        supportedReasoning: ['none', 'low', 'medium', 'high', 'xhigh'],
        pricing: {
            inputPerMillion: 1.5,
            outputPerMillion: 7.5,
            cacheReadPerMillion: 0.15,
            cacheWritePerMillion: 1.5,
            reasoningPerMillion: 7.5,
        },
    },
] as const;
