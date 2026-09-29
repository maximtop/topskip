import {

    describe,
    expect,
    it,
    vi,
} from 'vitest';

import { logTranscriptForDeveloper } from '@/background/captions/log-transcript-dev';

describe('logTranscriptForDeveloper', () => {
    it('emits only safe capture metadata when developer logging is enabled', () => {
        const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
        const segments = [
            { startSec: 2, durationSec: 1, text: 'private caption text' },
            { startSec: 5, durationSec: 2, text: 'another private caption' },
        ];

        logTranscriptForDeveloper('dQw4w9WgXcQ', 'en', segments, false);
        expect(debug).not.toHaveBeenCalled();

        expect(
            logTranscriptForDeveloper('dQw4w9WgXcQ', 'en', segments, true),
        ).toBeUndefined();
        expect(debug).toHaveBeenCalledOnce();
        expect(debug).toHaveBeenCalledWith('[TopSkip captions]', {
            videoId: 'dQw4w9WgXcQ',
            languageCode: 'en',
            segmentCount: 2,
            firstStartSec: 2,
            lastEndSec: 7,
        });
        expect(JSON.stringify(debug.mock.calls)).not.toContain(
            'private caption',
        );
        debug.mockRestore();
    });
});
