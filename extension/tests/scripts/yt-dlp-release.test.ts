import { describe, expect, it } from 'vitest';

import {
    selectYtDlpReleaseAsset,
    verifyYtDlpAssetChecksum,
} from '../../../scripts/lib/yt-dlp-release';

describe('yt-dlp pinned release', () => {
    it('selects official standalone assets for supported environments', () => {
        expect(selectYtDlpReleaseAsset('darwin', 'arm64').assetName).toBe(
            'yt-dlp_macos',
        );
        expect(selectYtDlpReleaseAsset('darwin', 'x64').assetName).toBe(
            'yt-dlp_macos',
        );
        expect(selectYtDlpReleaseAsset('linux', 'x64').assetName).toBe(
            'yt-dlp_linux',
        );
    });

    it('rejects unsupported platforms and checksum mismatches', () => {
        expect(() => selectYtDlpReleaseAsset('linux', 'arm64')).toThrow(
            /TOPSKIP_YT_DLP_PATH/u,
        );
        const asset = selectYtDlpReleaseAsset('darwin', 'arm64');
        expect(
            verifyYtDlpAssetChecksum(new Uint8Array([1, 2, 3]), asset.sha256),
        ).toBe(false);
    });
});
