import { describe, expect, it } from 'vitest';

import {
    CAPTION_CAPTURE_VERBOSE_LOGS,
    CAPTION_TRANSCRIPT_DEV_ENABLED,
} from '@/shared/constants';

describe('caption capture build gates', () => {
    it('keeps capture enabled while release-like tests omit verbose logs', () => {
        expect(CAPTION_TRANSCRIPT_DEV_ENABLED).toBe(true);
        expect(CAPTION_CAPTURE_VERBOSE_LOGS).toBe(false);
    });
});
