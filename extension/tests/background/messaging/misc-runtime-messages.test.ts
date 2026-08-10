import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    tabsQuery: vi.fn(),
    detectionReady: vi.fn(),
    detectionGet: vi.fn(),
}));

// Prevent webextension-polyfill from throwing in Node; ContentLogMessages does
// not touch browser APIs, but this module pulls them in for its other exports.
vi.mock('@/shared/browser', () => ({
    default: {
        runtime: {},
        tabs: { query: mocks.tabsQuery },
    },
}));

vi.mock('@/background/promo-detection-store', () => ({
    PromoDetectionStore: {
        ready: mocks.detectionReady,
        get: mocks.detectionGet,
    },
}));

const { ContentLogMessages, PromoDetectionRuntimeMessages } =
    await import('@/background/messaging/misc-runtime-messages');

describe('ContentLogMessages.log', () => {
    beforeEach(() => {
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('calls console.info for level "info"', () => {
        ContentLogMessages.log('info', ['hello'], undefined);
        expect(console.info).toHaveBeenCalledWith('[TopSkip content]', 'hello');
    });

    it('calls console.warn for level "warn"', () => {
        ContentLogMessages.log('warn', ['careful'], undefined);
        expect(console.warn).toHaveBeenCalledWith(
            '[TopSkip content]',
            'careful',
        );
    });

    it('calls console.error for level "error"', () => {
        ContentLogMessages.log('error', ['oops'], undefined);
        expect(console.error).toHaveBeenCalledWith('[TopSkip content]', 'oops');
    });

    it('includes the tab id in the tag when tabId is provided', () => {
        ContentLogMessages.log('info', ['x'], 42);
        expect(console.info).toHaveBeenCalledWith('[TopSkip content t42]', 'x');
    });

    it('spreads multiple args into the console call', () => {
        ContentLogMessages.log('info', ['a', 'b', 'c'], undefined);
        expect(console.info).toHaveBeenCalledWith(
            '[TopSkip content]',
            'a',
            'b',
            'c',
        );
    });
});

describe('PromoDetectionRuntimeMessages.handleGet', () => {
    beforeEach(() => {
        mocks.tabsQuery.mockReset();
        mocks.detectionReady.mockReset();
        mocks.detectionGet.mockReset();
        mocks.detectionReady.mockResolvedValue(undefined);
    });

    it('returns the resolved active tab id with its snapshot', async () => {
        const state = { videoId: 'activeVideo', status: 'no_promo' };
        mocks.tabsQuery.mockResolvedValue([{ id: 82 }]);
        mocks.detectionGet.mockReturnValue(state);

        await expect(PromoDetectionRuntimeMessages.handleGet()).resolves.toEqual(
            {
                ok: true,
                tabId: 82,
                state,
            },
        );
        expect(mocks.detectionGet).toHaveBeenCalledWith(82);
    });

    it('returns an explicit null identity when no active tab exists', async () => {
        mocks.tabsQuery.mockResolvedValue([]);

        await expect(PromoDetectionRuntimeMessages.handleGet()).resolves.toEqual(
            {
                ok: true,
                tabId: null,
                state: null,
            },
        );
        expect(mocks.detectionGet).not.toHaveBeenCalled();
    });

    it('selects only the frontmost tab from two stored tab snapshots', async () => {
        const states = new Map([
            [41, { videoId: 'backgroundVideo', status: 'no_promo' }],
            [82, { videoId: 'frontVideo', status: 'no_promo' }],
        ]);
        mocks.tabsQuery.mockResolvedValue([{ id: 82 }]);
        mocks.detectionGet.mockImplementation((tabId: number) =>
            states.get(tabId),
        );

        await expect(PromoDetectionRuntimeMessages.handleGet()).resolves.toEqual(
            {
                ok: true,
                tabId: 82,
                state: states.get(82),
            },
        );
        expect(mocks.detectionGet).not.toHaveBeenCalledWith(41);
    });
});
