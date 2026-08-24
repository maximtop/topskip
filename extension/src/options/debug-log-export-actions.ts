import { OPTIONS_DOWNLOAD_URL_REVOKE_DELAY_MS } from '@/options/constants';
import { MIME_TEXT_PLAIN_UTF8 } from '@/shared/constants';

const DOWNLOAD_ANCHOR_TAG = 'a';
const DOWNLOAD_ANCHOR_REL = 'noopener';

/**
 * The anchor surface a download needs; `HTMLAnchorElement` satisfies it and
 * tests supply a fake because Vitest runs without a DOM.
 */
export type DownloadAnchor = {
    href: string;
    download: string;
    rel: string;
    click(): void;
};

/**
 * Document surface for creating the transient anchor (`document` in the
 * page; a fake in tests).
 */
export type DownloadHost = {
    createElement(tagName: typeof DOWNLOAD_ANCHOR_TAG): DownloadAnchor;
};

/**
 * Clipboard and in-page file export for the debug log bundle; static API
 * only. Uses page facilities alone (no `downloads` or `clipboardWrite`
 * permission) and never logs, so a refused write surfaces solely as the
 * returned outcome.
 */
export class DebugLogExportActions {
    /**
     * Resolves `false` instead of throwing when the browser refuses the write
     * (no focus, no activation, missing API) so the caller can point at
     * Download log.
     *
     * @param text - Bundle text to place on the clipboard.
     * @returns Whether the clipboard accepted the text.
     */
    static copy(text: string): Promise<boolean> {
        try {
            return navigator.clipboard.writeText(text).then(
                () => true,
                () => false,
            );
        } catch {
            return Promise.resolve(false);
        }
    }

    /**
     * Offers the bundle as a `.txt` through a transient object URL; the URL is
     * revoked later so the browser has time to start the download.
     *
     * @param text - Bundle text.
     * @param fileName - File name carrying the snapshot instant.
     * @param host - Anchor factory; defaults to the page document.
     */
    static download(
        text: string,
        fileName: string,
        host: DownloadHost = document,
    ): void {
        const blob = new Blob([text], { type: MIME_TEXT_PLAIN_UTF8 });
        const url = URL.createObjectURL(blob);
        const anchor = host.createElement(DOWNLOAD_ANCHOR_TAG);
        anchor.href = url;
        anchor.download = fileName;
        anchor.rel = DOWNLOAD_ANCHOR_REL;
        anchor.click();
        globalThis.setTimeout(() => {
            URL.revokeObjectURL(url);
        }, OPTIONS_DOWNLOAD_URL_REVOKE_DELAY_MS);
    }
}
