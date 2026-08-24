import { beforeEach, describe, expect, it, vi } from 'vitest';

const browserMocks = vi.hoisted(() => ({
    tabsQuery: vi.fn(),
    tabsSendMessage: vi.fn(),
    runtimeSendMessage: vi.fn(),
}));

vi.mock('@/shared/browser', () => ({
    default: {
        runtime: { sendMessage: browserMocks.runtimeSendMessage },
        tabs: {
            query: browserMocks.tabsQuery,
            sendMessage: browserMocks.tabsSendMessage,
        },
    },
}));

import { DebugLogBroadcast } from '@/background/debug-log/debug-log-broadcast';
import { TOPSKIP_MESSAGE } from '@/shared/messages';

describe('DebugLogBroadcast.notifyStateChanged', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        browserMocks.tabsQuery.mockResolvedValue([{ id: 41 }, { id: undefined }, { id: 42 }]);
        browserMocks.tabsSendMessage.mockResolvedValue(undefined);
        browserMocks.runtimeSendMessage.mockResolvedValue(undefined);
    });

    it('pushes the switch state to every identified tab and to extension pages', async () => {
        await DebugLogBroadcast.notifyStateChanged(true);

        const expected = { type: TOPSKIP_MESSAGE.DEBUG_LOG_STATE_UPDATED, enabled: true };
        expect(browserMocks.tabsQuery).toHaveBeenCalledWith({});
        expect(browserMocks.tabsSendMessage).toHaveBeenCalledTimes(2);
        expect(browserMocks.tabsSendMessage).toHaveBeenCalledWith(41, expected);
        expect(browserMocks.tabsSendMessage).toHaveBeenCalledWith(42, expected);
        expect(browserMocks.runtimeSendMessage).toHaveBeenCalledWith(expected);
    });

    it('swallows every delivery failure and still reaches the other receivers', async () => {
        browserMocks.tabsSendMessage
            .mockRejectedValueOnce(new Error('Receiving end does not exist.'))
            .mockResolvedValueOnce(undefined);
        browserMocks.runtimeSendMessage.mockRejectedValue(new Error('no popup'));

        await expect(DebugLogBroadcast.notifyStateChanged(false)).resolves.toBeUndefined();

        expect(browserMocks.tabsSendMessage).toHaveBeenCalledTimes(2);
        expect(browserMocks.runtimeSendMessage).toHaveBeenCalledTimes(1);
    });

    it('still notifies extension pages when the tab query fails', async () => {
        browserMocks.tabsQuery.mockRejectedValue(new Error('tabs unavailable'));

        await expect(DebugLogBroadcast.notifyStateChanged(true)).resolves.toBeUndefined();

        expect(browserMocks.tabsSendMessage).not.toHaveBeenCalled();
        expect(browserMocks.runtimeSendMessage).toHaveBeenCalledTimes(1);
    });
});
