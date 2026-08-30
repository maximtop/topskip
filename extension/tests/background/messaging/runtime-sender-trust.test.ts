import { describe, expect, it, vi } from 'vitest';

const extensionId = await vi.hoisted(async () => {
    const { EXTENSION_ID } = await import('../../helpers/runtime-senders');
    return EXTENSION_ID;
});

vi.mock('@/shared/browser', () => ({
    default: {
        runtime: {
            id: extensionId,
            getURL: (path: string) => `chrome-extension://${extensionId}/${path}`,
        },
    },
}));

import { RuntimeSenderTrust } from '@/background/messaging/runtime-sender-trust';
import {
    EXTENSION_ID,
    makeContentSender,
    makeForeignExtensionSender,
    makeOptionsSender,
    makePopupSender,
    makeWebPageSender,
} from '../../helpers/runtime-senders';

const VIDEO_ID = 'dQw4w9WgXcQ';

describe('RuntimeSenderTrust.isExtensionPage', () => {
    it('accepts the popup and the Options page in its tab', () => {
        expect(RuntimeSenderTrust.isExtensionPage(makePopupSender())).toBe(true);
        expect(RuntimeSenderTrust.isExtensionPage(makeOptionsSender({ tabId: 7 }))).toBe(true);
    });

    it('accepts an origin-only sender from this extension', () => {
        const sender = {
            id: EXTENSION_ID,
            origin: `chrome-extension://${EXTENSION_ID}`,
        } as never;
        expect(RuntimeSenderTrust.isExtensionPage(sender)).toBe(true);
    });

    it.each([
        ['YouTube content script', makeContentSender({ tabId: 41, videoId: VIDEO_ID })],
        ['web page', makeWebPageSender()],
        ['foreign extension', makeForeignExtensionSender()],
        ['look-alike id with a longer prefix', {
            id: EXTENSION_ID,
            url: `chrome-extension://${EXTENSION_ID}xyz/options.html`,
        }],
        ['missing url and origin', { id: EXTENSION_ID }],
    ])('refuses a %s', (_name, sender) => {
        expect(RuntimeSenderTrust.isExtensionPage(sender)).toBe(false);
    });
});

describe('RuntimeSenderTrust.contentTabId', () => {
    it('returns the tab id for a top-frame declarative content document', () => {
        expect(
            RuntimeSenderTrust.contentTabId(makeContentSender({ tabId: 41, videoId: VIDEO_ID })),
        ).toBe(41);
    });

    it.each([
        ['popup', makePopupSender()],
        ['Options page', makeOptionsSender({ tabId: 7 })],
        ['child frame', makeContentSender({ tabId: 41, videoId: VIDEO_ID, frameId: 1 })],
        ['look-alike host', {
            id: EXTENSION_ID,
            tab: { id: 41 },
            frameId: 0,
            url: 'https://www.youtube.com.example/watch?v=dQw4w9WgXcQ',
        } as never],
        ['foreign extension', makeForeignExtensionSender()],
        ['missing tab', { id: EXTENSION_ID, frameId: 0, url: 'https://www.youtube.com/' }],
    ])('refuses a %s', (_name, sender) => {
        expect(RuntimeSenderTrust.contentTabId(sender)).toBeNull();
    });
});
