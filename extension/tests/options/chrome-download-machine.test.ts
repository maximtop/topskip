import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createActor } from 'xstate';

import { chromeDownloadMachine } from '@/options/chrome-download-machine';

type MonitorCallback = (ev: { loaded: number }) => void;

let availabilityResult: string;
let createBehavior: 'resolve' | 'reject' | 'hang';
let createErrorMessage: string;
let monitorCallbacks: MonitorCallback[];
let createResolve: ((session: { destroy: () => void }) => void) | null;

/**
 * Installs a mock `LanguageModel` on `globalThis` (as it would appear
 * in a Chrome extension page with the Prompt API enabled).
 */
function installLanguageModelMock(): void {
    monitorCallbacks = [];
    createResolve = null;

    const mockLM = {
        availability: vi.fn(() => Promise.resolve(availabilityResult)),
        create: vi.fn(
            (opts?: {
                monitor?: (m: unknown) => void;
                signal?: AbortSignal;
            }) => {
                return new Promise<{ destroy: () => void }>(
                    (resolve, reject) => {
                        if (opts?.monitor) {
                            const mockMonitor = {
                                addEventListener: (
                                    _name: string,
                                    cb: MonitorCallback,
                                ) => {
                                    monitorCallbacks.push(cb);
                                },
                            };
                            opts.monitor(mockMonitor);
                        }
                        if (createBehavior === 'resolve') {
                            resolve({ destroy: vi.fn() });
                        } else if (createBehavior === 'reject') {
                            reject(new Error(createErrorMessage));
                        } else {
                            // 'hang' — store resolve for manual triggering
                            createResolve = resolve;
                        }
                    },
                );
            },
        ),
    };

    Object.defineProperty(globalThis, 'LanguageModel', {
        value: mockLM,
        writable: true,
        configurable: true,
    });
}

/**
 * Removes the mock `LanguageModel` from `globalThis`.
 */
function removeLanguageModelMock(): void {
    Reflect.deleteProperty(globalThis, 'LanguageModel');
}

