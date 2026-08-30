import type { Runtime } from 'webextension-polyfill/namespaces/runtime';

import browser from '@/shared/browser';
import { TOP_FRAME_ID } from '@/shared/constants';
import { isTopSkipContentDocumentUrl } from '@/shared/watch-route';

/**
 * Decides who may control, read or feed the debug log from browser-provided
 * sender metadata; trust never depends on whether a tab is present, because
 * the Options page always lives in a tab and the popup never does. Static API
 * only.
 */
export class RuntimeSenderTrust {
    /**
     * Accepts only documents served from this extension's own origin (popup,
     * Options page) and sent by this extension id.
     *
     * @param sender - Browser-provided sender metadata.
     * @returns Whether control/read commands may be honoured.
     */
    static isExtensionPage(sender: Runtime.MessageSender): boolean {
        if (sender.id !== browser.runtime.id) {
            return false;
        }
        // `getURL('')` is `chrome-extension://<id>/`; the trailing slash keeps
        // a look-alike id with a longer prefix from matching.
        const base = browser.runtime.getURL('');
        if (sender.url !== undefined) {
            return sender.url.startsWith(base);
        }
        // Compared as text: `new URL(...).origin` is `null` for the
        // non-special `chrome-extension:` scheme outside Chrome.
        const origin = RuntimeSenderTrust.readOrigin(sender);
        return origin !== undefined && `${origin}/` === base;
    }

    /**
     * Accepts only a top-frame document on a declarative content origin sent
     * by this extension id; extension pages fail this check by origin.
     *
     * @param sender - Browser-provided sender metadata.
     * @returns Trusted tab id, or `null` when appends must be refused.
     */
    static contentTabId(sender: Runtime.MessageSender): number | null {
        const tabId = sender.tab?.id;
        if (
            sender.id !== browser.runtime.id ||
            tabId === undefined ||
            sender.frameId !== TOP_FRAME_ID ||
            sender.url === undefined ||
            !isTopSkipContentDocumentUrl(sender.url)
        ) {
            return null;
        }
        return tabId;
    }

    /**
     * `origin` is populated by Chrome but absent from the polyfill typings.
     *
     * @param sender - Browser-provided sender metadata.
     * @returns Document origin, or `undefined`.
     */
    private static readOrigin(sender: Runtime.MessageSender): string | undefined {
        const origin: unknown = Reflect.get(sender, 'origin');
        return typeof origin === 'string' ? origin : undefined;
    }
}
