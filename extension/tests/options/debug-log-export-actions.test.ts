import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { OPTIONS_DOWNLOAD_URL_REVOKE_DELAY_MS } from '@/options/constants';
import {
    DebugLogExportActions,
    type DownloadAnchor,
    type DownloadHost,
} from '@/options/debug-log-export-actions';
import { MIME_TEXT_PLAIN_UTF8 } from '@/shared/constants';

const BUNDLE_TEXT = '# TopSkip debug log\nline 1\n';
const FILE_NAME = 'topskip-debug-log-20260822T101500Z.txt';
const OBJECT_URL = 'blob:chrome-extension://topskip/fake';

/**
 * Records the anchor the download touched without a DOM.
 *
 * @returns Fake host plus the anchor it hands out.
 */
function makeHost(): { host: DownloadHost; anchor: DownloadAnchor & { clicks: number } } {
    const anchor = {
        href: '',
        download: '',
        rel: '',
        clicks: 0,
        click(): void {
            this.clicks += 1;
        },
    };
    return { host: { createElement: () => anchor }, anchor };
}

describe('DebugLogExportActions.copy', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('resolves true when the clipboard accepts the text', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        vi.stubGlobal('navigator', { clipboard: { writeText } });

        await expect(DebugLogExportActions.copy(BUNDLE_TEXT)).resolves.toBe(true);
        expect(writeText).toHaveBeenCalledWith(BUNDLE_TEXT);
    });

    it('resolves false when the write is refused, without logging', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.stubGlobal('navigator', {
            clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
        });

        await expect(DebugLogExportActions.copy(BUNDLE_TEXT)).resolves.toBe(false);
        expect(errorSpy).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('resolves false when the clipboard API is missing', async () => {
        vi.stubGlobal('navigator', {});

        await expect(DebugLogExportActions.copy(BUNDLE_TEXT)).resolves.toBe(false);
    });
});

describe('DebugLogExportActions.download', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('offers a UTF-8 text blob through a transient anchor and revokes the URL later', async () => {
        const createObjectURL = vi
            .spyOn(URL, 'createObjectURL')
            .mockReturnValue(OBJECT_URL);
        const revokeObjectURL = vi
            .spyOn(URL, 'revokeObjectURL')
            .mockImplementation(() => undefined);
        const { host, anchor } = makeHost();

        DebugLogExportActions.download(BUNDLE_TEXT, FILE_NAME, host);

        expect(createObjectURL).toHaveBeenCalledTimes(1);
        const blob: unknown = createObjectURL.mock.calls[0]?.[0];
        if (!(blob instanceof Blob)) {
            throw new Error('expected createObjectURL to receive a Blob');
        }
        expect(blob.type).toBe(MIME_TEXT_PLAIN_UTF8);
        await expect(blob.text()).resolves.toBe(BUNDLE_TEXT);
        expect(anchor.href).toBe(OBJECT_URL);
        expect(anchor.download).toBe(FILE_NAME);
        expect(anchor.rel).toBe('noopener');
        expect(anchor.clicks).toBe(1);

        expect(revokeObjectURL).not.toHaveBeenCalled();
        vi.advanceTimersByTime(OPTIONS_DOWNLOAD_URL_REVOKE_DELAY_MS - 1);
        expect(revokeObjectURL).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(revokeObjectURL).toHaveBeenCalledWith(OBJECT_URL);
    });
});
