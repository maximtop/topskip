import { describe, expect, it } from 'vitest';

import {
    E2E_HOST,
    getWatchVideoIdFromSearch,
    shouldActivateTopSkip,
} from '@/content/page-guards';

/**
 * The vitest build defines the fixture origin the way a dev bundle does, so
 * the host must be present here even though release bundles carry `null`.
 *
 * @returns Local fixture hostname compiled into this test build.
 */
function fixtureHost(): string {
    if (E2E_HOST === null) {
        throw new Error('Expected the dev fixture host in unit tests.');
    }
    return E2E_HOST;
}

describe('getWatchVideoIdFromSearch', () => {
    it('returns a valid synthetic id for e2e host', () => {
        expect(getWatchVideoIdFromSearch(fixtureHost(), '')).toBe(
            'e2eFixture1',
        );
    });

    it('returns v param on YouTube watch', () => {
        expect(
            getWatchVideoIdFromSearch('www.youtube.com', '?v=abc123&list=foo'),
        ).toBe('abc123');
    });

    it('rejects a YouTube lookalike host', () => {
        expect(
            getWatchVideoIdFromSearch(
                'www.youtube.com.example',
                '?v=abc123',
            ),
        ).toBeNull();
    });
});

describe('shouldActivateTopSkip', () => {
    it('activates on e2e host regardless of path', () => {
        expect(
            shouldActivateTopSkip({
                hostname: fixtureHost(),
                pathname: '/video.html',
                search: '',
            }),
        ).toBe(true);
    });

    it('rejects Shorts', () => {
        expect(
            shouldActivateTopSkip({
                hostname: 'www.youtube.com',
                pathname: '/shorts/abc',
                search: '',
            }),
        ).toBe(false);
    });

    it('requires /watch and v= on YouTube', () => {
        expect(
            shouldActivateTopSkip({
                hostname: 'www.youtube.com',
                pathname: '/watch',
                search: '?v=xyz',
            }),
        ).toBe(true);
        expect(
            shouldActivateTopSkip({
                hostname: 'www.youtube.com',
                pathname: '/watch',
                search: '',
            }),
        ).toBe(false);
        expect(
            shouldActivateTopSkip({
                hostname: 'www.youtube.com',
                pathname: '/feed',
                search: '',
            }),
        ).toBe(false);
    });

    it('treats different v= as different video (SPA navigation)', () => {
        const a = getWatchVideoIdFromSearch('www.youtube.com', '?v=videoA');
        const b = getWatchVideoIdFromSearch('www.youtube.com', '?v=videoB');
        expect(a).not.toBe(b);
        expect(a).toBe('videoA');
        expect(b).toBe('videoB');
    });
});
