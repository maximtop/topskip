import { describe, expect, it } from 'vitest';

import {
    TopSkipBuild,
    getServerAnalysisBaseUrl,
    getServerAnalysisManifestMatch,
} from '../build-modes';

describe('TopSkip server build routing', () => {
    it('uses loopback only for the development build', () => {
        expect(getServerAnalysisBaseUrl(TopSkipBuild.Dev)).toBe(
            'http://127.0.0.1:8787',
        );
        expect(getServerAnalysisManifestMatch(TopSkipBuild.Dev)).toBe(
            'http://127.0.0.1:8787/*',
        );
    });

    it.each([TopSkipBuild.Beta, TopSkipBuild.Release])(
        'uses the public backend for the %s build',
        (build) => {
            expect(getServerAnalysisBaseUrl(build)).toBe(
                'https://topskip.maximtop.dev',
            );
            expect(getServerAnalysisManifestMatch(build)).toBe(
                'https://topskip.maximtop.dev/*',
            );
        },
    );
});
