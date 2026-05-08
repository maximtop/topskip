import { describe, expect, it } from 'vitest';

import {
    E2E_HOST,
    getWatchVideoIdFromSearch,
    shouldActivateTopSkip,
} from '@/content/page-guards';

describe('getWatchVideoIdFromSearch', () => {
    it('returns synthetic id for e2e host', () => {
        expect(getWatchVideoIdFromSearch(E2E_HOST, '')).toBe('e2e-fixture');
    });

    it('returns v param on YouTube watch', () => {
        expect(
            getWatchVideoIdFromSearch('www.youtube.com', '?v=abc123&list=foo'),
        ).toBe('abc123');
    });
});

describe('shouldActivateTopSkip', () => {
    it('activates on e2e host regardless of path', () => {
        expect(
            shouldActivateTopSkip({
                hostname: E2E_HOST,
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
