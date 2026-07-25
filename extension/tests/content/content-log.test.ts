import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMessage } = vi.hoisted(() => ({
    sendMessage: vi.fn(),
}));

vi.mock('@/shared/browser', () => ({
    default: {
        runtime: { sendMessage },
    },
}));

describe('contentLog', () => {
    beforeEach(() => {
        vi.resetModules();
        sendMessage.mockReset();
    });

    it('swallows a synchronous invalidated-context throw and disables later sends', async () => {
        sendMessage.mockImplementation(() => {
            throw new Error('Extension context invalidated.');
        });
        const { contentLog } = await import('@/content/content-log');

        expect(() => contentLog.info('first')).not.toThrow();
        contentLog.info('second');

        expect(sendMessage).toHaveBeenCalledOnce();
    });

    it('swallows a rejected send and disables later sends', async () => {
        sendMessage.mockRejectedValue(
            new Error('Extension context invalidated.'),
        );
        const { contentLog } = await import('@/content/content-log');

        contentLog.warn('first');
        await Promise.resolve();
        contentLog.warn('second');

        expect(sendMessage).toHaveBeenCalledOnce();
    });
});
