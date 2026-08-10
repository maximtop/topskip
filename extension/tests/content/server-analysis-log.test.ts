import { afterEach, describe, expect, it, vi } from 'vitest';

const contentLogMocks = vi.hoisted(() => ({
    info: vi.fn(),
    warn: vi.fn(),
}));

vi.mock('@/content/content-log', () => ({
    contentLog: contentLogMocks,
}));

import { ContentServerAnalysisLog } from '@/content/server-analysis-log';

describe('ContentServerAnalysisLog', () => {
    afterEach(() => {
        vi.clearAllMocks();
        vi.restoreAllMocks();
    });

    it('forwards enabled stages through the content log channel', () => {
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
