import { describe, expect, it } from 'vitest';

import { TranscriptFingerprint } from '@topskip/backend/transcript-fingerprint';
import { CaptionTranscriptCanonicalizer } from '@topskip/common/captions/canonical-transcript';

describe('TranscriptFingerprint', () => {
    it('hashes the shared golden canonical bytes with SHA-256', () => {
        const canonical = CaptionTranscriptCanonicalizer.canonicalize({
            languageCode: ' EN-us ',
            segments: [
                {
                    startSec: -0,
                    durationSec: 1,
                    text: ' e\u0301\r\n test ',
                },
                {
                    startSec: 1.25,
                    durationSec: -0,
                    text: '-0 stays text',
                },
            ],
        });

        expect(canonical.ok).toBe(true);
        if (!canonical.ok) {
            return;
        }

        expect(
            TranscriptFingerprint.sha256Hex(
                canonical.transcript.canonicalBytes,
            ),
        ).toBe(
            '1afb6e4ec112941d35fbb2f6b7009e3d5433c89a4546bada9834f392a20bead0',
        );
    });
});
