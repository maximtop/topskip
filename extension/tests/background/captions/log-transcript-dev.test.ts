import { describe, expect, it, vi } from 'vitest';

import { logTranscriptForDeveloper } from '@/background/captions/log-transcript-dev';

describe('logTranscriptForDeveloper', () => {
    it('emits caption text only when developer logging is enabled', () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const segments = [
            { startSec: 0, durationSec: 1, text: 'private caption text' },
        ];

        expect(
            logTranscriptForDeveloper('dQw4w9WgXcQ', 'en', segments, false),
        ).toBe('');
        expect(info).not.toHaveBeenCalled();

        expect(
            logTranscriptForDeveloper('dQw4w9WgXcQ', 'en', segments, true),
        ).toBe('private caption text');
        expect(info).toHaveBeenCalled();
        info.mockRestore();
    });
});
