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

    it('prints supplied fields inline as key=value pairs when dev logging is enabled', () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});

        BackgroundServerAnalysisLog.info(
            'http-start',
            { videoId: 'dQw4w9WgXcQ', tabId: 42, jobId: undefined },
            true,
        );

        expect(info).toHaveBeenCalledWith(
            '[TopSkip server-analysis]',
            'http-start',
            'videoId=dQw4w9WgXcQ tabId=42',
        );
    });

    it('omits the fields argument when a stage has nothing to add', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        BackgroundServerAnalysisLog.warn('config-missing', {}, true);

        expect(warn).toHaveBeenCalledWith(
            '[TopSkip server-analysis]',
            'config-missing',
        );
    });
});
