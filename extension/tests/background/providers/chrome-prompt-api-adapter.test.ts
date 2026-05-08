import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    PROVIDER_AVAILABILITY,
    PROVIDER_ID,
    type AnalyzeTranscriptParams,
} from '@/background/providers/llm-provider-adapter';

/**
 * Minimal mock for a LanguageModel session.
 */
function makeSession(
    overrides?: Partial<{
        contextWindow: number;
        contextUsage: number;
        measureContextUsageResult: number;
        promptResult: string;
        promptError: Error | null;
    }>,
) {
    const contextWindow = overrides?.contextWindow ?? 4096;
    const contextUsage = overrides?.contextUsage ?? 0;
    // Default: fits in budget (returns 0 tokens used by transcript).
    const measureContextUsageResult = overrides?.measureContextUsageResult ?? 0;
    const promptResult =
        overrides?.promptResult ?? JSON.stringify({ hasPromo: false });
    const promptError = overrides?.promptError ?? null;

    return {
        contextWindow,
        contextUsage,
        measureContextUsage: vi
            .fn()
            .mockResolvedValue(measureContextUsageResult),
        prompt: promptError
            ? vi.fn().mockRejectedValue(promptError)
            : vi.fn().mockResolvedValue(promptResult),
        destroy: vi.fn(),
    };
}

/**
 * Minimal mock for the LanguageModel static interface.
 */
function makeLanguageModelGlobal(
    overrides?: Partial<{
        availabilityResult: string;
        session: ReturnType<typeof makeSession>;
        createError: Error | null;
    }>,
) {
    const availabilityResult = overrides?.availabilityResult ?? 'available';
    const session = overrides?.session ?? makeSession();
    const createError = overrides?.createError ?? null;

    return {
        availability: vi.fn().mockResolvedValue(availabilityResult),
        create: createError
            ? vi.fn().mockRejectedValue(createError)
            : vi.fn().mockResolvedValue(session),
    };
}

// Must import after mock setup so vi.mock takes effect.
const { ChromePromptApiAdapter } =
    await import('@/background/providers/chrome-prompt-api-adapter');

const baseParams: AnalyzeTranscriptParams = {
    transcript: 'videoId=abc\nlanguage=en\n\nHello world this is a transcript.',
    videoId: 'abc',
    languageCode: 'en',
    durationSec: 300,
};

