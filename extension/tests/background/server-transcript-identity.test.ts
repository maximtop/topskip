import { describe, expect, it } from 'vitest';

import { ServerTranscriptIdentity } from '@/background/server-transcript-identity';
import { CaptionTranscriptCanonicalizer } from '@topskip/common/captions/canonical-transcript';

describe('ServerTranscriptIdentity', () => {
    it('hashes the shared golden canonical bytes with WebCrypto', async () => {
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

        await expect(
            ServerTranscriptIdentity.sha256Hex(
                canonical.transcript.canonicalBytes,
            ),
        ).resolves.toBe(
            '1afb6e4ec112941d35fbb2f6b7009e3d5433c89a4546bada9834f392a20bead0',
        );
    });
});
