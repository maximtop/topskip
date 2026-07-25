import { describe, expect, it } from 'vitest';

import {
    TopSkipBuild,
    getExtensionManifestName,
    getServerAnalysisBaseUrl,
    getServerAnalysisManifestMatch,
    shouldEnableCaptionCaptureVerboseLogs,
} from '../build-modes';

describe('TopSkip server build routing', () => {
    it.each([
        [TopSkipBuild.Dev, 'TopSkip (Dev)'],
        [TopSkipBuild.Beta, 'TopSkip (Beta)'],
        [TopSkipBuild.Release, '__MSG_name__'],
    ])('uses the expected manifest name for %s', (build, name) => {
        expect(getExtensionManifestName(build)).toBe(name);
    });

    it.each([TopSkipBuild.Dev, TopSkipBuild.Beta, TopSkipBuild.Release])(
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

    it('enables verbose caption diagnostics only for development', () => {
        expect(shouldEnableCaptionCaptureVerboseLogs(TopSkipBuild.Dev)).toBe(
            true,
        );
        expect(shouldEnableCaptionCaptureVerboseLogs(TopSkipBuild.Beta)).toBe(
            false,
        );
        expect(
            shouldEnableCaptionCaptureVerboseLogs(TopSkipBuild.Release),
        ).toBe(false);
    });
});
