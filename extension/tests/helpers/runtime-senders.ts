import type { Runtime } from 'webextension-polyfill';

import { TOP_FRAME_ID } from '@/shared/constants';

/**
 * Stable 32-character extension id used by every sender-trust test; tests
 * that mock `@/shared/browser` must return the same value from `runtime.id`.
 */
export const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

/**
 * Origin of this extension's own pages.
 */
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;

/**
 * Another installed extension.
 */
const FOREIGN_EXTENSION_ID = 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz';

/**
 * Content-sender options.
 */
export type ContentSenderOptions = {
    tabId: number;
    videoId?: string;
    incognito?: boolean;
    frameId?: number;
};

/**
 * Minimal `Tabs.Tab` for a sender; only the fields the background reads.
 *
 * @param tabId - Tab id.
 * @param incognito - Incognito flag.
 * @returns Tab object.
 */
function makeTab(tabId: number, incognito: boolean): Runtime.MessageSender['tab'] {
    return {
        id: tabId,
        incognito,
        index: 0,
        highlighted: false,
        active: true,
        pinned: false,
        windowId: 1,
    };
}

/**
 * Sender of the ISOLATED content script on a YouTube watch page (top frame).
 *
 * @param options - Tab id, optional video id / incognito flag / frame id.
 * @returns Sender as Chrome would populate it.
 */
export function makeContentSender(options: ContentSenderOptions): Runtime.MessageSender {
    const videoId = options.videoId ?? 'dQw4w9WgXcQ';
    return {
        id: EXTENSION_ID,
        tab: makeTab(options.tabId, options.incognito ?? false),
        frameId: options.frameId ?? TOP_FRAME_ID,
        url: `https://www.youtube.com/watch?v=${videoId}`,
        origin: 'https://www.youtube.com',
    } as Runtime.MessageSender;
}

/**
 * Sender of the Options page, which always lives in a tab.
 *
 * @param options - Tab id hosting the Options page.
 * @returns Sender as Chrome would populate it.
 */
export function makeOptionsSender(options: { tabId: number }): Runtime.MessageSender {
    return {
        id: EXTENSION_ID,
        tab: makeTab(options.tabId, false),
        frameId: TOP_FRAME_ID,
        url: `${EXTENSION_ORIGIN}/options.html`,
        origin: EXTENSION_ORIGIN,
    } as Runtime.MessageSender;
}

/**
 * Sender of the toolbar popup (no tab).
 *
 * @returns Sender as Chrome would populate it.
 */
export function makePopupSender(): Runtime.MessageSender {
    return {
        id: EXTENSION_ID,
        url: `${EXTENSION_ORIGIN}/popup.html`,
        origin: EXTENSION_ORIGIN,
    } as Runtime.MessageSender;
}

/**
 * Sender of a different extension's page.
 *
 * @returns Sender as Chrome would populate it.
 */
export function makeForeignExtensionSender(): Runtime.MessageSender {
    return {
        id: FOREIGN_EXTENSION_ID,
        url: `chrome-extension://${FOREIGN_EXTENSION_ID}/options.html`,
        origin: `chrome-extension://${FOREIGN_EXTENSION_ID}`,
    } as Runtime.MessageSender;
}

/**
 * Sender of an arbitrary web page (externally connectable origin).
 *
 * @returns Sender as Chrome would populate it.
 */
export function makeWebPageSender(): Runtime.MessageSender {
    return {
        tab: makeTab(99, false),
        frameId: TOP_FRAME_ID,
        url: 'https://example.com/page',
        origin: 'https://example.com',
    } as Runtime.MessageSender;
}