describe('chromeDownloadMachine', () => {
    beforeEach(() => {
        availabilityResult = 'downloadable';
        createBehavior = 'hang';
        createErrorMessage = 'download failed';
        installLanguageModelMock();
    });

    afterEach(() => {
        removeLanguageModelMock();
    });

    it(
        'transitions to downloadable when availability is' + ' downloadable',
        async () => {
            availabilityResult = 'downloadable';

            const actor = createActor(chromeDownloadMachine);
            actor.start();

            await vi.waitFor(() => {
                expect(actor.getSnapshot().value).toBe('downloadable');
            });

            actor.stop();
        },
    );

    it(
        'transitions to unavailable when availability is' + ' unavailable',
        async () => {
            availabilityResult = 'unavailable';

            const actor = createActor(chromeDownloadMachine);
            actor.start();

            await vi.waitFor(() => {
                expect(actor.getSnapshot().value).toBe('unavailable');
            });

            actor.stop();
        },
    );

    it('transitions to ready when availability is available', async () => {
        availabilityResult = 'available';

        const actor = createActor(chromeDownloadMachine);
        actor.start();

        await vi.waitFor(() => {
            expect(actor.getSnapshot().value).toBe('ready');
        });

        actor.stop();
    });

    it(
        'transitions to downloading when availability is' + ' downloading',
        async () => {
            availabilityResult = 'downloading';

            const actor = createActor(chromeDownloadMachine);
            actor.start();

            await vi.waitFor(() => {
                expect(actor.getSnapshot().value).toBe('downloading');
            });

            actor.stop();
        },
    );

    it('transitions to unavailable when LanguageModel is absent', async () => {
        removeLanguageModelMock();

        const actor = createActor(chromeDownloadMachine);
        actor.start();

        await vi.waitFor(() => {
            expect(actor.getSnapshot().value).toBe('unavailable');
        });

        actor.stop();
    });

    it('transitions to error when availability() throws', async () => {
        const mockLM = Reflect.get(globalThis, 'LanguageModel') as {
            availability: ReturnType<typeof vi.fn>;
        };
        mockLM.availability.mockRejectedValueOnce(new Error('API failure'));

        const actor = createActor(chromeDownloadMachine);
        actor.start();

        await vi.waitFor(() => {
            expect(actor.getSnapshot().value).toBe('error');
        });

        expect(actor.getSnapshot().context.error).toBe('API failure');

        actor.stop();
    });

    it('DOWNLOAD from downloadable starts downloading with monitor', async () => {
        availabilityResult = 'downloadable';
        createBehavior = 'hang';

        const actor = createActor(chromeDownloadMachine);
        actor.start();

        await vi.waitFor(() => {
            expect(actor.getSnapshot().value).toBe('downloadable');
        });

        actor.send({ type: 'DOWNLOAD' });

        expect(actor.getSnapshot().value).toBe('downloading');
        expect(actor.getSnapshot().context.progress).toBe(0);

        // Simulate progress events from the monitor
        expect(monitorCallbacks.length).toBeGreaterThan(0);
        monitorCallbacks[0]({ loaded: 0.5 });

        await vi.waitFor(() => {
            expect(actor.getSnapshot().context.progress).toBe(50);
        });

        actor.stop();
    });

    it(
        'tracks progress from monitor events and marks' + ' extracting at 100%',
        async () => {
            availabilityResult = 'downloadable';
            createBehavior = 'hang';

            const actor = createActor(chromeDownloadMachine);
            actor.start();

            await vi.waitFor(() => {
                expect(actor.getSnapshot().value).toBe('downloadable');
            });

            actor.send({ type: 'DOWNLOAD' });

            // Simulate progress events
            monitorCallbacks[0]({ loaded: 0.25 });
            await vi.waitFor(() => {
                expect(actor.getSnapshot().context.progress).toBe(25);
                expect(actor.getSnapshot().context.extracting).toBe(false);
            });

            monitorCallbacks[0]({ loaded: 1 });
            await vi.waitFor(() => {
                expect(actor.getSnapshot().context.progress).toBe(100);
                expect(actor.getSnapshot().context.extracting).toBe(true);
            });

            // create() resolves — model is ready
            createResolve?.({ destroy: vi.fn() });
            await vi.waitFor(() => {
                expect(actor.getSnapshot().value).toBe('ready');
            });

            actor.stop();
        },
    );

    it('transitions to error when create() rejects', async () => {
        availabilityResult = 'downloadable';
        createBehavior = 'reject';
        createErrorMessage = 'Chrome Built-in AI is not available';

        const actor = createActor(chromeDownloadMachine);
        actor.start();

        await vi.waitFor(() => {
            expect(actor.getSnapshot().value).toBe('downloadable');
        });

        actor.send({ type: 'DOWNLOAD' });

        await vi.waitFor(() => {
            expect(actor.getSnapshot().value).toBe('error');
        });

        expect(actor.getSnapshot().context.error).toBe(
            'Chrome Built-in AI is not available',
        );

        actor.stop();
    });

    it('RETRY from error returns to checking', async () => {
        availabilityResult = 'downloadable';
        createBehavior = 'reject';
        createErrorMessage = 'download failed';

        const actor = createActor(chromeDownloadMachine);
        actor.start();

        await vi.waitFor(() => {
            expect(actor.getSnapshot().value).toBe('downloadable');
        });

        actor.send({ type: 'DOWNLOAD' });

        await vi.waitFor(() => {
            expect(actor.getSnapshot().value).toBe('error');
        });

        // Fix availability for retry
        availabilityResult = 'available';
        const mockLM = Reflect.get(globalThis, 'LanguageModel') as {
            availability: ReturnType<typeof vi.fn>;
        };
        mockLM.availability.mockResolvedValueOnce('available');

        actor.send({ type: 'RETRY' });

        await vi.waitFor(() => {
            expect(actor.getSnapshot().value).toBe('ready');
        });

        actor.stop();
    });
});
