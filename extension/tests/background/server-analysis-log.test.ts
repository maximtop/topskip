import {

    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

import { BackgroundServerAnalysisLog } from '@/background/server-analysis-log';

describe('BackgroundServerAnalysisLog', () => {
    afterEach(() => {
        vi.clearAllMocks();
        vi.restoreAllMocks();
    });

    it('stays silent by default in the test/release build gate', () => {
        const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

        BackgroundServerAnalysisLog.info('http-start', {
            videoId: 'dQw4w9WgXcQ',
        });

        expect(debug).not.toHaveBeenCalled();
    });

    it('prints supplied fields inline as key=value pairs when dev logging is enabled', () => {
        const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});

        BackgroundServerAnalysisLog.info(
            'http-start',
            { videoId: 'dQw4w9WgXcQ', tabId: 42, jobId: undefined },
            true,
        );

        expect(debug).toHaveBeenCalledWith(
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
