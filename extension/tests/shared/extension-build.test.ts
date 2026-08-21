import { describe, expect, it, vi } from 'vitest';

const browserMocks = vi.hoisted(() => ({
    getManifest: vi.fn<() => { version: string; version_name?: string }>(),
}));

vi.mock('@/shared/browser', () => ({
    default: { runtime: { getManifest: browserMocks.getManifest } },
}));

import { getExtensionBuildLabel } from '@/shared/extension-build';

describe('getExtensionBuildLabel', () => {
    it('prefers the stamped display version of dev and beta builds', () => {
        browserMocks.getManifest.mockReturnValue({
            version: '0.1.0',
            version_name: '0.1.0 (dev build 2026-08-21T20:40:00Z)',
        });

        expect(getExtensionBuildLabel()).toBe(
            '0.1.0 (dev build 2026-08-21T20:40:00Z)',
        );
    });

    it('falls back to the bare version when no stamp is present', () => {
        browserMocks.getManifest.mockReturnValue({ version: '0.1.0' });

        expect(getExtensionBuildLabel()).toBe('0.1.0');
    });
});
