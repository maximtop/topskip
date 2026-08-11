import { afterEach, describe, expect, it, vi } from 'vitest';

import { BackgroundServerAnalysisLog } from '@/background/server-analysis-log';

describe('BackgroundServerAnalysisLog', () => {
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
});