describe('ChromePromptApiAdapter', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    describe('properties', () => {
        it('has id matching PROVIDER_ID.ChromePromptApi', () => {
            const adapter = new ChromePromptApiAdapter();
            expect(adapter.id).toBe(PROVIDER_ID.ChromePromptApi);
        });

        it('has displayName "Chrome Built-in"', () => {
            const adapter = new ChromePromptApiAdapter();
            expect(adapter.displayName).toBe('Chrome Built-in');
        });
    });

    describe('availability', () => {
        it('returns unavailable when LanguageModel is not on globalThis', async () => {
            // No stubGlobal — LanguageModel not present in test env.
            const adapter = new ChromePromptApiAdapter();
            const avail = await adapter.availability();
            expect(avail).toBe(PROVIDER_AVAILABILITY.UNAVAILABLE);
        });

        it('returns available when Chrome reports "available"', async () => {
            vi.stubGlobal(
                'LanguageModel',
                makeLanguageModelGlobal({ availabilityResult: 'available' }),
            );
            const adapter = new ChromePromptApiAdapter();
            expect(await adapter.availability()).toBe(
                PROVIDER_AVAILABILITY.AVAILABLE,
            );
        });

        it('returns downloadable when Chrome reports "downloadable"', async () => {
            vi.stubGlobal(
                'LanguageModel',
                makeLanguageModelGlobal({ availabilityResult: 'downloadable' }),
            );
            const adapter = new ChromePromptApiAdapter();
            expect(await adapter.availability()).toBe(
                PROVIDER_AVAILABILITY.DOWNLOADABLE,
            );
        });

        it('returns downloading when Chrome reports "downloading"', async () => {
            vi.stubGlobal(
                'LanguageModel',
                makeLanguageModelGlobal({ availabilityResult: 'downloading' }),
            );
            const adapter = new ChromePromptApiAdapter();
            expect(await adapter.availability()).toBe(
                PROVIDER_AVAILABILITY.DOWNLOADING,
            );
        });

        it('returns unavailable when Chrome reports "unavailable"', async () => {
            vi.stubGlobal(
                'LanguageModel',
                makeLanguageModelGlobal({ availabilityResult: 'unavailable' }),
            );
            const adapter = new ChromePromptApiAdapter();
            expect(await adapter.availability()).toBe(
                PROVIDER_AVAILABILITY.UNAVAILABLE,
            );
        });
    });

    describe('analyzeTranscript', () => {
        it('returns error when LanguageModel is not on globalThis', async () => {
            const adapter = new ChromePromptApiAdapter();
            const result = await adapter.analyzeTranscript(baseParams);
            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toContain('not available');
            }
        });

        it('creates session with system prompt and returns parsed result', async () => {
            const session = makeSession({
                promptResult: JSON.stringify({ hasPromo: false }),
            });
            const lmGlobal = makeLanguageModelGlobal({ session });
            vi.stubGlobal('LanguageModel', lmGlobal);

            const adapter = new ChromePromptApiAdapter();
            const result = await adapter.analyzeTranscript(baseParams);

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.hasPromo).toBe(false);
                expect(result.rawAssistant).toBe(
                    JSON.stringify({ hasPromo: false }),
                );
                expect(result.providerMeta).toEqual({
                    id: PROVIDER_ID.ChromePromptApi,
                    model: 'gemini-nano',
                });
            }
            // Session must have been destroyed.
            expect(session.destroy).toHaveBeenCalledOnce();
        });

        it('passes responseConstraint JSON Schema to prompt()', async () => {
            const session = makeSession({
                promptResult: JSON.stringify({ hasPromo: false }),
            });
            vi.stubGlobal(
                'LanguageModel',
                makeLanguageModelGlobal({ session }),
            );

            const adapter = new ChromePromptApiAdapter();
            await adapter.analyzeTranscript(baseParams);

            const [, opts] = session.prompt.mock.calls[0] as [
                string,
                { responseConstraint?: unknown; signal?: AbortSignal },
            ];
            expect(opts?.responseConstraint).toBeDefined();
            expect(typeof opts?.responseConstraint).toBe('object');
        });

        it('forwards the AbortSignal to create() and prompt()', async () => {
            const session = makeSession({
                promptResult: JSON.stringify({ hasPromo: false }),
            });
            const lmGlobal = makeLanguageModelGlobal({ session });
            vi.stubGlobal('LanguageModel', lmGlobal);

            const abort = new AbortController();
            const adapter = new ChromePromptApiAdapter();
            await adapter.analyzeTranscript({
                ...baseParams,
                signal: abort.signal,
            });

            expect(lmGlobal.create).toHaveBeenCalledWith(
                expect.objectContaining({ signal: abort.signal }),
            );
            expect(session.prompt).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ signal: abort.signal }),
            );
        });

        it('returns tooLarge when measureContextUsage exceeds transcript budget', async () => {
            // contextWindow = 600 → budget = 600 - 0 - 512 = 88 tokens.
            // measureContextUsage(transcript) returns 1000 > 88 → tooLarge.
            const session = makeSession({
                contextWindow: 600,
                contextUsage: 0,
                measureContextUsageResult: 1000,
            });
            vi.stubGlobal(
                'LanguageModel',
                makeLanguageModelGlobal({ session }),
            );

            const adapter = new ChromePromptApiAdapter();
            const result = await adapter.analyzeTranscript({
                ...baseParams,
                transcript: 'A'.repeat(2000),
            });

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.tooLarge).toBe(true);
            }
            expect(session.prompt).not.toHaveBeenCalled();
            expect(session.measureContextUsage).toHaveBeenCalled();
        });

        it('passes full transcript to prompt when measureContextUsage fits', async () => {
            const session = makeSession({
                contextWindow: 4096,
                contextUsage: 0,
                measureContextUsageResult: 10,
                promptResult: JSON.stringify({ hasPromo: false }),
            });
            vi.stubGlobal(
                'LanguageModel',
                makeLanguageModelGlobal({ session }),
            );

            const longTranscript = 'A'.repeat(2000);
            const adapter = new ChromePromptApiAdapter();
            await adapter.analyzeTranscript({
                ...baseParams,
                transcript: longTranscript,
            });

            const [promptArg] = session.prompt.mock.calls[0] as [
                string,
                unknown,
            ];
            expect(promptArg).toBe(longTranscript);
            expect(session.measureContextUsage).toHaveBeenCalled();
        });

        it('maxTranscriptChars uses measureContextUsage probe', async () => {
            const session = makeSession({
                contextWindow: 1000,
                contextUsage: 100,
                measureContextUsageResult: 250,
            });
            vi.stubGlobal(
                'LanguageModel',
                makeLanguageModelGlobal({ session }),
            );

            const adapter = new ChromePromptApiAdapter();
            const n = await adapter.maxTranscriptChars();
            expect(n).toBeGreaterThan(0);
            expect(session.destroy).toHaveBeenCalled();
        });

        it('returns promo blocks when LLM detects a promo', async () => {
            const session = makeSession({
                promptResult: JSON.stringify({
                    hasPromo: true,
                    promoBlocks: [{ startSec: 10, endSec: 40 }],
                }),
            });
            vi.stubGlobal(
                'LanguageModel',
                makeLanguageModelGlobal({ session }),
            );

            const adapter = new ChromePromptApiAdapter();
            const result = await adapter.analyzeTranscript(baseParams);

            expect(result.ok).toBe(true);
            if (result.ok && result.hasPromo) {
                expect(result.blocks).toEqual([{ startSec: 10, endSec: 40 }]);
                expect(result.providerMeta.model).toBe('gemini-nano');
            }
        });

        it('returns error when session creation fails', async () => {
            vi.stubGlobal(
                'LanguageModel',
                makeLanguageModelGlobal({
                    createError: new Error('Model not ready'),
                }),
            );

            const adapter = new ChromePromptApiAdapter();
            const result = await adapter.analyzeTranscript(baseParams);

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toContain('Model not ready');
            }
        });

        it('returns error and destroys session when prompt() throws', async () => {
            const session = makeSession({
                promptError: new Error('Prompt quota exceeded'),
            });
            vi.stubGlobal(
                'LanguageModel',
                makeLanguageModelGlobal({ session }),
            );

            const adapter = new ChromePromptApiAdapter();
            const result = await adapter.analyzeTranscript(baseParams);

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toContain('Prompt quota exceeded');
            }
            // Session must still be destroyed even on error.
            expect(session.destroy).toHaveBeenCalledOnce();
        });

        it('returns error when LLM response fails parse validation', async () => {
            const session = makeSession({
                promptResult: 'not valid json at all',
            });
            vi.stubGlobal(
                'LanguageModel',
                makeLanguageModelGlobal({ session }),
            );

            const adapter = new ChromePromptApiAdapter();
            const result = await adapter.analyzeTranscript(baseParams);

            expect(result.ok).toBe(false);
        });

        describe('initialPrompts system prompt', () => {
            it('passes the system prompt in initialPrompts to create()', async () => {
                const session = makeSession({
                    promptResult: JSON.stringify({ hasPromo: false }),
                });
                const lmGlobal = makeLanguageModelGlobal({ session });
                vi.stubGlobal('LanguageModel', lmGlobal);

                const adapter = new ChromePromptApiAdapter();
                await adapter.analyzeTranscript(baseParams);

                const [createOpts] = lmGlobal.create.mock.calls[0] as [
                    {
                        initialPrompts?: Array<{
                            role: string;
                            content: string;
                        }>;
                    },
                ];
                expect(createOpts?.initialPrompts?.[0]?.role).toBe('system');
                expect(typeof createOpts?.initialPrompts?.[0]?.content).toBe(
                    'string',
                );
            });
        });
    });

    describe('beforeEach reset', () => {
        beforeEach(() => {
            vi.unstubAllGlobals();
        });

        it('does not leak LanguageModel stub between tests', async () => {
            const adapter = new ChromePromptApiAdapter();
            const avail = await adapter.availability();
            expect(avail).toBe(PROVIDER_AVAILABILITY.UNAVAILABLE);
        });
    });
});
