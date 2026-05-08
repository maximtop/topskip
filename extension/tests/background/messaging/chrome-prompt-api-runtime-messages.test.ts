import { afterEach, describe, expect, it, vi } from 'vitest';

const { ChromePromptApiRuntimeMessages } =
    await import('@/background/messaging/chrome-prompt-api-runtime-messages');

describe('ChromePromptApiRuntimeMessages', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    describe('GET_CHROME_PROMPT_API_STATUS', () => {
        it('returns unavailable when LanguageModel is absent', async () => {
            const result =
                await ChromePromptApiRuntimeMessages.handleGetStatus();

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.availability).toBe('unavailable');
                expect(result.downloadProgress).toBeNull();
            }
        });

        it('returns current availability from LanguageModel', async () => {
            vi.stubGlobal('LanguageModel', {
                availability: vi.fn().mockResolvedValue('available'),
                create: vi.fn(),
            });

            const result =
                await ChromePromptApiRuntimeMessages.handleGetStatus();

            expect(result.ok).toBe(true);
            if (result.ok) {
                expect(result.availability).toBe('available');
            }
        });
    });

    describe('TRIGGER_CHROME_MODEL_DOWNLOAD', () => {
        it('returns error when LanguageModel is absent', () => {
            const result =
                ChromePromptApiRuntimeMessages.handleTriggerDownload();

            expect(result.ok).toBe(false);
            if (!result.ok) {
                expect(result.error).toContain('not available');
            }
        });

        it('calls LanguageModel.create with monitor callback', async () => {
            const mockSession = {
                contextWindow: 4096,
                destroy: vi.fn(),
                prompt: vi.fn(),
            };
            vi.stubGlobal('LanguageModel', {
                availability: vi.fn().mockResolvedValue('downloadable'),
                create: vi.fn().mockResolvedValue(mockSession),
            });

            const result =
                ChromePromptApiRuntimeMessages.handleTriggerDownload();
            // Flush microtasks so the fire-and-forget
            // create().then(session.destroy()) runs.
            await Promise.resolve();

            expect(result.ok).toBe(true);
            const lm = Reflect.get(globalThis, 'LanguageModel') as {
                create: ReturnType<typeof vi.fn>;
            };
            expect(lm.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    monitor: expect.any(Function) as unknown,
                }),
            );
            expect(mockSession.destroy).toHaveBeenCalled();
        });

        it('tracks download progress from monitor events', async () => {
            let capturedMonitor: ((m: unknown) => void) | undefined;
            const mockSession = {
                contextWindow: 4096,
                destroy: vi.fn(),
                prompt: vi.fn(),
            };
            vi.stubGlobal('LanguageModel', {
                availability: vi.fn().mockResolvedValue('downloading'),
                create: vi
                    .fn()
                    .mockImplementation(
                        (opts: { monitor?: (m: unknown) => void }) => {
                            capturedMonitor = opts.monitor;
                            return Promise.resolve(mockSession);
                        },
                    ),
            });

            ChromePromptApiRuntimeMessages.handleTriggerDownload();
            // Flush microtasks so session.destroy() and downloadProgress reset
            // run before we fire the progress event — otherwise the reset would
            // clobber our 50.
            await Promise.resolve();

            // Simulate a progress event via the captured monitor callback.
            expect(capturedMonitor).toBeDefined();
            const fakeMonitor = {
                addEventListener: vi.fn(),
            };
            capturedMonitor!(fakeMonitor);

            // Extract the downloadprogress listener and fire it.
            const [eventName, listener] = fakeMonitor.addEventListener.mock
                .calls[0] as [
                string,
                (ev: { loaded: number; total: number }) => void,
            ];
            expect(eventName).toBe('downloadprogress');
            listener({ loaded: 50, total: 100 });

            // Query status to verify progress was recorded.
            const statusResult =
                await ChromePromptApiRuntimeMessages.handleGetStatus();

            expect(statusResult.ok).toBe(true);
            if (statusResult.ok) {
                expect(statusResult.downloadProgress).toBe(50);
            }
        });
    });
});
