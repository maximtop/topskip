import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));

vi.mock('@/shared/browser', () => ({
    default: { runtime: { sendMessage } },
}));

describe('contentLog (release build: dev-gated relay)', () => {
    beforeEach(() => {
        vi.resetModules();
        sendMessage.mockReset();
    });

    it('does not relay when the dev-local define is off and never throws', async () => {
        const { contentLog } = await import('@/content/content-log');
        expect(() => contentLog.info('first')).not.toThrow();
        contentLog.warn('second');
        contentLog.error('third');
        expect(sendMessage).not.toHaveBeenCalled();
    });
});
