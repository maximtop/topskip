import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Prevent webextension-polyfill from throwing in Node; browser APIs are unused
// by ContentLogMessages but imported transitively via misc-runtime-messages.
vi.mock('@/shared/browser', () => ({
    default: {
        runtime: {},
        tabs: {},
    },
}));

const { ContentLogMessages } =
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
