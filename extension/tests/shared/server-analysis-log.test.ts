import { afterEach, describe, expect, it, vi } from 'vitest';

const contentLogMocks = vi.hoisted(() => ({
    info: vi.fn(),
    warn: vi.fn(),
}));

vi.mock('@/content/content-log', () => ({
    contentLog: contentLogMocks,
}));

import { BackgroundServerAnalysisLog } from '@/background/server-analysis-log';
import { ContentServerAnalysisLog } from '@/content/server-analysis-log';

describe('server analysis dev logging', () => {
    afterEach(() => {
        vi.clearAllMocks();
        vi.restoreAllMocks();
    });

    it('stays silent by default in the test/release build gate', () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});

        BackgroundServerAnalysisLog.info('http-start', {
            videoId: 'dQw4w9WgXcQ',
        });

        expect(info).not.toHaveBeenCalled();
    });

    it('prints only explicitly supplied scalar fields when dev logging is enabled', () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});

        BackgroundServerAnalysisLog.info(
            'http-start',
            { videoId: 'dQw4w9WgXcQ', tabId: 42 },
            true,
        );

        expect(info).toHaveBeenCalledWith(
            '[TopSkip server-analysis]',
            'http-start',
            { videoId: 'dQw4w9WgXcQ', tabId: 42 },
        );
    });

    it('forwards enabled content stages through the background log channel', () => {
        ContentServerAnalysisLog.info(
            'runtime-request-sent',
            { videoId: 'dQw4w9WgXcQ' },
            true,
        );

        expect(contentLogMocks.info).toHaveBeenCalledWith(
            '[TopSkip server-analysis]',
            'runtime-request-sent',
            { videoId: 'dQw4w9WgXcQ' },
        );
    });
});
