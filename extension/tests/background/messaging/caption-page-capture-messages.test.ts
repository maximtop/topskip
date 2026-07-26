import { beforeEach, describe, expect, it, vi } from 'vitest';

const { executeScript } = vi.hoisted(() => ({
    executeScript: vi.fn<(details: unknown) => Promise<unknown[]>>(),
}));

vi.mock('@/shared/browser', () => ({
    default: {
        scripting: {
            executeScript,
        },
    },
}));

import { CaptionPageCaptureMessages } from '@/background/messaging/caption-page-capture-messages';

describe('CaptionPageCaptureMessages', () => {
    beforeEach(() => {
        executeScript.mockReset();
        executeScript.mockResolvedValue([]);
    });

    it('returns an error without tab id', async () => {
        await expect(
            CaptionPageCaptureMessages.install(undefined),
        ).resolves.toEqual({
            ok: false,
            error: 'No tab id',
        });
    });

    it('injects the canonical page bridge file into frame 0 main world', async () => {
        await expect(CaptionPageCaptureMessages.install(123)).resolves.toEqual({
            ok: true,
        });
        const call: unknown = executeScript.mock.calls[0]?.[0];
        expect(call).toEqual(
            expect.objectContaining({
                target: { tabId: 123, frameIds: [0] },
                world: 'MAIN',
                files: ['caption-page-bridge.js'],
            }),
        );
    });

    it('uses the built bridge file instead of duplicated injected source', async () => {
        await CaptionPageCaptureMessages.install(123);
        const call: unknown = executeScript.mock.calls[0]?.[0];
        expect(call).toBeTypeOf('object');
        const func: unknown =
            call !== null && typeof call === 'object'
                ? Reflect.get(call, 'func')
                : undefined;
        const files: unknown =
            call !== null && typeof call === 'object'
                ? Reflect.get(call, 'files')
                : undefined;
        expect(func).toBeUndefined();
        expect(files).toEqual(['caption-page-bridge.js']);
    });

    it('does not expose obsolete timedtext fetch message names', async () => {
        const messages = await import('@/shared/messages');
        const obsoleteFetchMessage = ['FETCH', 'TIMEDTEXT', 'PAGE'].join('_');
        expect(
            Reflect.get(messages.TOPSKIP_MESSAGE, obsoleteFetchMessage),
        ).toBeUndefined();
        expect(
            Reflect.get(
                messages.TOPSKIP_MESSAGE,
                'INSTALL_CAPTION_NETWORK_DEBUG',
            ),
        ).toBeUndefined();
    });
});
